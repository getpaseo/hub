import type { GitHubExecutionTokenAuth } from "../../auth/github.js";
import { logger } from "../../logger.js";

const TOKEN_REVOCATION_TIMEOUT_MS = 5_000;

interface ExecutionTokenState {
  pendingMints: number;
  terminal: boolean;
  tokens: Set<string>;
}

export function createGitHubExecutionTokenRegistry(executionTokens: GitHubExecutionTokenAuth) {
  const states = new Map<string, ExecutionTokenState>();

  return {
    async mint(executionId: string, mint: () => Promise<string>): Promise<string> {
      const state = states.get(executionId) ?? {
        pendingMints: 0,
        terminal: false,
        tokens: new Set<string>(),
      };
      if (state.terminal) throw new Error(`cannot materialize terminal execution ${executionId}`);
      states.set(executionId, state);
      state.pendingMints += 1;
      try {
        const token = await mint();
        if (state.terminal) {
          await revokeTokens(executionTokens, executionId, [token]);
          throw new Error(`cannot materialize terminal execution ${executionId}`);
        }
        state.tokens.add(token);
        return token;
      } finally {
        state.pendingMints -= 1;
        deleteEmptyState(states, executionId, state);
      }
    },

    async onExecutionTerminal(executionId: string): Promise<void> {
      const state = states.get(executionId) ?? {
        pendingMints: 0,
        terminal: false,
        tokens: new Set<string>(),
      };
      states.set(executionId, state);
      state.terminal = true;
      const tokens = [...state.tokens];
      state.tokens.clear();
      await revokeTokens(executionTokens, executionId, tokens);
      deleteEmptyState(states, executionId, state);
    },
  };
}

function deleteEmptyState(
  states: Map<string, ExecutionTokenState>,
  executionId: string,
  state: ExecutionTokenState,
): void {
  if (states.get(executionId) === state && state.pendingMints === 0 && state.tokens.size === 0) {
    states.delete(executionId);
  }
}

async function revokeTokens(
  executionTokens: GitHubExecutionTokenAuth,
  executionId: string,
  tokens: readonly string[],
): Promise<void> {
  const revocations = await Promise.allSettled(
    tokens.map((token) =>
      withTimeout(executionTokens.revokeInstallationToken(token), TOKEN_REVOCATION_TIMEOUT_MS),
    ),
  );
  for (const result of revocations) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, executionId }, "GitHub execution token revocation failed");
    }
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timeout));
}
