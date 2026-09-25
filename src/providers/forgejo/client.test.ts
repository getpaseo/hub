import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { createForgejoApiClient, ForgejoApiError, ForgejoRedirectRefusedError } from "./client.js";

describe("Forgejo API client", () => {
  it("authenticates with Forgejo's token scheme, not Bearer", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const client = createForgejoApiClient({
      fetch: stubFetch(seen, { login: "trillian", id: 1 }),
    });

    await client.readViewer({
      instanceBaseUrl: "https://git.example.test",
      accessToken: "s3cret",
    });

    assert.equal(seen[0]?.headers.get("authorization"), "token s3cret");
  });

  it("reads the instance's raw version string", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const client = createForgejoApiClient({
      fetch: stubFetch(seen, { version: "16.0.5+gitea-1.22.0" }),
    });

    const version = await client.readVersion({
      instanceBaseUrl: "https://git.example.test",
      accessToken: "t",
    });

    assert.equal(version.version, "16.0.5+gitea-1.22.0");
    assert.ok(seen[0]?.url.endsWith("/version"));
  });

  it("escapes an owner and repository before putting them in a path", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const client = createForgejoApiClient({ fetch: stubFetch(seen, { id: 7 }) });

    await client.createIssueComment({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets/../../admin",
      issueNumber: 42,
      body: "so long, and thanks for all the fish",
    });

    assert.ok(!seen[0]?.url.includes("/../"));
  });

  it("raises the instance's status when a call is refused", async () => {
    const response = new Response("nope", { status: 403 });
    const client = createForgejoApiClient({
      fetch: () => Promise.resolve(response),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
      /403/u,
    );
    // drained, not left dangling for undici to warn about or keep the socket from reuse
    assert.equal(response.bodyUsed, true);
  });

  it("carries the instance's own message onto a refused call's error", async () => {
    const client = createForgejoApiClient({
      fetch: () =>
        Promise.resolve(
          Response.json(
            { message: "Invalid url", url: "https://forgejo.example/api/swagger" },
            { status: 422 },
          ),
        ),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
      (error: unknown) =>
        error instanceof ForgejoApiError &&
        error.status === 422 &&
        error.detail === "Invalid url" &&
        error.message.includes("Invalid url"),
    );
  });

  it("leaves detail undefined when a refusal's body isn't the instance's error shape", async () => {
    const client = createForgejoApiClient({
      fetch: () => Promise.resolve(new Response("<html>nope</html>", { status: 500 })),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
      (error: unknown) => error instanceof ForgejoApiError && error.detail === undefined,
    );
  });

  it("drains a redirect's body instead of leaving it unread", async () => {
    const response = new Response("moved", {
      status: 302,
      headers: { location: "https://elsewhere.test" },
    });
    const client = createForgejoApiClient({
      fetch: () => Promise.resolve(response),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );
    assert.equal(response.bodyUsed, true);
  });

  it("drains a reaction call's body even when parseResponse is false", async () => {
    const response = Response.json({ ignored: true });
    const client = createForgejoApiClient({
      fetch: () => Promise.resolve(response),
    });

    await client.createReaction({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      subject: { kind: "item", issueNumber: 1 },
      content: "+1",
    });

    assert.equal(response.bodyUsed, true);
  });

  it("refuses a response body over the size cap instead of buffering it whole", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024 + 1);
    const client = createForgejoApiClient({
      fetch: () =>
        Promise.resolve(new Response(`{"login":"t","id":1,"pad":"${oversized}"}`, { status: 200 })),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
      /exceeded.*bytes/u,
    );
  });

  it("asks fetch never to follow a redirect", async () => {
    const seenInit: RequestInit[] = [];
    const client = createForgejoApiClient({
      fetch: (_input, init) => {
        seenInit.push(init ?? {});
        return Promise.resolve(Response.json({ login: "trillian", id: 1 }));
      },
    });

    await client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" });

    assert.equal(seenInit[0]?.redirect, "manual");
  });

  it("refuses a 3xx instead of treating it as an ordinary failure", async () => {
    const client = createForgejoApiClient({
      fetch: () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
        ),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
      (error: unknown) => error instanceof ForgejoRedirectRefusedError && error.status === 302,
    );
  });

  it("pages through the issue timeline until an empty page ends it", async () => {
    const pages = [
      [
        { id: 1, type: "comment" },
        { id: 2, type: "comment" },
      ],
      [{ id: 3, type: "comment" }],
      [],
    ];
    const seenPages: string[] = [];
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = url.searchParams.get("page") ?? "1";
        seenPages.push(page);
        return Promise.resolve(Response.json(pages[Number(page) - 1] ?? []));
      },
    });

    const entries = await client.listIssueTimeline({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 1,
      limit: 2,
    });

    assert.deepEqual(seenPages, ["1", "2", "3"]);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      [1, 2, 3],
    );
  });

  it("does not stop early on the issue timeline just because a page is shorter than asked for", async () => {
    const pages = [[{ id: 1, type: "comment" }], [{ id: 2, type: "comment" }], []];
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      },
    });

    const entries = await client.listIssueTimeline({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 1,
      limit: 50,
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      [1, 2],
    );
  });

  it("skips a malformed timeline entry instead of dropping its whole page", async () => {
    const pages = [
      // id: 99 is missing the required type field
      [{ id: 1, type: "comment" }, { id: 99 }, { id: 2, type: "comment" }],
      [{ id: 3, type: "comment" }],
      [],
    ];
    const client = createForgejoApiClient({
      fetch: (input) => {
        const page = Number(new URL(requestUrl(input)).searchParams.get("page") ?? "1");
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      },
    });

    const entries = await client.listIssueTimeline({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 1,
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      [1, 2, 3],
    );
  });

  it("parses a timeline entry's created_at to epoch ms regardless of its offset", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const page = new URL(requestUrl(input)).searchParams.get("page") ?? "1";
        return Promise.resolve(
          Response.json(
            page === "1"
              ? [{ id: 1, type: "comment", created_at: "2026-09-25T04:59:30-07:00" }]
              : [],
          ),
        );
      },
    });

    const [entry] = await client.listIssueTimeline({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 1,
    });

    assert.equal(entry?.createdAtMs, Date.parse("2026-09-25T11:59:30.000Z"));
  });

  it("carries a review's state and updated_at", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const page = new URL(requestUrl(input)).searchParams.get("page") ?? "1";
        return Promise.resolve(
          Response.json(
            page === "1"
              ? [
                  {
                    id: 501,
                    user: { login: "trillian" },
                    state: "APPROVED",
                    submitted_at: "2026-09-25T11:50:00-07:00",
                    updated_at: "2026-09-25T04:59:30-07:00",
                    body: "looks good",
                  },
                ]
              : [],
          ),
        );
      },
    });

    const [review] = await client.listPullReviews({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 2,
    });

    assert.equal(review?.state, "APPROVED");
    assert.equal(review?.updatedAtMs, Date.parse("2026-09-25T11:59:30.000Z"));
    assert.equal(review?.body, "looks good");
  });

  it("reports which side of the diff a review comment's line is on", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = requestUrl(input);
        const page = new URL(url).searchParams.get("page") ?? "1";
        if (page !== "1") return Promise.resolve(Response.json([]));
        return Promise.resolve(
          Response.json([
            { id: 1, body: "on the new side", position: 3, original_position: 0 },
            { id: 2, body: "on the old side", position: 0, original_position: 7 },
            { id: 3, body: "a general comment", position: 0, original_position: 0 },
          ]),
        );
      },
    });

    const comments = await client.listPullReviewComments({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 2,
      reviewId: 501,
    });

    assert.deepEqual(
      comments.map((comment) => ({ line: comment.line, side: comment.side })),
      [
        { line: 3, side: "RIGHT" },
        { line: 7, side: "LEFT" },
        { line: undefined, side: undefined },
      ],
    );
  });

  it("fetches review comments in one request, since forgejo ignores page/limit on that endpoint", async () => {
    // stub hands back the same list regardless of any page query string, like the real endpoint
    const requests: string[] = [];
    const client = createForgejoApiClient({
      fetch: (input) => {
        requests.push(requestUrl(input));
        return Promise.resolve(
          Response.json([
            { id: 1, body: "first" },
            { id: 2, body: "second" },
          ]),
        );
      },
    });

    const comments = await client.listPullReviewComments({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      issueNumber: 2,
      reviewId: 501,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(
      comments.map((comment) => comment.id),
      [1, 2],
    );
  });

  it("lists the organizations the token's own account belongs to", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = url.searchParams.get("page") ?? "1";
        return Promise.resolve(
          Response.json(page === "1" ? [{ username: "acme" }, { username: "vogon" }] : []),
        );
      },
    });

    const orgs = await client.listMyOrgs({
      instanceBaseUrl: "https://git.example.test",
      accessToken: "t",
    });

    assert.deepEqual(orgs, [{ username: "acme" }, { username: "vogon" }]);
  });

  it("pages through the org listing past a short first page", async () => {
    const pages = [[{ username: "acme" }], [{ username: "vogon" }], []];
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      },
    });

    const orgs = await client.listMyOrgs({
      instanceBaseUrl: "https://git.example.test",
      accessToken: "t",
    });

    assert.deepEqual(orgs, [{ username: "acme" }, { username: "vogon" }]);
  });

  it("stops paging the org listing once a page repeats the previous page's ids", async () => {
    const requests: string[] = [];
    const client = createForgejoApiClient({
      fetch: (input) => {
        requests.push(requestUrl(input));
        return Promise.resolve(Response.json([{ username: "acme" }, { username: "vogon" }]));
      },
    });

    const orgs = await client.listMyOrgs({
      instanceBaseUrl: "https://git.example.test",
      accessToken: "t",
    });

    assert.deepEqual(orgs, [{ username: "acme" }, { username: "vogon" }]);
    assert.equal(requests.length, 2);
  });

  it("posts a hook with no branch filter and exactly the requested events", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const client = createForgejoApiClient({
      fetch: (input, init) => {
        seen.push({ url: requestUrl(input), body: requestJsonBody(init) });
        return Promise.resolve(Response.json({ id: 7 }));
      },
    });

    const created = await client.createHook(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "user" },
      { url: "https://hub.example.test/capture", secret: "shh", events: ["issues", "push"] },
    );

    assert.equal(created.id, 7);
    const sent = seen[0];
    assert.ok(sent !== undefined);
    assert.equal(sent.url, "https://git.example.test/api/v1/user/hooks");
    assert.deepEqual(sent.body, {
      type: "gitea",
      active: true,
      config: { url: "https://hub.example.test/capture", content_type: "json", secret: "shh" },
      events: ["issues", "push"],
    });
    assert.ok(!("branch_filter" in sent.body));
  });

  it("posts the gitea hook type so a real Gitea instance accepts it", async () => {
    const seen: { body: Record<string, unknown> }[] = [];
    const client = createForgejoApiClient({
      fetch: (_input, init) => {
        seen.push({ body: requestJsonBody(init) });
        return Promise.resolve(Response.json({ id: 1 }));
      },
    });

    await client.createHook(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "user" },
      { url: "https://hub.example.test/capture", secret: "shh", events: ["push"] },
    );

    assert.equal(seen[0]?.body["type"], "gitea");
  });

  it("posts an org hook to the organization's own hooks path", async () => {
    const seen: string[] = [];
    const client = createForgejoApiClient({
      fetch: (input) => {
        seen.push(requestUrl(input));
        return Promise.resolve(Response.json({ id: 1 }));
      },
    });

    await client.createHook(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "org", org: "acme" },
      { url: "https://hub.example.test/capture", secret: "shh", events: ["push"] },
    );

    assert.equal(seen[0], "https://git.example.test/api/v1/orgs/acme/hooks");
  });

  it("pages through a hook listing until an empty page ends it", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        // A full first page, so the loop must fetch a second; an empty third page ends it.
        const pageCounts = [limit, 1, 0];
        const count = pageCounts[page - 1] ?? 0;
        const hooks = Array.from({ length: count }, (_, index) => ({
          id: (page - 1) * limit + index + 1,
        }));
        return Promise.resolve(Response.json(hooks));
      },
    });

    const hooks = await client.listHooks(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "user" },
    );

    assert.equal(hooks.length, 51);
    assert.equal(hooks[0]?.id, 1);
    assert.equal(hooks[50]?.id, 51);
  });

  it("does not stop early on a hook listing just because a page is shorter than the requested limit", async () => {
    const pages = [[{ id: 1 }], [{ id: 2 }], []];
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      },
    });

    const hooks = await client.listHooks(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "user" },
    );

    assert.deepEqual(
      hooks.map((hook) => hook.id),
      [1, 2],
    );
  });

  it("throws on a non-array hook listing body instead of treating it as no hooks", async () => {
    const client = createForgejoApiClient({
      fetch: () => Promise.resolve(Response.json({ error: "not what you expected" })),
    });

    await assert.rejects(
      client.listHooks(
        { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
        { scope: "user" },
      ),
    );
  });

  it("carries a reused hook's active flag and event list back for the idempotency check", async () => {
    const client = createForgejoApiClient({
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        const page = url.searchParams.get("page") ?? "1";
        return Promise.resolve(
          Response.json(page === "1" ? [{ id: 4, active: false, events: ["issue_comment"] }] : []),
        );
      },
    });

    const hooks = await client.listHooks(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "user" },
    );

    assert.deepEqual(hooks[0], {
      id: 4,
      url: undefined,
      active: false,
      events: ["issue_comment"],
    });
  });

  it("deletes a hook without choking on the empty 204 body", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const client = createForgejoApiClient({
      fetch: (input, init) => {
        seen.push({ url: requestUrl(input), method: init?.method });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await client.deleteHook(
      { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      { scope: "org", org: "acme" },
      7,
    );

    assert.equal(seen[0]?.url, "https://git.example.test/api/v1/orgs/acme/hooks/7");
    assert.equal(seen[0]?.method, "DELETE");
  });

  it("reacts to the issue itself for an item subject", async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = createForgejoApiClient({
      fetch: (input, init) => {
        seen.push({ url: requestUrl(input), method: init?.method, body: requestJsonBody(init) });
        return Promise.resolve(
          Response.json({ user: { login: "paseo" }, content: "eyes", created_at: "2026-01-01" }),
        );
      },
    });

    await client.createReaction({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      subject: { kind: "item", issueNumber: 42 },
      content: "eyes",
    });

    assert.equal(
      seen[0]?.url,
      "https://git.example.test/api/v1/repos/acme/widgets/issues/42/reactions",
    );
    assert.equal(seen[0]?.method, "POST");
    assert.deepEqual(seen[0]?.body, { content: "eyes" });
  });

  it("reacts to a comment for a comment subject", async () => {
    const seen: { url: string }[] = [];
    const client = createForgejoApiClient({
      fetch: (input) => {
        seen.push({ url: requestUrl(input) });
        return Promise.resolve(
          Response.json({ user: { login: "paseo" }, content: "+1", created_at: "2026-01-01" }),
        );
      },
    });

    await client.createReaction({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      subject: { kind: "issue_comment", commentId: 123 },
      content: "+1",
    });

    assert.equal(
      seen[0]?.url,
      "https://git.example.test/api/v1/repos/acme/widgets/issues/comments/123/reactions",
    );
  });

  it("deletes a reaction by content, since Forgejo's reaction has no id", async () => {
    const seen: { method: string | undefined; body: unknown }[] = [];
    const client = createForgejoApiClient({
      fetch: (_input, init) => {
        seen.push({ method: init?.method, body: requestJsonBody(init) });
        // changeIssueReaction answers a delete with ctx.Status(200) and no body.
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });

    await client.deleteReaction({
      credentials: { instanceBaseUrl: "https://git.example.test", accessToken: "t" },
      owner: "acme",
      repo: "widgets",
      subject: { kind: "item", issueNumber: 42 },
      content: "eyes",
    });

    assert.equal(seen[0]?.method, "DELETE");
    assert.deepEqual(seen[0]?.body, { content: "eyes" });
  });
});

function stubFetch(seen: { url: string; headers: Headers }[], payload: unknown): typeof fetch {
  return (input, init) => {
    seen.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
    return Promise.resolve(Response.json(payload));
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = typeof init?.body === "string" ? init.body : "{}";
  return z.record(z.string(), z.unknown()).parse(JSON.parse(body));
}
