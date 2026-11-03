import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { DurableProviderEvent } from "../../db/types.js";
import { runWithFailureTracking } from "../../failures/index.js";
import { createLogger } from "../../logger.js";
import {
  GoogleChatOidcVerificationError,
  type GoogleChatOidcVerifier,
} from "../../providers/google-chat/oidc.js";
import { FailureLogStream } from "../../test-utils/failure-logs.js";
import { createGoogleChatWebhookSource } from "./webhook.js";

function verifierAccepting(validToken: string): GoogleChatOidcVerifier {
  const verifyBearerToken = (token: string) => {
    if (token !== validToken) {
      return Promise.reject(new GoogleChatOidcVerificationError("Invalid bearer token."));
    }
    return Promise.resolve({
      issuer: "https://accounts.google.com",
      email: "chat@system.gserviceaccount.com",
    });
  };
  return {
    verifyAuthorizationHeader(header) {
      if (header === null || !header.startsWith("Bearer ")) {
        return Promise.reject(new GoogleChatOidcVerificationError("Missing bearer token."));
      }
      return verifyBearerToken(header.slice("Bearer ".length));
    },
    verifyBearerToken,
  };
}

describe("Google Chat HTTP webhook endpoint", () => {
  it("rejects unauthorized requests with 401 and scrubs bearer secrets from failure logs", async () => {
    const secretToken = "canary-webhook-bearer-secret-token";
    const stream = new FailureLogStream();
    const source = createGoogleChatWebhookSource({
      projectId: "example-project",
      verifier: verifierAccepting("expected-valid-token"),
      accept: () =>
        Promise.resolve({
          status: "dropped",
          receiptId: "receipt-drop",
          reason: "no_project_route",
        }),
    });

    const response = await runWithFailureTracking(
      () =>
        source.handle(
          new Request("https://hub.example.com/api/integrations/google-chat/events", {
            method: "POST",
            headers: {
              authorization: `Bearer ${secretToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ type: "MESSAGE" }),
          }),
        ),
      createLogger(stream),
    );

    assert.equal(response.status, 401);
    assert.equal(stream.text().includes(secretToken), false);
  });

  it("returns 200 {} for valid events, 400 for malformed payloads, and 503 on handoff failures", async () => {
    const dispatched: DurableProviderEvent[] = [];
    let failAccept = false;
    const source = createGoogleChatWebhookSource({
      projectId: "example-project",
      verifier: verifierAccepting("valid-oidc-token"),
      accept: async (input) => {
        if (failAccept) {
          throw new Error("storage offline");
        }
        return {
          status: "accepted",
          receiptId: "receipt-1",
          events: [
            {
              providerEventReceiptId: "receipt-1",
              organizationId: "org-1",
              projectId: "proj-1",
              configurationRevisionId: "rev-1",
              source: input.source,
              deliveryId: input.deliveryId,
              receivedAt: input.receivedAt,
              payload: input.payload,
              connectionId: "conn-1",
              resourceId: input.projectId,
            },
          ],
        };
      },
    });
    await source.start(async (event) => {
      dispatched.push(event);
    });

    const validResponse = await source.handle(
      new Request("https://hub.example.com/api/integrations/google-chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-oidc-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "MESSAGE",
          space: { name: "spaces/AAAABBBB", type: "DM", singleUserBotDm: true },
          message: {
            name: "spaces/AAAABBBB/messages/msg-10",
            text: "check build",
            createTime: "2026-10-01T12:00:00.000Z",
            sender: {
              name: "users/1001",
              displayName: "Alice Example",
              email: "alice@example.com",
              type: "HUMAN",
            },
          },
        }),
      }),
    );
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), {});
    assert.equal(dispatched.length, 1);

    const invalidJsonResponse = await source.handle(
      new Request("https://hub.example.com/api/integrations/google-chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-oidc-token",
          "content-type": "application/json",
        },
        body: "{bad-json",
      }),
    );
    assert.equal(invalidJsonResponse.status, 400);

    const invalidEventResponse = await source.handle(
      new Request("https://hub.example.com/api/integrations/google-chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-oidc-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "MESSAGE" }),
      }),
    );
    assert.equal(invalidEventResponse.status, 400);

    failAccept = true;
    const unavailableResponse = await source.handle(
      new Request("https://hub.example.com/api/integrations/google-chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-oidc-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "MESSAGE",
          space: { name: "spaces/AAAABBBB", type: "DM", singleUserBotDm: true },
          message: {
            name: "spaces/AAAABBBB/messages/msg-11",
            text: "retry later",
            createTime: "2026-10-01T12:01:00.000Z",
            sender: {
              name: "users/1001",
              displayName: "Alice Example",
              type: "HUMAN",
            },
          },
        }),
      }),
    );
    assert.equal(unavailableResponse.status, 503);
  });
});
