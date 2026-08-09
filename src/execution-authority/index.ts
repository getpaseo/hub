import type { CompiledGitHubAuthority } from "../config/github-authority.js";
import {
  parseConnectionTemplate,
  resolveConnectionTemplate,
} from "../config/connection-template.js";
import type { ConnectionResolver } from "../config/connections.js";
import type { GitHubAuthorityRegistration } from "../providers/registration.js";
import { logger } from "../logger.js";

const TOKEN_REVOCATION_TIMEOUT_MS = 10_000;
const REVOCATION_RETRY_BASE_DELAY_MS = 1_000;
const REVOCATION_RETRY_WINDOW_MS = 60 * 60 * 1_000;

export interface ExecutionAuthorityClock {
  now(): number;
  schedule(callback: () => Promise<void>, delayMs: number, options?: { ref?: boolean }): () => void;
}

const systemClock: ExecutionAuthorityClock = {
  now: Date.now,
  schedule(callback, delayMs, options) {
    const timer = setTimeout(() => void callback(), delayMs);
    if (options?.ref !== true) timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface ExecutionAuthorityMaterialization {
  executionId: string;
  projectId: string;
  triggerContext: unknown;
  env?: Readonly<Record<string, string>> | undefined;
  github?: CompiledGitHubAuthority | undefined;
}

export interface MaterializedExecutionAuthority {
  env: Record<string, string>;
}

export interface ExecutionAuthority {
  materialize(input: ExecutionAuthorityMaterialization): Promise<MaterializedExecutionAuthority>;
  onExecutionTerminal(executionId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateExecutionAuthorityOptions {
  connectionsForProject: (projectId: string) => ConnectionResolver;
  githubAuthority?: GitHubAuthorityRegistration | undefined;
  clock?: ExecutionAuthorityClock | undefined;
  isExecutionActive?: ((executionId: string) => Promise<boolean>) | undefined;
}

interface TokenLease {
  token: string;
  revoke: () => Promise<void>;
  cancelLeaseDeadline: () => void;
  cancelUpstreamExpiry: () => void;
  cancelRetry: () => void;
  upstreamExpiresAt?: number;
  retryUntil?: number;
  revocationAttempts: number;
  revocationPromise?: Promise<void>;
}

interface ExecutionState {
  pendingMints: number;
  terminal: boolean;
  leases: Map<string, TokenLease>;
  pendingWaiters: Set<() => void>;
  leaseWaiters: Set<() => void>;
}

export function createExecutionAuthority(
  options: CreateExecutionAuthorityOptions,
): ExecutionAuthority {
  const clock = options.clock ?? systemClock;
  const states = new Map<string, ExecutionState>();
  const isExecutionActive = options.isExecutionActive ?? (() => Promise.resolve(true));
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  async function materialize(
    input: ExecutionAuthorityMaterialization,
  ): Promise<MaterializedExecutionAuthority> {
    if (stopped) throw authorityStoppedError();
    const state = getOrCreateState(input.executionId);
    await assertExecutionActive(state, input.executionId);
    state.pendingMints += 1;
    const ownedTokens = new Set<string>();
    try {
      const tokenRevocations = new Map<string, Promise<string> | undefined>();
      const context = {
        executionId: input.executionId,
        registerToken: async (token: string, revoke?: () => Promise<void> | void) => {
          if (revoke === undefined) return;
          await registerLease(state, input.executionId, token, revoke);
          ownedTokens.add(token);
        },
      };
      const env = await materializeEnvironment(input, context, tokenRevocations);
      if (input.github !== undefined) {
        if (options.githubAuthority === undefined) {
          throw new Error("GitHub step authority is unavailable");
        }
        const repositories = repositoriesForAuthority(input.github, input.triggerContext);
        const authority = await options.githubAuthority.mint({
          projectId: input.projectId,
          connectionSlug: input.github.connection,
          repositories,
          permissions: input.github.permissions,
        });
        await registerLease(
          state,
          input.executionId,
          authority.token,
          () => options.githubAuthority!.revoke(authority.token),
          input.github.durationMs,
          authority.expiresAt,
        );
        ownedTokens.add(authority.token);
        await assertExecutionActive(state, input.executionId);
        return {
          env: {
            ...env,
            ...githubEnvironment(authority.botUserId, authority.botLogin, authority.token),
          },
        };
      }
      await assertExecutionActive(state, input.executionId);
      return { env };
    } catch (error) {
      await Promise.all(
        [...ownedTokens].map((token) => releaseLease(input.executionId, token, "materialization")),
      );
      throw error;
    } finally {
      state.pendingMints -= 1;
      if (state.pendingMints === 0) {
        for (const resolve of state.pendingWaiters) resolve();
        state.pendingWaiters.clear();
      }
      deleteEmptyState(states, input.executionId, state);
    }
  }

  async function materializeEnvironment(
    input: ExecutionAuthorityMaterialization,
    context: {
      executionId: string;
      registerToken: (token: string, revoke?: () => Promise<void> | void) => Promise<void>;
    },
    tokenRevocations: Map<string, Promise<string> | undefined>,
  ): Promise<Record<string, string>> {
    if (input.env === undefined) return {};
    const resolver = options.connectionsForProject(input.projectId);
    return Object.fromEntries(
      await Promise.all(
        Object.entries(input.env).map(async ([key, value]) => {
          const references = parseConnectionTemplate(value, `step env.${key}`);
          const resolved = await resolveConnectionTemplate(
            value,
            (slug, namedValue, resolutionContext) => {
              const cacheKey = `${slug}:${namedValue}`;
              const cached = tokenRevocations.get(cacheKey);
              if (cached !== undefined) return cached;
              const pending = Promise.resolve(resolver(slug, namedValue, resolutionContext));
              tokenRevocations.set(cacheKey, pending);
              return pending;
            },
            context,
            `step env.${key}`,
          );
          if (references.length === 0) return [key, resolved] as const;
          return [key, resolved] as const;
        }),
      ),
    );
  }

  async function registerLease(
    state: ExecutionState,
    executionId: string,
    token: string,
    revoke: () => Promise<void> | void,
    leaseDurationMs?: number,
    upstreamExpiresAt?: number,
  ): Promise<void> {
    const now = clock.now();
    const leaseDeadline =
      leaseDurationMs === undefined
        ? undefined
        : Math.min(
            now + leaseDurationMs,
            upstreamExpiresAt === undefined ? Number.POSITIVE_INFINITY : upstreamExpiresAt,
          );
    const cancelLeaseDeadline =
      leaseDeadline === undefined
        ? () => undefined
        : clock.schedule(
            () => releaseLease(executionId, token, "lease-deadline"),
            Math.max(0, leaseDeadline - now),
          );
    const cancelUpstreamExpiry =
      upstreamExpiresAt === undefined
        ? () => undefined
        : clock.schedule(
            () => releaseLease(executionId, token, "upstream-expiry"),
            Math.max(0, upstreamExpiresAt - now),
          );
    const lease: TokenLease = {
      token,
      revoke: async () => revoke(),
      cancelLeaseDeadline,
      cancelUpstreamExpiry,
      cancelRetry: () => undefined,
      ...(upstreamExpiresAt === undefined ? {} : { upstreamExpiresAt }),
      revocationAttempts: 0,
    };
    state.leases.set(token, lease);
    if (state.terminal || stopped) {
      await requestLeaseRevocation(executionId, token, "terminal");
      throw terminalExecutionError(executionId);
    }
  }

  async function releaseLease(
    executionId: string,
    token: string,
    reason: "lease-deadline" | "upstream-expiry" | "terminal" | "materialization" | "stop",
  ): Promise<void> {
    const state = states.get(executionId);
    const lease = state?.leases.get(token);
    if (state === undefined || lease === undefined) return;
    await requestLeaseRevocation(executionId, token, reason);
  }

  async function onExecutionTerminal(executionId: string): Promise<void> {
    const state = getOrCreateState(executionId);
    state.terminal = true;
    await waitForPendingMints(state);
    await revokeLeases(executionId, state, "terminal");
  }

  function getOrCreateState(executionId: string): ExecutionState {
    const existing = states.get(executionId);
    if (existing !== undefined) return existing;
    const state: ExecutionState = {
      pendingMints: 0,
      terminal: false,
      leases: new Map(),
      pendingWaiters: new Set(),
      leaseWaiters: new Set(),
    };
    states.set(executionId, state);
    return state;
  }

  async function stop(): Promise<void> {
    if (stopPromise !== undefined) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      const activeStates = [...states.entries()];
      for (const [, state] of activeStates) state.terminal = true;
      await Promise.all(activeStates.map(([, state]) => waitForPendingMints(state)));
      await Promise.all(
        activeStates.map(async ([executionId, state]) => {
          await revokeLeases(executionId, state, "stop");
          await waitForLeasesClosed(state);
        }),
      );
    })();
    return stopPromise;
  }

  return { materialize, onExecutionTerminal, stop };

  async function requestLeaseRevocation(
    executionId: string,
    token: string,
    reason: "lease-deadline" | "upstream-expiry" | "terminal" | "materialization" | "stop",
  ): Promise<void> {
    const state = states.get(executionId);
    const lease = state?.leases.get(token);
    if (state === undefined || lease === undefined) return;
    lease.cancelLeaseDeadline();
    lease.cancelUpstreamExpiry();
    if (lease.revocationPromise !== undefined) return lease.revocationPromise;

    const attempt = async (): Promise<void> => {
      lease.revocationAttempts += 1;
      const succeeded = await revokeWithTimeout(lease.revoke, executionId, {
        reason,
        attempt: lease.revocationAttempts,
      });
      if (succeeded) {
        removeLease(states, executionId, state, lease);
        return;
      }

      const now = clock.now();
      const retryUntil =
        lease.retryUntil ??
        (lease.retryUntil = Math.min(
          lease.upstreamExpiresAt ?? Number.POSITIVE_INFINITY,
          now + REVOCATION_RETRY_WINDOW_MS,
        ));
      if (now >= retryUntil) {
        removeLease(states, executionId, state, lease);
        logger.warn(
          {
            executionId,
            reason,
            attempts: lease.revocationAttempts,
            outcome: "upstream_expired_or_retry_window_elapsed",
          },
          "execution authority token lease closed after failed revocation",
        );
        return;
      }

      const backoff = Math.min(
        REVOCATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(lease.revocationAttempts - 1, 10),
        retryUntil - now,
      );
      lease.cancelRetry();
      lease.cancelRetry = clock.schedule(
        () => requestLeaseRevocation(executionId, token, reason),
        Math.max(0, backoff),
        stopped ? { ref: true } : undefined,
      );
    };

    const pending = attempt();
    let revocationPromise!: Promise<void>;
    revocationPromise = pending.finally(() => {
      if (lease.revocationPromise === revocationPromise) delete lease.revocationPromise;
    });
    lease.revocationPromise = revocationPromise;
    return revocationPromise;
  }

  async function revokeLeases(
    executionId: string,
    state: ExecutionState,
    reason: "terminal" | "stop",
  ): Promise<void> {
    await Promise.all(
      [...state.leases.keys()].map((token) => requestLeaseRevocation(executionId, token, reason)),
    );
  }

  async function waitForPendingMints(state: ExecutionState): Promise<void> {
    if (state.pendingMints === 0) return;
    await new Promise<void>((resolve) => state.pendingWaiters.add(resolve));
  }

  async function waitForLeasesClosed(state: ExecutionState): Promise<void> {
    if (state.leases.size === 0) return;
    await new Promise<void>((resolve) => state.leaseWaiters.add(resolve));
  }

  async function assertExecutionActive(state: ExecutionState, executionId: string): Promise<void> {
    if (stopped) throw authorityStoppedError();
    if (state.terminal) throw terminalExecutionError(executionId);
    if (await isExecutionActive(executionId)) return;
    state.terminal = true;
    await revokeLeases(executionId, state, "terminal");
    throw terminalExecutionError(executionId);
  }

  async function revokeWithTimeout(
    revoke: () => Promise<void>,
    executionId: string,
    details: { reason: string; attempt: number },
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`token revocation timed out after ${TOKEN_REVOCATION_TIMEOUT_MS}ms`)),
        TOKEN_REVOCATION_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([Promise.resolve().then(revoke), timeout]);
      return true;
    } catch (error) {
      logger.warn(
        {
          executionId,
          phase: "revoke",
          reason: details.reason,
          attempt: details.attempt,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "execution authority token revocation failed",
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function repositoriesForAuthority(
  github: CompiledGitHubAuthority,
  triggerContext: unknown,
): readonly string[] {
  if (github.repositories !== undefined) return github.repositories;
  if (
    typeof triggerContext === "object" &&
    triggerContext !== null &&
    "provider" in triggerContext &&
    triggerContext.provider === "github" &&
    "target" in triggerContext &&
    typeof triggerContext.target === "object" &&
    triggerContext.target !== null &&
    "repository" in triggerContext.target &&
    typeof triggerContext.target.repository === "string"
  ) {
    return [triggerContext.target.repository];
  }
  throw new Error(
    "github.repositories is required for this trigger source; Hub cannot safely expand authority to all installation repositories",
  );
}

function githubEnvironment(
  botUserId: number,
  botLogin: string,
  token: string,
): Record<string, string> {
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: botLogin,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: `${botUserId}+${botLogin}@users.noreply.github.com`,
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    GIT_CONFIG_KEY_4: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_4: "!gh auth git-credential",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function terminalExecutionError(executionId: string): Error {
  return new Error(`cannot materialize terminal execution ${executionId}`);
}

function authorityStoppedError(): Error {
  return new Error("execution authority is stopped");
}

function removeLease(
  states: Map<string, ExecutionState>,
  executionId: string,
  state: ExecutionState,
  lease: TokenLease,
): void {
  if (state.leases.get(lease.token) !== lease) return;
  state.leases.delete(lease.token);
  lease.cancelLeaseDeadline();
  lease.cancelUpstreamExpiry();
  lease.cancelRetry();
  if (state.leases.size === 0) {
    for (const resolve of state.leaseWaiters) resolve();
    state.leaseWaiters.clear();
  }
  deleteEmptyState(states, executionId, state);
}

function deleteEmptyState(
  states: Map<string, ExecutionState>,
  executionId: string,
  state: ExecutionState,
): void {
  if (
    states.get(executionId) === state &&
    !state.terminal &&
    state.pendingMints === 0 &&
    state.leases.size === 0
  ) {
    states.delete(executionId);
  }
}
