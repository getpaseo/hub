import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import type { GoogleAccessTokenSource } from "../../providers/google-chat/auth.js";
import {
  GoogleChatPubSubError,
  createGoogleChatPubSubSource,
  normalizePubSubSubscriptionName,
  verifyGoogleChatPubSubSubscription,
} from "./pubsub.js";

function fakeTokenSource(): GoogleAccessTokenSource {
  return {
    projectId: "example-project",
    clientEmail: "paseo-bot@example-project.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("test-oauth-pubsub-token"),
  };
}

function sampleChatPayload(text: string) {
  return {
    type: "MESSAGE",
    space: { name: "spaces/AAAABBBB", type: "DM", singleUserBotDm: true },
    message: {
      name: "spaces/AAAABBBB/messages/msg-1",
      text,
      createTime: "2026-10-01T12:00:00.000Z",
      thread: { name: "spaces/AAAABBBB/threads/thread-1" },
      sender: {
        name: "users/1001",
        displayName: "Alice Example",
        email: "alice@example.com",
        type: "HUMAN",
      },
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("Google Chat Cloud Pub/Sub transport", () => {
  it("normalizes bare subscription IDs and validates resource names", async () => {
    assert.equal(
      normalizePubSubSubscriptionName("example-project", "chat-events"),
      "projects/example-project/subscriptions/chat-events",
    );
    assert.equal(
      normalizePubSubSubscriptionName(
        "example-project",
        "projects/other-project/subscriptions/custom",
      ),
      "projects/other-project/subscriptions/custom",
    );

    const requestedUrls: string[] = [];
    await verifyGoogleChatPubSubSubscription({
      subscription: "chat-events",
      tokenSource: fakeTokenSource(),
      fetch: async (input) => {
        requestedUrls.push(requestUrl(input));
        return Response.json({ permissions: ["pubsub.subscriptions.consume"] });
      },
    });
    assert.deepEqual(requestedUrls, [
      "https://pubsub.googleapis.com/v1/projects/example-project/subscriptions/chat-events:testIamPermissions",
    ]);

    await assert.rejects(
      () =>
        verifyGoogleChatPubSubSubscription({
          subscription: "chat-events",
          tokenSource: fakeTokenSource(),
          fetch: async () => Response.json({ permissions: [] }),
        }),
      (error: unknown) =>
        error instanceof GoogleChatPubSubError && error.code === "permissionMissing",
    );

    await assert.rejects(
      () =>
        verifyGoogleChatPubSubSubscription({
          subscription: "projects/example-project/topics/not-a-subscription",
          tokenSource: fakeTokenSource(),
          fetch: async () => Response.json({}),
        }),
      GoogleChatPubSubError,
    );
  });

  it("pulls messages, routes accepted events, acks malformed payloads, and Withholds ack on handoff error", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const acknowledgedBatches: string[][] = [];
    let pullCount = 0;
    let markSecondPullReached = () => {};
    const secondPullReached = new Promise<void>((resolve) => {
      markSecondPullReached = resolve;
    });

    const validEncoded = Buffer.from(JSON.stringify(sampleChatPayload("ship it")), "utf8").toString(
      "base64",
    );
    const transientFailEncoded = Buffer.from(
      JSON.stringify({
        ...sampleChatPayload("fail transiently"),
        message: {
          ...sampleChatPayload("fail transiently").message,
          name: "spaces/AAAABBBB/messages/msg-2",
        },
      }),
      "utf8",
    ).toString("base64");
    const malformedEncoded = Buffer.from("{not-valid-json", "utf8").toString("base64");

    const source = createGoogleChatPubSubSource({
      projectId: "example-project",
      subscription: "chat-events",
      tokenSource: fakeTokenSource(),
      accept: async (input): Promise<ProviderEventAcceptance> => {
        if (input.deliveryId.endsWith("msg-2")) {
          throw new Error("database unavailable");
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
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith(":pull")) {
          pullCount += 1;
          if (pullCount === 1) {
            return Response.json({
              receivedMessages: [
                {
                  ackId: "ack-valid",
                  message: { messageId: "m-1", data: validEncoded },
                },
                {
                  ackId: "ack-malformed",
                  message: { messageId: "m-2", data: malformedEncoded },
                },
                {
                  ackId: "ack-transient-error",
                  message: { messageId: "m-3", data: transientFailEncoded },
                },
              ],
            });
          }
          markSecondPullReached();
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const abortError = new Error("Aborted");
                abortError.name = "AbortError";
                reject(abortError);
              },
              { once: true },
            );
          });
          return Response.json({});
        }
        if (url.endsWith(":acknowledge")) {
          const rawBody = typeof init?.body === "string" ? init.body : "{}";
          const parsedBody: unknown = JSON.parse(rawBody);
          if (
            typeof parsedBody === "object" &&
            parsedBody !== null &&
            "ackIds" in parsedBody &&
            Array.isArray(parsedBody.ackIds)
          ) {
            acknowledgedBatches.push(parsedBody.ackIds.map(String));
          }
          return Response.json({});
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });

    await source.start(async (event) => {
      dispatched.push(event);
    });

    await secondPullReached;
    await source.stop();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.deliveryId, "google-chat-spaces/AAAABBBB/messages/msg-1");
    assert.deepEqual(acknowledgedBatches, [["ack-valid", "ack-malformed"]]);
  });
});
