import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { createForgejoTriggerProvider } from "./provider.js";

const CONNECTION = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-forgejo",
  instanceId: "inst-1",
};

describe("Forgejo trigger provider", () => {
  it("matches a claimed receipt payload once through the T05 provider", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const { project, revision, store } = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      {
        environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
        triggers: [
          {
            name: "forgejo-issue",
            on: "forgejo.issue_created",
            max_runtime: "2h",
            filters: { from_users: ["*"] },
            steps: [
              {
                id: "reply",
                environment: "runner",
                max_runtime: "1h",
                idle_timeout: "5m",
                agent: { provider: "opencode", mode: "default" },
                prompt: [{ text: "Handle it" }],
              },
            ],
          },
        ],
      },
    );
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      connectionFor: async () => CONNECTION,
    });
    const result = await provider.match({
      providerEventReceiptId: "receipt-1",
      organizationId: project.organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "forgejo.issues",
      deliveryId: String(delivery.headers["x-forgejo-delivery"]),
      receivedAt: new Date("2026-08-30T12:00:00Z"),
      payload: {
        headers: {
          "x-forgejo-delivery": delivery.headers["x-forgejo-delivery"],
          "x-forgejo-event": delivery.event,
          "x-forgejo-event-type": delivery.eventType,
        },
        raw: delivery.raw,
      },
      connectionId: CONNECTION.id,
      resourceId: "1",
    });
    if (typeof result === "string") throw new Error(result);
    const match = result[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.triggerContext.provider, "forgejo");
    assert.equal(match.triggerContext.event.forgejo.actor.login.length > 0, true);
  });
});
