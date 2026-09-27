import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, vi } from "vitest";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import { FORGEJO_FIXTURE_SECRET, forgejoRequest } from "../fixtures/forgejo/index.js";
import { createForgejoWebhookSource, type ForgejoWebhookSourceOptions } from "./webhook.js";
import { verifyForgejoSignature } from "./webhook-verify.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHmac: vi.fn(actual.createHmac) };
});

const SECRET = "the-answer-is-42";
const CONNECTION_ID = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`;
const CREDENTIALS = { instanceBaseUrl: "https://git.example.test", accessToken: "forgejo-token" };

describe("Forgejo webhook signature", () => {
  it("accepts GitHub's prefixed spelling of the same HMAC", () => {
    const body = new TextEncoder().encode('{"repository":{"full_name":"acme/widgets"}}');
    assert.equal(verifyForgejoSignature(SECRET, body, `sha256=${sign(body)}`), true);
  });

  it("accepts the bare hex Gitea and Forgejo send", () => {
    const body = new TextEncoder().encode('{"repository":{"full_name":"acme/widgets"}}');
    assert.equal(verifyForgejoSignature(SECRET, body, sign(body)), true);
  });

  it("ignores the case a forge chose for its hex", () => {
    const body = new TextEncoder().encode('{"héllo":"wörld"}');
    assert.equal(verifyForgejoSignature(SECRET, body, sign(body).toUpperCase()), true);
  });

  it("rejects a signature over a different body", () => {
    const body = new TextEncoder().encode('{"repository":{"full_name":"acme/widgets"}}');
    assert.equal(verifyForgejoSignature(SECRET, body, sign("something else")), false);
  });

  it("rejects a signature that is not 32 bytes of hex", () => {
    const body = new TextEncoder().encode("{}");
    assert.equal(verifyForgejoSignature(SECRET, body, "mostly harmless"), false);
  });
});

describe("Forgejo webhook", () => {
  it("accepts a signed delivery that carries no installation object", async () => {
    const accepted: unknown[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(signedRequest(issueCommentPayload()));

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
  });

  it("routes the delivery on its connection, not an installation id", async () => {
    const accepted: { connectionId?: string; repo?: string; source?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    await endpoint.handle(signedRequest(issueCommentPayload()));

    assert.equal(accepted[0]?.connectionId, CONNECTION_ID);
    assert.equal(accepted[0]?.repo, "acme/widgets");
    assert.equal(accepted[0]?.source, "forgejo.issue_comment");
  });

  it("dispatches an accepted delivery to every registered handler", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource(() => Promise.resolve(acceptance()));
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    await endpoint.handle(signedRequest(issueCommentPayload()));

    assert.equal(dispatched.length, 2);
  });

  it("refuses a delivery whose signature does not match the connection secret", async () => {
    const endpoint = webhookSource(() => Promise.resolve(acceptance()));
    const response = await endpoint.handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: headers("deadbeef".repeat(8)),
        body: JSON.stringify(issueCommentPayload()),
      }),
    );

    assert.equal(response.status, 401);
  });

  it("answers an unknown connection exactly like a bad signature, never 404", async () => {
    // A 404 here would confirm which connection ids are live to anyone who can reach
    // the endpoint. Both cases have to be indistinguishable.
    const endpoint = createForgejoWebhookSource({
      findConnection: () => Promise.resolve(undefined),
      accept: () => Promise.resolve(acceptance()),
    });

    const response = await endpoint.handle(signedRequest(issueCommentPayload()));

    assert.equal(response.status, 401);
  });

  // Skipping the HMAC when the connection lookup already came back empty would answer
  // faster than a known connection with a bad signature, and that gap is itself an
  // oracle for which connection ids exist. Both paths must pay for one createHmac call.
  it("computes an HMAC against a decoy secret for an unknown connection too", async () => {
    const endpoint = createForgejoWebhookSource({
      findConnection: () => Promise.resolve(undefined),
      accept: () => Promise.resolve(acceptance()),
    });
    const request = signedRequest(issueCommentPayload());

    const hmacSpy = vi.mocked(createHmac);
    hmacSpy.mockClear();
    const response = await endpoint.handle(request);

    assert.equal(response.status, 401);
    assert.equal(hmacSpy.mock.calls.length, 1);
  });

  it("never consults the store for a delivery bigger than the cap", async () => {
    let lookups = 0;
    const endpoint = createForgejoWebhookSource({
      findConnection: (id) => {
        lookups += 1;
        return Promise.resolve({
          id,
          webhookSecret: SECRET,
          accountId: ACCOUNT_ID,
          credentials: CREDENTIALS,
        });
      },
      accept: () => Promise.resolve(acceptance()),
    });
    const oversized = JSON.stringify({ padding: "x".repeat(1_048_577) });

    const response = await endpoint.handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: headers(sign(oversized)),
        body: oversized,
      }),
    );

    assert.notEqual(response.status, 200);
    assert.equal(lookups, 0);
  });

  it("logs an authentic delivery that names no repository without dispatching it", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource(() => Promise.resolve(acceptance()));
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(signedRequest({ action: "created" }));

    assert.equal(response.status, 200);
    assert.deepEqual(dispatched, []);
  });

  it("reads the event name from the Gitea header when Forgejo's is absent", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());
    const body = JSON.stringify(issueCommentPayload());

    await endpoint.handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "X-Gitea-Event": "issues",
          "X-Gitea-Delivery": "delivery-gitea",
          "X-Gitea-Signature": sign(body),
        }),
        body,
      }),
    );

    assert.equal(accepted[0]?.source, "forgejo.issues");
  });

  it("refuses a signed delivery that names no event", async () => {
    const endpoint = webhookSource(() => Promise.resolve(acceptance()));
    const body = JSON.stringify(issueCommentPayload());

    const response = await endpoint.handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "X-Forgejo-Delivery": "delivery-1",
          "X-Hub-Signature-256": `sha256=${sign(body)}`,
        }),
        body,
      }),
    );

    assert.equal(response.status, 400);
  });

  it("does not dispatch a delivery the store reports as already seen", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource(() =>
      Promise.resolve({ status: "duplicate", receiptId: "receipt-1" } as const),
    );
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(signedRequest(issueCommentPayload()));

    assert.equal(response.status, 200);
    assert.deepEqual(dispatched, []);
  });
});

describe("Forgejo webhook, against real deliveries", () => {
  it("accepts a real issue comment under the issue_comment source", async () => {
    const accepted: { source?: string; repo?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(forgejoRequest("issue-comment-created", CONNECTION_ID));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.issue_comment");
    assert.equal(accepted[0]?.repo, "acme/widgets");
  });

  // A comment on a pull request arrives under the same header Forgejo uses for a plain
  // issue comment (modules/webhook/type.go's Event() collapses both to "issue_comment"),
  // so the source name is identical; only the body says which one it was.
  it("accepts a real pull request comment under the same issue_comment source", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      forgejoRequest("pull-request-comment-created", CONNECTION_ID),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.issue_comment");
  });

  it("accepts a real issue opened delivery under the issues source", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(forgejoRequest("issue-opened", CONNECTION_ID));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.issues");
  });

  it("accepts a real pull request opened delivery under the pull_request source", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(forgejoRequest("pull-request-opened", CONNECTION_ID));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.pull_request");
  });

  // A real label add collapses to the same "issues"/"pull_request" source a plain edit
  // would, same as GitHub's convention; nothing broken at this layer. The bug is one
  // layer up: forge/classification.ts never recognizes Forgejo's own action spelling
  // (label_updated/label_cleared, not GitHub's labeled), covered in match.test.ts.
  it("accepts a real label add under the plain issues source", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(forgejoRequest("issue-label-added", CONNECTION_ID));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.issues");
  });

  it("accepts a real push delivery", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(forgejoRequest("push", CONNECTION_ID));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.push");
  });

  // the real header is pull_request_approved/_rejected/_comment; verifyForgejoRequest
  // normalizes it to pull_request_review before this point.
  it("dispatches a real review approval under the documented review source name", async () => {
    const accepted: { source?: string }[] = [];
    const endpoint = fixtureWebhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      forgejoRequest("pull-request-review-approved", CONNECTION_ID),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "forgejo.pull_request_review");
  });
});

describe("Forgejo webhook own-account guard", () => {
  it("drops a delivery whose sender is the connection's own account, without dispatching it", async () => {
    const accepted: { dropReason?: string }[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(droppedAcceptance("own_account"));
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload("Mostly harmless.", { login: ACCOUNT_LOGIN, id: ACCOUNT_ID }),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.dropReason, "own_account");
    assert.deepEqual(dispatched, []);
  });

  // The account can be renamed after the connection was created: the login the
  // delivery carries is the new one, but the numeric id Hub stored at connect time
  // never changes, so this still has to drop.
  it("drops a delivery whose sender login differs but whose account id matches", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(droppedAcceptance("own_account"));
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload("Mostly harmless.", { login: "renamed-hub-bot", id: ACCOUNT_ID }),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.dropReason, "own_account");
  });

  // The inverse: a sender whose login happens to match the account's old name, but
  // whose id does not, is a different account and must not be dropped.
  it("does not drop a delivery whose sender login matches but whose account id differs", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(issueCommentPayload("Mostly harmless.", { login: ACCOUNT_LOGIN, id: 12345 })),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.dropReason, undefined);
  });

  it("still dispatches a delivery sent by anyone other than the connection's own account", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload("a different comment entirely", { login: "trillian", id: 1 }),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.dropReason, undefined);
  });

  // The guard is not scoped to issue_comment: any event type the connection's own
  // token can trigger through the API (labels, assignees, reviews) is dropped too.
  it("drops a non-comment delivery whose sender is the connection's own account", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(droppedAcceptance("own_account"));
    });
    await endpoint.start(() => Promise.resolve());
    const body = JSON.stringify({
      action: "opened",
      repository: { id: 9001, full_name: "acme/widgets" },
      pull_request: { number: 7 },
      sender: { login: ACCOUNT_LOGIN, id: ACCOUNT_ID },
    });

    const response = await endpoint.handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "X-Forgejo-Event": "pull_request",
          "X-Forgejo-Delivery": "delivery-1",
          "X-Hub-Signature-256": `sha256=${sign(body)}`,
        }),
        body,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.dropReason, "own_account");
  });

  const SIBLING_ACCOUNT_ID = 901;

  // One organization can bind two different bot accounts on the same Forgejo instance,
  // and if both are subscribed to overlapping repositories, a write by one arrives as a
  // delivery on the other's connection too. That has to drop like this connection's own
  // writes do, or the two bots could feed each other in a loop.
  it("drops a delivery whose sender is a sibling connection's account, not just this one's", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = createForgejoWebhookSource({
      findConnection: (id) =>
        Promise.resolve(
          id === CONNECTION_ID
            ? {
                id,
                webhookSecret: SECRET,
                accountId: ACCOUNT_ID,
                siblingAccountIds: [SIBLING_ACCOUNT_ID],
                credentials: CREDENTIALS,
              }
            : undefined,
        ),
      accept: (input) => {
        accepted.push(input);
        return Promise.resolve(droppedAcceptance("own_account"));
      },
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload("Mostly harmless.", { login: "other-bot", id: SIBLING_ACCOUNT_ID }),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.dropReason, "own_account");
  });

  it("still dispatches a sender that is neither this connection's account nor a sibling's", async () => {
    const accepted: { dropReason?: string }[] = [];
    const endpoint = createForgejoWebhookSource({
      findConnection: (id) =>
        Promise.resolve(
          id === CONNECTION_ID
            ? {
                id,
                webhookSecret: SECRET,
                accountId: ACCOUNT_ID,
                siblingAccountIds: [SIBLING_ACCOUNT_ID],
                credentials: CREDENTIALS,
              }
            : undefined,
        ),
      accept: (input) => {
        accepted.push(input);
        return Promise.resolve(acceptance());
      },
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload("a different comment entirely", { login: "trillian", id: 1 }),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.dropReason, undefined);
  });
});

describe("Forgejo webhook connection id", () => {
  it("reads the id from the segment after events, not the end of the path", async () => {
    const accepted: { connectionId?: string }[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptance());
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(signedRequest(issueCommentPayload(), `${ENDPOINT}/`));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.connectionId, CONNECTION_ID);
  });

  it("rejects a delivery that names no connection at all", async () => {
    const endpoint = webhookSource(() => Promise.resolve(acceptance()));
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload(),
        "https://hub.example.test/api/integrations/forgejo/events",
      ),
    );

    assert.equal(response.status, 401);
  });

  // A malformed id must answer the same as an unknown one. Anything else tells a caller
  // which shape the column holds, and lets them reach the lookup with garbage.
  it("answers a malformed id exactly like an unknown one", async () => {
    const looked: string[] = [];
    const endpoint = createForgejoWebhookSource({
      findConnection: (id) => {
        looked.push(id);
        return Promise.resolve(
          id === CONNECTION_ID
            ? { id, webhookSecret: SECRET, accountId: ACCOUNT_ID, credentials: CREDENTIALS }
            : undefined,
        );
      },
      accept: () => Promise.resolve(acceptance()),
    });
    await endpoint.start(() => Promise.resolve());

    const response = await endpoint.handle(
      signedRequest(
        issueCommentPayload(),
        "https://hub.example.test/api/integrations/forgejo/events/zaphod",
      ),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(looked, []);
  });
});

// Distinct from every fixture's own sender ("trillian" id 1, "zaphod" id 2), so the
// own-account drop this module also guards against never fires for a test that isn't
// about it.
const ACCOUNT_LOGIN = "hub-bot";
const ACCOUNT_ID = 900;

function webhookSource(accept: ForgejoWebhookSourceOptions["accept"]) {
  return createForgejoWebhookSource({
    findConnection: (id) =>
      Promise.resolve(
        id === CONNECTION_ID
          ? { id, webhookSecret: SECRET, accountId: ACCOUNT_ID, credentials: CREDENTIALS }
          : undefined,
      ),
    accept,
  });
}

/** Same as webhookSource, but keyed to the secret every captured fixture is signed with. */
function fixtureWebhookSource(accept: ForgejoWebhookSourceOptions["accept"]) {
  return createForgejoWebhookSource({
    findConnection: (id) =>
      Promise.resolve(
        id === CONNECTION_ID
          ? {
              id,
              webhookSecret: FORGEJO_FIXTURE_SECRET,
              accountId: ACCOUNT_ID,
              credentials: CREDENTIALS,
            }
          : undefined,
      ),
    accept,
  });
}

function signedRequest(payload: unknown, endpoint: string = ENDPOINT): Request {
  const body = JSON.stringify(payload);
  return new Request(endpoint, { method: "POST", headers: headers(sign(body)), body });
}

function headers(signature: string): Headers {
  return new Headers({
    "content-type": "application/json",
    "X-Forgejo-Event": "issue_comment",
    "X-Forgejo-Delivery": "delivery-1",
    "X-Hub-Signature-256": `sha256=${signature}`,
  });
}

function issueCommentPayload(
  body = "@paseo have a look",
  sender: { login: string; id: number } = { login: "trillian", id: 1 },
) {
  return {
    action: "created",
    repository: { id: 9001, full_name: "acme/widgets" },
    issue: { number: 42, title: "Improbability drive stalls", body: "on cold mornings" },
    comment: { body, user: { login: "trillian" } },
    sender: { login: sender.login, id: sender.id },
  };
}

function acceptance(): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: "receipt-1",
    events: [
      {
        providerEventReceiptId: "receipt-1",
        organizationId: "org-1",
        projectId: "project-1",
        configurationRevisionId: "revision-1",
        deliveryId: "delivery-1",
        source: "forgejo.issue_comment",
        payload: issueCommentPayload(),
        receivedAt: new Date("2026-09-25T08:00:00.000Z"),
        connectionId: CONNECTION_ID,
        resourceId: "9001",
      },
    ],
  };
}

function droppedAcceptance(reason: string): ProviderEventAcceptance {
  return { status: "dropped", receiptId: "receipt-1", reason };
}

function sign(body: string | Uint8Array): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}
