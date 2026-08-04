import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createSlackBotClient } from "./client.js";

describe("Slack Web API client", () => {
  it("resolves the workspace token internally and checks Slack's ok field", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const authorities: Array<[string, string]> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: (organizationId, teamId) => {
        authorities.push([organizationId, teamId]);
        return Promise.resolve(
          organizationId === "org-1" && teamId === "T1" ? "xoxb-secret" : undefined,
        );
      },
      fetch: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Response.json({ ok: true });
      },
    });
    await client.sendMessage({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      content: "Hi",
    });
    assert.deepEqual(authorities, [["org-1", "T1"]]);
    assert.deepEqual(requests, [
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-secret",
        body: { channel: "C1", thread_ts: "1.1", text: "Hi" },
      },
    ]);

    const rejected = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () => Promise.resolve(Response.json({ ok: false, error: "ratelimited" })),
    });
    await assert.rejects(
      () =>
        rejected.addReaction({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "eyes",
        }),
      /Slack API ratelimited/u,
    );
  });

  it("fails closed without making a request when workspace ownership does not match", async () => {
    let fetches = 0;
    const client = createSlackBotClient({
      tokenForWorkspace: (organizationId, teamId) =>
        Promise.resolve(organizationId === "org-b" && teamId === "T1" ? "token-b" : undefined),
      fetch: () => {
        fetches += 1;
        return Promise.resolve(Response.json({ ok: true }));
      },
    });

    await assert.rejects(
      () =>
        client.removeReaction({
          organizationId: "org-a",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "eyes",
        }),
      /not connected/u,
    );
    assert.equal(fetches, 0);
  });

  it("aborts a Slack API call that does not respond before its deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      requestTimeoutMs: 5,
      fetch: (_input, init) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await assert.rejects(
      () =>
        client.addReaction({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "hourglass_flowing_sand",
        }),
      { name: "TimeoutError" },
    );
    assert.equal(requestSignal?.aborted, true);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}
