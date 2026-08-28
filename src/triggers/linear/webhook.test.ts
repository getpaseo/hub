import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "vitest";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import { NormalizedLinearAgentSessionEventSchema } from "./events.js";
import {
  createLinearWebhookSource,
  verifyLinearSignature,
  verifyLinearWebhookTimestamp,
} from "./webhook.js";

const SECRET = "linear-webhook-secret";
const NOW = 1_700_000_000_000;

describe("Linear webhook", () => {
  it("verifies the exact raw body and its signed replay timestamp", () => {
    const body = new TextEncoder().encode('{"title":"héllo"}');
    const signature = sign(body);
    assert.equal(verifyLinearSignature(SECRET, body, signature), true);
    assert.equal(verifyLinearSignature(SECRET, body, `sha256=${signature.toUpperCase()}`), true);
    assert.equal(verifyLinearSignature(SECRET, body, sign("different")), false);
    assert.equal(verifyLinearSignature(SECRET, body, "short"), false);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: NOW }, NOW), true);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: NOW - 60_001 }, NOW), false);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: "not-a-time" }, NOW), false);
  });

  it("normalizes an issue, durably accepts it, and dispatches its selected route", async () => {
    const accepted: unknown[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptedEvent(input));
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(request(issueEnvelope()));
    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      dispatched.map(({ source: eventSource, resourceId }) => ({ eventSource, resourceId })),
      [{ eventSource: "linear.issue", resourceId: "project-1" }],
    );
    assert.deepEqual(accepted[0], {
      linearOrganizationId: "linear-org",
      projectId: "project-1",
      deliveryId: "delivery-1",
      signatureHash: acceptedSignatureHash(),
      source: "linear.issue",
      payload: {
        type: "issue",
        action: "create",
        id: "issue-1",
        organizationId: "linear-org",
        actor: { id: "user-1", name: "Operator" },
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Ship the feature",
          description: "Useful context",
          url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
          projectId: "project-1",
          stateId: "ready",
          assigneeId: "user-2",
          labelIds: ["label-1"],
        },
        updatedFrom: {},
        occurredAt: new Date(NOW).toISOString(),
      },
      receivedAt: new Date(NOW),
    });
  });

  it("canonicalizes accepted signature evidence before receipt deduplication", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptedEvent(input));
    });
    const body = JSON.stringify(issueEnvelope());
    const signature = sign(body);

    assert.equal(
      (await endpoint.handle(request(issueEnvelope(), "Issue", { signature }))).status,
      200,
    );
    assert.equal(
      (
        await endpoint.handle(
          request(issueEnvelope(), "Issue", { signature: `sha256=${signature.toUpperCase()}` }),
        )
      ).status,
      200,
    );

    assert.deepEqual(
      accepted.map((input) => input.signatureHash),
      [acceptedSignatureHash(), acceptedSignatureHash()],
    );
  });

  it("hydrates a comment issue before project-scoped routing", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => ({
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: null,
        projectId: "project-1",
        stateId: "ready",
        assigneeId: null,
        labelIds: [],
      }),
      accept: async (input) => {
        accepted.push(input);
        return { status: "duplicate", receiptId: input.deliveryId };
      },
    });

    assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 200);
    assert.equal(accepted[0]?.projectId, "project-1");
    assert.equal(accepted[0]?.source, "linear.comment");
  });

  it("hydrates and dispatches native Linear agent-session events", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => ({
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: "Useful context",
        projectId: "project-1",
        stateId: "ready",
        assigneeId: "app-user",
        labelIds: [],
      }),
      accept: async (input) => {
        accepted.push(input);
        return acceptedEvent(input);
      },
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(request(agentSessionEnvelope(), "AgentSessionEvent"));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "linear.agent_session");
    assert.equal(accepted[0]?.projectId, "project-1");
    assert.equal(dispatched[0]?.source, "linear.agent_session");
    assert.equal(
      NormalizedLinearAgentSessionEventSchema.parse(accepted[0]?.payload).prompt,
      "<issue>Canonical Linear context</issue>",
    );
  });

  it("acknowledges an unbound compact agent session before issue hydration", async () => {
    let issueReads = 0;
    let acceptedSource: string | undefined;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => false,
      resolveIssue: async () => {
        issueReads += 1;
        throw new Error("Linear connection unavailable");
      },
      accept: async (input) => {
        acceptedSource = input.source;
        return { status: "dropped", receiptId: input.deliveryId, reason: "linear_unbound" };
      },
    });

    assert.equal(
      (await endpoint.handle(request(agentSessionEnvelope(), "AgentSessionEvent"))).status,
      200,
    );
    assert.equal(issueReads, 0);
    assert.equal(acceptedSource, "linear.agent_session");
  });

  it("acknowledges an unbound compact comment before attempting issue hydration", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    let issueReads = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => false,
      resolveIssue: async () => {
        issueReads += 1;
        throw new Error("Linear connection unavailable");
      },
      accept: async (input) => {
        accepted.push(input);
        return { status: "dropped", receiptId: input.deliveryId, reason: "linear_unbound" };
      },
    });

    assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 200);
    assert.equal(issueReads, 0);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.projectId, undefined);
    assert.equal(accepted[0]?.dropReason, undefined);
  });

  it("keeps a bound compact comment retryable when issue hydration fails", async () => {
    let accepted = false;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => Promise.reject(new Error("Linear API unavailable")),
      accept: async () => {
        accepted = true;
        return { status: "duplicate", receiptId: "delivery-1" };
      },
    });

    assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 503);
    assert.equal(accepted, false);
  });

  it("rejects unsigned and unavailable handoffs", async () => {
    const endpoint = webhookSource(() => Promise.reject(new Error("database offline")));
    assert.equal(
      (
        await endpoint.handle(
          new Request("https://hub.test/api/integrations/linear/events", {
            method: "POST",
            body: JSON.stringify(issueEnvelope()),
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (await endpoint.handle(request({ ...issueEnvelope(), webhookTimestamp: NOW - 60_001 })))
        .status,
      401,
    );
    assert.equal((await endpoint.handle(request(issueEnvelope()))).status, 503);
  });
});

function webhookSource(
  accept: (
    input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
  ) => Promise<ProviderEventAcceptance>,
) {
  return createLinearWebhookSource({ signingSecret: SECRET, now: () => NOW, accept });
}

function request(
  payload: unknown,
  event = "Issue",
  evidence: { deliveryId?: string; signature?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": evidence.deliveryId ?? "delivery-1",
      "linear-event": event,
      "linear-signature": evidence.signature ?? sign(body),
    },
    body,
  });
}

function sign(body: string | Uint8Array): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function acceptedSignatureHash(): string {
  return createHash("sha256")
    .update(sign(JSON.stringify(issueEnvelope())))
    .digest("hex");
}

function acceptedEvent(
  input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: "receipt-1",
    events: [
      {
        providerEventReceiptId: "receipt-1",
        organizationId: "org-1",
        projectId: "hub-project-1",
        configurationRevisionId: "11111111-1111-4111-8111-111111111132",
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: "linear-connection",
        resourceId: input.projectId ?? null,
      },
    ],
  };
}

function issueEnvelope() {
  return {
    action: "create",
    type: "Issue",
    organizationId: "linear-org",
    createdAt: new Date(NOW).toISOString(),
    webhookTimestamp: NOW,
    actor: { id: "user-1", name: "Operator" },
    data: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: "user-2",
      labelIds: ["label-1"],
    },
  };
}

function commentEnvelope() {
  return {
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    webhookTimestamp: NOW,
    actor: { id: "user-1", name: "Operator" },
    data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
  };
}

function agentSessionEnvelope() {
  return {
    action: "created",
    type: "AgentSessionEvent",
    organizationId: "linear-org",
    appUserId: "app-user",
    createdAt: new Date(NOW).toISOString(),
    webhookTimestamp: NOW,
    promptContext: "<issue>Canonical Linear context</issue>",
    agentSession: {
      id: "session-1",
      appUserId: "app-user",
      issueId: "issue-1",
      status: "pending",
      createdAt: new Date(NOW).toISOString(),
      creator: { id: "user-1", name: "Operator" },
      comment: {
        id: "comment-1",
        issueId: "issue-1",
        userId: "user-1",
        body: "@Paseo please draft a fix",
      },
      issue: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: "Useful context",
        url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
        teamId: "team-1",
        team: { id: "team-1", name: "Engineering", key: "ENG" },
      },
    },
  };
}
