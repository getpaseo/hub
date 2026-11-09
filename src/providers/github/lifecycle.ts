import type { Database } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import type { GitHubConnectionClient } from "./client.js";
import type { GitHubConfigurationProvider } from "./configuration-source.js";
import type {
  GitHubInstallationSyncOwner,
  GitHubLifecycleReceiptClaimInput,
} from "./persistence-types.js";
import { githubPersistence } from "./persistence.js";

/** A receipt and its pending job are accepted together before acknowledging GitHub. */
export function createGitHubLifecycle(
  database: Database,
  client: GitHubConnectionClient,
  repositories: Pick<GitHubConfigurationProvider, "listInstallationRepositories">,
  owner: GitHubInstallationSyncOwner,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function drain(): Promise<void> {
    for (;;) {
      const pending = await githubPersistence(database).pendingGitHubInstallationSyncs(owner);
      if (pending.length === 0) return;
      for (const claim of pending) {
        await githubPersistence(database).synchronizeGitHubInstallation(
          claim.installationId,
          async () => {
            try {
              const evidence = await client.getInstallation(claim.installationId);
              if (evidence.status === "absent") {
                await githubPersistence(database).applyGitHubInstallationSync(owner, claim, {
                  status: "absent",
                  removeBinding: claim.removeBinding,
                });
                return;
              }
              const available =
                evidence.identity.status === "suspended"
                  ? []
                  : await repositories.listInstallationRepositories({
                      installationId: claim.installationId,
                    });
              await githubPersistence(database).applyGitHubInstallationSync(owner, claim, {
                status: "present",
                identity: evidence.identity,
                repositories: available,
              });
            } catch (error) {
              await githubPersistence(database).retryGitHubInstallationSync(
                owner,
                claim.installationSyncId,
              );
              reportFailure(error, {
                operation: "github.lifecycle.synchronize",
                component: "connections",
                provider: "github",
              });
            }
          },
        );
      }
    }
  }

  function wake(): void {
    if (running !== undefined) return;
    running = drain()
      .catch((error: unknown) => {
        reportFailure(error, {
          operation: "github.lifecycle.drain",
          component: "connections",
          provider: "github",
        });
      })
      .finally(() => {
        running = undefined;
      });
  }

  return {
    async accept(
      input: Omit<GitHubLifecycleReceiptClaimInput, "providerApplicationId">,
    ): Promise<void> {
      await githubPersistence(database).claimGitHubLifecycleReceipt({
        ...input,
        providerApplicationId: owner.providerApplicationId,
      });
      wake();
    },
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(wake, 1_000);
      timer.unref();
      wake();
    },
    async stop(): Promise<void> {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
