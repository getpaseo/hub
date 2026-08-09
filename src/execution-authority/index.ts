import type { CompiledGitHubAuthority } from "../config/github-authority.js";
import {
  parseConnectionTemplate,
  resolveConnectionTemplate,
} from "../config/connection-template.js";
import type { ConnectionResolver } from "../config/connections.js";
import type { GitHubAuthorityRegistration } from "../providers/registration.js";
import { logger } from "../logger.js";

const TOKEN_REVOCATION_TIMEOUT_MS = 10_000;

export interface ExecutionAuthorityClock {
  now(): number;
  schedule(callback: () => Promise<void>, delayMs: number): () => void;
}

const systemClock: ExecutionAuthorityClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(() => void callback(), delayMs);
    timer.unref();
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
}

export interface CreateExecutionAuthorityOptions {
  connectionsForProject: (projectId: string) => ConnectionResolver;
  githubAuthority?: GitHubAuthorityRegistration | undefined;
  clock?: ExecutionAuthorityClock | undefined;
}

interface TokenLease {
  token: string;
  revoke: () => Promise<void>;
  cancel: () => void;
}

interface ExecutionState {
  pendingMints: number;
  terminal: boolean;
  leases: Map<string, TokenLease>;
}

export function createExecutionAuthority(
  options: CreateExecutionAuthorityOptions,
): ExecutionAuthority {
  const clock = options.clock ?? systemClock;
  const states = new Map<string, ExecutionState>();

  async function materialize(
    input: ExecutionAuthorityMaterialization,
  ): Promise<MaterializedExecutionAuthority> {
    const state = getOrCreateState(input.executionId);
    if (state.terminal) throw terminalExecutionError(input.executionId);
    state.pendingMints += 1;
    try {
      const tokenRevocations = new Map<string, Promise<string> | undefined>();
      const context = {
        executionId: input.executionId,
        registerToken: async (token: string, revoke?: () => Promise<void> | void) => {
          if (revoke === undefined) return;
          await registerLease(state, input.executionId, token, revoke);
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
        return {
          env: {
            ...env,
            ...githubEnvironment(authority.botUserId, authority.botLogin, authority.token),
          },
        };
      }
      assertExecutionActive(state, input.executionId);
      return { env };
    } finally {
      state.pendingMints -= 1;
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
    if (state.terminal) {
      await revokeWithTimeout(async () => revoke(), executionId);
      throw terminalExecutionError(executionId);
    }
    const leaseDeadline =
      leaseDurationMs === undefined
        ? undefined
        : Math.min(
            clock.now() + leaseDurationMs,
            upstreamExpiresAt === undefined ? Number.POSITIVE_INFINITY : upstreamExpiresAt,
          );
    const cancel =
      leaseDeadline === undefined
        ? () => undefined
        : clock.schedule(
            () => releaseLease(executionId, token),
            Math.max(0, leaseDeadline - clock.now()),
          );
    state.leases.set(token, { token, revoke: async () => revoke(), cancel });
  }

  async function releaseLease(executionId: string, token: string): Promise<void> {
    const state = states.get(executionId);
    const lease = state?.leases.get(token);
    if (state === undefined || lease === undefined) return;
    state.leases.delete(token);
    lease.cancel();
    await revokeWithTimeout(lease.revoke, executionId);
    deleteEmptyState(states, executionId, state);
  }

  async function onExecutionTerminal(executionId: string): Promise<void> {
    const state = getOrCreateState(executionId);
    state.terminal = true;
    const leases = [...state.leases.values()];
    state.leases.clear();
    for (const lease of leases) lease.cancel();
    await Promise.all(leases.map((lease) => revokeWithTimeout(lease.revoke, executionId)));
    deleteEmptyState(states, executionId, state);
  }

  function getOrCreateState(executionId: string): ExecutionState {
    const existing = states.get(executionId);
    if (existing !== undefined) return existing;
    const state: ExecutionState = { pendingMints: 0, terminal: false, leases: new Map() };
    states.set(executionId, state);
    return state;
  }

  return { materialize, onExecutionTerminal };

  async function revokeWithTimeout(
    revoke: () => Promise<void>,
    executionId: string,
  ): Promise<void> {
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
    } catch {
      logger.warn({ executionId }, "execution authority token revocation failed");
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

function assertExecutionActive(state: ExecutionState, executionId: string): void {
  if (state.terminal) throw terminalExecutionError(executionId);
}

function terminalExecutionError(executionId: string): Error {
  return new Error(`cannot materialize terminal execution ${executionId}`);
}

function deleteEmptyState(
  states: Map<string, ExecutionState>,
  executionId: string,
  state: ExecutionState,
): void {
  if (states.get(executionId) === state && state.pendingMints === 0 && state.leases.size === 0) {
    states.delete(executionId);
  }
}
