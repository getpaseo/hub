import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import type { GitHubExecutionTokenAuth } from "../auth/github.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { GitHubConnectionRecord, SlackConnectionRecord } from "../db/types.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";
import { ProjectDashboard } from "../projects/dashboard.js";
import type { GitHubReactionClient } from "./github/provider.js";
import { createGitHubTriggerProvider } from "./github/provider.js";
import type { SlackBotClient } from "./slack/client.js";
import { createSlackTriggerProvider } from "./slack/provider.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";

describe("provider routing evidence", () => {
  it("durably records a Slack sender rejection without exposing event content", async () => {
    const connection = slackConnection();
    const database = createMemoryDatabase({
      memberships: [membership()],
      slackConnections: [connection],
    });
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      slackConfiguration(),
      { organizationId: connection.organizationId },
    );
    await database.activateProjectConfigurationRevision(project.id, revision.id, [
      {
        provider: "slack",
        connectionId: connection.id,
        resourceId: null,
        triggerName: "slack-run",
      },
    ]);

    const payload = slackPayload();
    const acceptance = await database.acceptSlackEvent({
      deliveryId: "slack-audited-delivery",
      signatureHash: "PRIVATE-SLACK-SIGNATURE",
      source: "slack.mention",
      payload,
      receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      teamId: connection.teamId,
    });
    assert.equal(acceptance.status, "accepted");
    if (acceptance.status !== "accepted") throw new Error("Slack event was not accepted");

    assert.deepEqual(
      await database.listUnroutedProviderEventsForOrganization(connection.organizationId),
      [],
    );
    assert.equal(
      (await database.findProviderEventReceiptById(acceptance.receiptId))?.payload,
      null,
    );
    const replay = await database.acceptSlackEvent({
      deliveryId: "slack-audited-delivery",
      signatureHash: "PRIVATE-SLACK-SIGNATURE",
      source: "slack.mention",
      payload,
      receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      teamId: connection.teamId,
    });
    assert.equal(replay.status, "accepted");
    if (replay.status !== "accepted") throw new Error("Slack replay was not accepted");
    assert.deepEqual(replay.events[0]?.payload, payload);

    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new NoopSlackClient(),
    });
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [provider],
      dispatchLaunchMachineIntent: async () => {
        throw new Error("sender rejection must not dispatch");
      },
    });

    await handler(acceptance.events[0]!);

    assert.deepEqual(
      await database.findTriggerRunsByProviderEventReceiptId(acceptance.receiptId),
      [],
    );
    const receipt = (
      await database.listUnroutedProviderEventsForOrganization(connection.organizationId)
    )[0];
    assert.ok(receipt);
    assert.equal(receipt.droppedReason, null);
    assert.equal(
      (await database.findProviderEventReceiptById(acceptance.receiptId))?.payload,
      null,
    );
    assert.equal(
      (await database.findProviderEventReceiptById(acceptance.receiptId))?.signatureHash,
      null,
    );
    assert.deepEqual(
      receipt.routingDecisions.map(({ triggerName, code, summary }) => ({
        triggerName,
        code,
        summary,
      })),
      [
        {
          triggerName: "slack-run",
          code: "sender_not_allowed",
          summary: "The sender is not allowed for this trigger.",
        },
      ],
    );

    const dashboard = new ProjectDashboard(database, accountAuth(), undefined);
    const snapshot = await dashboard.organizationSnapshot(new Request("https://hub.test"), {
      organizationSlug: "acme",
    });
    assert.equal(snapshot.unroutedEvents[0]?.reason, "The sender is not allowed for this trigger.");
    const safeDashboard = JSON.stringify(snapshot.unroutedEvents);
    assert.doesNotMatch(safeDashboard, /PRIVATE-SLACK-CONTENT|U2|C1/gu);
    assert.doesNotMatch(safeDashboard, /attachments|token|signature/giu);
    await engine.stop();
  });

  it("records GitHub pull-request noise as having no configured trigger", async () => {
    const connection = githubConnection();
    const database = createMemoryDatabase({ githubConnections: [connection] });
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      githubConfiguration(),
      { organizationId: connection.organizationId },
    );
    await database.activateProjectConfigurationRevision(project.id, revision.id, [
      {
        provider: "github",
        connectionId: connection.id,
        resourceId: null,
        triggerName: "github-issue-comment",
      },
    ]);

    const acceptance = await database.acceptGitHubEvent({
      deliveryId: "github-pull-request-noise",
      source: "github.pull_request",
      repo: "acme/widgets",
      repositoryId: 7,
      payload: {
        id: "github-pull-request-noise",
        type: "pull_request",
        repo: "acme/widgets",
        repositoryId: 7,
        installationId: connection.installationId,
        payload: { pull_request: { title: "PRIVATE-GITHUB-CONTENT" } },
        createdAt: "2026-08-09T12:00:00.000Z",
      },
      receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      installationId: connection.installationId,
    });
    assert.equal(acceptance.status, "accepted");
    if (acceptance.status !== "accepted") throw new Error("GitHub event was not accepted");

    const provider = createGitHubTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new NoopGitHubReactions(),
      executionTokens: new NoopGitHubExecutionTokens(),
    });
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [provider],
      dispatchLaunchMachineIntent: async () => {
        throw new Error("unhandled GitHub noise must not dispatch");
      },
    });

    await handler(acceptance.events[0]!);

    assert.deepEqual(
      await database.findTriggerRunsByProviderEventReceiptId(acceptance.receiptId),
      [],
    );
    const receipt = (
      await database.listUnroutedProviderEventsForOrganization(connection.organizationId)
    )[0];
    assert.ok(receipt);
    assert.equal(receipt.droppedReason, null);
    assert.deepEqual(
      receipt.routingDecisions.map((decision) => decision.code),
      ["no_trigger_for_source"],
    );
    assert.equal(receipt.routingDecisions[0]?.triggerName, null);
    assert.equal(receipt.routingDecisions[0]?.summary, "No configured trigger handles this event.");
    await engine.stop();
  });

  it("persists only safe metadata for an immediate provider drop", async () => {
    const connection = slackConnection();
    const database = createMemoryDatabase({ slackConnections: [connection] });

    const result = await database.acceptSlackEvent({
      deliveryId: "slack-no-handler",
      source: "slack.mention",
      payload: slackPayload(),
      receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      teamId: connection.teamId,
      dropReason: "slack_no_handler",
    });

    assert.equal(result.status, "dropped");
    const receipt = await database.findProviderEventReceiptByDeliveryId(
      "slack-no-handler",
      connection.organizationId,
    );
    assert.ok(receipt);
    assert.equal(result.receiptId, receipt.id);
    assert.equal(receipt.payload, null);
    assert.equal(receipt.signatureHash, null);
    assert.equal(receipt.acceptedRoutes, null);
    assert.equal(receipt.droppedReason, "slack_no_handler");
    assert.equal(
      (await database.findProviderEventRoutingOutcomeByReceiptId(receipt.id))?.status,
      "dropped",
    );
    const unrouted = await database.listUnroutedProviderEventsForOrganization(
      connection.organizationId,
    );
    assert.equal(unrouted.length, 1);
    assert.deepEqual(unrouted[0]?.routingDecisions, []);
    assert.doesNotMatch(JSON.stringify({ receipt, unrouted }), /PRIVATE-SLACK-CONTENT|U2|C1/gu);
  });
});

function membership() {
  return {
    userId: "user-1",
    organizationId: "org-1",
    organizationName: "Acme",
    organizationSlug: "acme",
    membershipId: "membership-1",
    role: "owner" as const,
  };
}

function slackConnection(): SlackConnectionRecord {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    organizationId: "org-1",
    slug: "acme-slack",
    teamId: "T1",
    teamName: "Acme",
    botUserId: "UBOT",
    botAccessToken: "not-used",
    scopes: [],
  };
}

function githubConnection(): GitHubConnectionRecord {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    organizationId: "org-1",
    slug: "acme-github",
    installationId: 42,
    accountId: "account-1",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active",
  };
}

function slackConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "1h",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"] },
        steps: [
          {
            id: "step",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "test" },
            prompt: [{ text: "Run" }],
          },
        ],
      },
    ],
  };
}

function githubConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "github-issue-comment",
        on: "github.issue_comment",
        max_runtime: "1h",
        filters: { repo: "acme/widgets", contains: "@paseo", from_users: ["operator"] },
        steps: [
          {
            id: "step",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "test" },
            prompt: [{ text: "Run" }],
          },
        ],
      },
    ],
  };
}

function slackPayload() {
  return {
    type: "mention",
    id: "slack-event-1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: null,
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "<@UBOT> PRIVATE-SLACK-CONTENT",
    author: { id: "U2" },
    createdAt: "2026-08-09T12:00:00.000Z",
    attachments: [],
    threadContextMessages: [],
  };
}

class NoopSlackClient implements SlackBotClient {
  sendMessage(): Promise<void> {
    return Promise.resolve();
  }
  addReaction(): Promise<void> {
    return Promise.resolve();
  }
  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
}

class NoopGitHubReactions implements GitHubReactionClient {
  createReaction(): Promise<{ id: number }> {
    return Promise.resolve({ id: 1 });
  }
  deleteReaction(): Promise<void> {
    return Promise.resolve();
  }
}

class NoopGitHubExecutionTokens implements GitHubExecutionTokenAuth {
  mintExecutionToken(): Promise<string> {
    return Promise.resolve("not-used");
  }
  revokeInstallationToken(): Promise<void> {
    return Promise.resolve();
  }
}

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
