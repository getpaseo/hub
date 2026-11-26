import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { z } from "zod";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  callIntegrationTool,
  IntegrationToolError,
  integrationToolDefinitions,
} from "../../integration-tools/index.js";
import { createBrowserIntegrationRegistry } from "../browser-registry.js";
import { createIntegrationRegistry } from "../registry.js";
import { notionBrowserIntegration } from "./browser.js";
import { notionIntegration } from "./index.js";
import {
  normalizeNotionUuid,
  NotionToolGrantSchema,
  normalizeNotionToolGrant,
} from "./internal/contracts.js";
import { createNotionClient, NotionApiError } from "./internal/client.js";

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function parseBodyRecord(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Notion UUID & URL normalization + grant schema", () => {
  it("normalizes dashed UUIDs, 32-hex IDs, notion.so/notion.site URLs, and ?p= peek URLs", () => {
    assert.equal(
      normalizeNotionUuid("248104cd-477e-80af-bc30-000bd28de8f9"),
      "248104cd-477e-80af-bc30-000bd28de8f9",
    );
    assert.equal(
      normalizeNotionUuid("248104CD477E80AFBC30000BD28DE8F9"),
      "248104cd-477e-80af-bc30-000bd28de8f9",
    );
    assert.equal(
      normalizeNotionUuid("https://www.notion.so/My-Spec-153104cd477e809d8dc4ff2d96ae3090?pvs=4"),
      "153104cd-477e-809d-8dc4-ff2d96ae3090",
    );
    assert.equal(
      normalizeNotionUuid(
        "https://acme.notion.site/workspace/248104cd477e80afbc30000bd28de8f9?v=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&p=153104cd477e809d8dc4ff2d96ae3090&pm=s",
      ),
      "153104cd-477e-809d-8dc4-ff2d96ae3090",
    );
    assert.equal(normalizeNotionUuid("not-a-notion-id"), undefined);
    assert.equal(
      normalizeNotionUuid("https://example.com/153104cd477e809d8dc4ff2d96ae3090"),
      undefined,
    );
  });

  it("enforces at least 1 target, max 50 targets, and normalizes grants canonically", () => {
    assert.equal(
      NotionToolGrantSchema.safeParse({
        connection: "eng-notion",
        actions: ["read"],
      }).success,
      false,
    );

    const fiftyOne = Array.from(
      { length: 51 },
      (_, i) => `248104cd-477e-80af-bc30-${String(i).padStart(12, "0")}`,
    );
    assert.equal(
      NotionToolGrantSchema.safeParse({
        connection: "eng-notion",
        actions: ["read"],
        pages: fiftyOne,
      }).success,
      false,
    );

    const parsed = NotionToolGrantSchema.parse({
      connection: "eng-notion",
      actions: ["write", "read", "write"],
      data_sources: ["https://www.notion.so/acme/248104cd477e80afbc30000bd28de8f9?v=123"],
      pages: ["153104CD477E809D8DC4FF2D96AE3090"],
    });
    assert.deepEqual(normalizeNotionToolGrant(parsed), {
      connection: "eng-notion",
      actions: ["read", "write"],
      data_sources: ["248104cd-477e-80af-bc30-000bd28de8f9"],
      pages: ["153104cd-477e-809d-8dc4-ff2d96ae3090"],
    });
  });
});

describe("Notion API client (2026-03-11, concurrency, 429/529, 503 safety)", () => {
  it("pins Notion-Version: 2026-03-11 and caps per-connection concurrency at 3", async () => {
    let active = 0;
    let maxActive = 0;
    const versions: string[] = [];
    const client = createNotionClient({
      fetch: async (_url, init) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const headers = new Headers(init?.headers);
        versions.push(headers.get("Notion-Version") ?? "");
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return jsonResponse({ ok: true });
      },
      sleep: async () => {},
    });

    await Promise.all(
      Array.from({ length: 8 }, () =>
        client.request({
          connectionKey: "conn-1",
          token: "ntn_secret",
          method: "GET",
          path: "/users/me",
        }),
      ),
    );

    assert.equal(maxActive, 3);
    assert.equal(
      versions.every((v) => v === "2026-03-11"),
      true,
    );
  });

  it("retries 429 and 529 with Retry-After up to 2 retries", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const client = createNotionClient({
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ code: "rate_limited" }, 429, { "retry-after": "1" });
        }
        if (attempts === 2) {
          return jsonResponse({ code: "service_unavailable" }, 529, { "retry-after": "2" });
        }
        return jsonResponse({ id: "ok" }, 200);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await client.request({
      connectionKey: "conn-1",
      token: "ntn_secret",
      method: "GET",
      path: "/pages/123",
    });
    assert.deepEqual(res, { id: "ok" });
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1000, 2000]);

    // Exhausts after 2 retries (3 total attempts)
    let failAttempts = 0;
    const failingClient = createNotionClient({
      fetch: async () => {
        failAttempts += 1;
        return jsonResponse({ code: "rate_limited" }, 429, { "retry-after": "0" });
      },
      sleep: async () => {},
    });
    await assert.rejects(
      failingClient.request({
        connectionKey: "conn-1",
        token: "ntn_secret",
        method: "GET",
        path: "/pages/123",
      }),
      (err: unknown) => err instanceof NotionApiError && err.status === 429,
    );
    assert.equal(failAttempts, 3);
  });

  it("never blind-retries 503 writes unless additional_data.retry_guidance permits", async () => {
    let blindCalls = 0;
    const blindClient = createNotionClient({
      fetch: async () => {
        blindCalls += 1;
        return jsonResponse({ code: "service_unavailable", message: "try later" }, 503);
      },
      sleep: async () => {},
    });
    await assert.rejects(
      blindClient.request({
        connectionKey: "conn-1",
        token: "ntn_secret",
        method: "PATCH",
        path: "/pages/123",
        body: { properties: {} },
      }),
      (err: unknown) => err instanceof NotionApiError && err.status === 503,
    );
    assert.equal(blindCalls, 1);

    let guidedCalls = 0;
    const guidedClient = createNotionClient({
      fetch: async () => {
        guidedCalls += 1;
        if (guidedCalls === 1) {
          return jsonResponse(
            {
              code: "service_unavailable",
              additional_data: { retry_guidance: { safe_to_retry: true } },
            },
            503,
          );
        }
        return jsonResponse({ id: "page-1" }, 200);
      },
      sleep: async () => {},
    });
    const result = await guidedClient.request({
      connectionKey: "conn-1",
      token: "ntn_secret",
      method: "POST",
      path: "/comments",
      body: { parent: { page_id: "page-1" }, markdown: "hi", markdown_version: "v2" },
    });
    assert.deepEqual(result, { id: "page-1" });
    assert.equal(guidedCalls, 2);
  });
});

describe("Notion dual auth & browser contract", () => {
  it("aligns server and browser definitions and hides org Connect in internal mode", () => {
    const serverRegistry = createIntegrationRegistry([notionIntegration]);
    const browserRegistry = createBrowserIntegrationRegistry([notionBrowserIntegration]);
    assert.equal(serverRegistry.get("notion")?.id, "notion");
    assert.equal(
      browserRegistry.get("notion")?.setup.supportsOrgConnect?.({ mode: "internal" }),
      false,
    );
    assert.equal(
      browserRegistry.get("notion")?.setup.supportsOrgConnect?.({ mode: "oauth" }),
      true,
    );
    const glyphMarkup = renderToStaticMarkup(
      createElement(notionBrowserIntegration.glyph, { className: "size-4.5" }),
    );
    assert.match(glyphMarkup, /fill="currentColor"/u);
  });

  it("verifies Internal Connection via GET /v1/users/me and rejects invalid tokens", async () => {
    const validResult = await notionIntegration.connection.verifyDirect!(
      { provider: "notion", mode: "internal", apiToken: "ntn_valid" },
      {
        callbackOrigin: "http://127.0.0.1:3000",
        now: () => new Date(),
        fetch: async (url, init) => {
          assert.equal(requestUrl(url).toString(), "https://api.notion.com/v1/users/me");
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), "Bearer ntn_valid");
          assert.equal(headers.get("Notion-Version"), "2026-03-11");
          return jsonResponse({
            object: "user",
            id: "11111111-1111-4111-8111-111111111111",
            type: "bot",
            name: "Paseo",
            bot: {
              owner: { type: "workspace", workspace: true },
              workspace_id: "22222222-2222-4222-8222-222222222222",
              workspace_name: "Eng Workspace",
            },
          });
        },
      },
    );
    assert.ok(validResult);
    assert.equal(validResult.identity.id, "internal:11111111-1111-4111-8111-111111111111");
    assert.equal(validResult.identity.name, "Eng Workspace");
    assert.equal(
      validResult.initialConnection?.externalId,
      "22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111",
    );
    assert.equal(
      validResult.initialConnection?.workspaceId,
      "22222222-2222-4222-8222-222222222222",
    );

    await assert.rejects(
      notionIntegration.connection.verifyDirect!(
        { provider: "notion", mode: "internal", apiToken: "ntn_bad" },
        {
          callbackOrigin: "http://127.0.0.1:3000",
          now: () => new Date(),
          fetch: async () => jsonResponse({ status: 401, code: "unauthorized" }, 401),
        },
      ),
      (err: unknown) =>
        err instanceof Error &&
        Reflect.get(err, "reason") === "credentialsRejected" &&
        Reflect.get(err, "subject") === "botToken",
    );
  });
});

describe("Notion 5 scoped MCP tools & 6-hop allowlist", () => {
  const WS_ID = "22222222-2222-4222-8222-222222222222";
  const BOT_ID = "11111111-1111-4111-8111-111111111111";
  const DS_GRANTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ROOT_PAGE_GRANTED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OUT_PAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function makeHopChain(
    hops: number,
  ): Record<string, { id: string; parent: Record<string, unknown>; title: string }> {
    const pages: Record<string, { id: string; parent: Record<string, unknown>; title: string }> =
      {};
    for (let i = 1; i <= hops; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const parentId =
        i === 1 ? ROOT_PAGE_GRANTED : `00000000-0000-4000-8000-${String(i - 1).padStart(12, "0")}`;
      pages[id] = {
        id,
        parent: { type: "page_id", page_id: parentId },
        title: `Hop ${i}`,
      };
    }
    return pages;
  }

  it("executes all 5 tools, enforces 6-hop allowlist, and rejects out-of-grant targets", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org-1"] });
    const conn = await database.integrations.bind({
      organizationId: "org-1",
      connectedByUserId: "user-1",
      provider: "notion",
      providerApplicationId: `internal:${BOT_ID}`,
      externalId: `${WS_ID}:${BOT_ID}`,
      workspaceId: WS_ID,
      displayName: "Eng Workspace",
      credentials: { mode: "internal", accessToken: "ntn_secret" },
      metadata: {
        mode: "internal",
        botId: BOT_ID,
        workspaceId: WS_ID,
        workspaceName: "Eng Workspace",
      },
    });

    const chain = makeHopChain(7);
    const hop6Id = "00000000-0000-4000-8000-000000000006";
    const hop7Id = "00000000-0000-4000-8000-000000000007";
    const postedComments: unknown[] = [];
    const updatedPages: unknown[] = [];
    const updatedMarkdown: unknown[] = [];

    const handlePageGet = (pathname: string): Response | undefined => {
      if (pathname === `/v1/pages/${ROOT_PAGE_GRANTED}` || pathname === `/v1/pages/${OUT_PAGE}`) {
        const id = pathname.slice("/v1/pages/".length);
        return jsonResponse({
          id,
          url: `https://www.notion.so/${id.replaceAll("-", "")}`,
          parent: { type: "workspace", workspace: true },
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: id === ROOT_PAGE_GRANTED ? "Root Spec" : "Secret Page" }],
            },
          },
        });
      }
      const hopMatch = /^\/v1\/pages\/(00000000-0000-4000-8000-\d{12})$/u.exec(pathname);
      if (!hopMatch) return undefined;
      const page = chain[hopMatch[1]!]!;
      return jsonResponse({
        id: page.id,
        url: `https://www.notion.so/${page.id.replaceAll("-", "")}`,
        parent: page.parent,
        properties: { title: { type: "title", title: [{ plain_text: page.title }] } },
      });
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";

      if (method === "GET") {
        const pageRes = handlePageGet(url.pathname);
        if (pageRes !== undefined) return pageRes;
      }
      if (url.pathname === `/v1/pages/${hop6Id}/markdown` && method === "GET") {
        return jsonResponse({
          markdown: "# Hop 6\n\nBody text",
          truncated: false,
          unknown_block_ids: [],
        });
      }
      if (url.pathname === `/v1/pages/${hop6Id}/markdown` && method === "PATCH") {
        updatedMarkdown.push(parseBodyRecord(init));
        return jsonResponse({ markdown: "# Hop 6\n\nUpdated text", warnings: [] });
      }
      if (url.pathname === `/v1/pages/${hop6Id}` && method === "PATCH") {
        updatedPages.push(parseBodyRecord(init));
        return jsonResponse({ id: hop6Id, url: `https://www.notion.so/${hop6Id}` });
      }
      if (url.pathname === "/v1/comments" && method === "GET") {
        return jsonResponse({
          results: [{ id: "c-1", discussion_id: "d-1", rich_text: [{ plain_text: "First" }] }],
        });
      }
      if (url.pathname === "/v1/comments" && method === "POST") {
        const body = parseBodyRecord(init);
        postedComments.push(body);
        const discussionId =
          typeof body["discussion_id"] === "string" ? body["discussion_id"] : "d-new";
        return jsonResponse({
          id: "c-new",
          discussion_id: discussionId,
          created_time: "2026-11-26T00:00:00.000Z",
        });
      }
      if (url.pathname === `/v1/data_sources/${DS_GRANTED}` && method === "GET") {
        return jsonResponse({
          id: DS_GRANTED,
          title: [{ plain_text: "Tasks" }],
          properties: { Status: { type: "status" } },
        });
      }
      if (url.pathname === `/v1/data_sources/${DS_GRANTED}/query` && method === "POST") {
        return jsonResponse({
          results: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              url: "https://www.notion.so/task-1",
              properties: { Name: { type: "title", title: [{ plain_text: "Fix bug" }] } },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      return jsonResponse({ code: "object_not_found" }, 404);
    };

    const serverRegistry = createIntegrationRegistry([notionIntegration]);
    const grant = {
      connection: conn.slug,
      actions: ["read", "comment", "write"] as const,
      data_sources: [DS_GRANTED],
      pages: [ROOT_PAGE_GRANTED],
    };

    const defs = integrationToolDefinitions({ notion: grant }, serverRegistry);
    assert.deepEqual(
      defs.map((d) => d.name),
      [
        "notion_list_targets",
        "notion_read_page",
        "notion_query_database",
        "notion_comment",
        "notion_update_page",
      ],
    );

    const commentDef = defs.find((d) => d.name === "notion_comment")!;
    assert.match(commentDef.description, /inline/iu);

    const handler = notionIntegration.tools!.createHandler(
      { provider: "notion", mode: "internal", apiToken: "ntn_secret" },
      {
        database,
        auth: {
          handle: async () => new Response(),
          resolveAccount: async () => {
            throw new Error("unused");
          },
          resolveOrganizationAccess: async () => {
            throw new Error("unused");
          },
          resources: async () => {
            throw new Error("unused");
          },
          rejectCookieMutation: () => undefined,
          close: async () => {},
        },
        callbackOrigin: "http://127.0.0.1:3000",
        identity: { provider: "notion", id: `internal:${BOT_ID}`, name: "Eng Workspace" },
        configurationVersion: 1,
        fetch: mockFetch,
        now: () => new Date(),
        ingest: { enqueue: async () => ({ status: "accepted" }) },
      },
    );

    const call = (name: string, args: Record<string, unknown>) =>
      callIntegrationTool({
        name,
        organizationId: "org-1",
        grants: { notion: grant },
        handlers: { registered: { notion: handler } },
        args,
        registry: serverRegistry,
      });

    // 1. notion_list_targets
    const listed = await call("notion_list_targets", {});
    assert.deepEqual(listed?.value, {
      data_sources: [{ id: DS_GRANTED }],
      pages: [{ id: ROOT_PAGE_GRANTED }],
    });

    // 2. notion_read_page within 6 hops succeeds
    const read6 = z
      .object({ id: z.string(), markdown: z.string(), comments: z.array(z.unknown()) })
      .parse(
        (
          await call("notion_read_page", {
            page: hop6Id,
            include_comments: true,
          })
        )?.value,
      );
    assert.equal(read6.id, hop6Id);
    assert.equal(read6.markdown, "# Hop 6\n\nBody text");
    assert.equal(read6.comments.length, 1);

    // 7 hops exceeds 6-hop cap and is rejected!
    await assert.rejects(
      call("notion_read_page", { page: hop7Id }),
      (err: unknown) => err instanceof IntegrationToolError && /outside.*scope/iu.test(err.message),
    );

    // Out-of-grant page rejected
    await assert.rejects(
      call("notion_read_page", { page: OUT_PAGE }),
      (err: unknown) => err instanceof IntegrationToolError && /outside.*scope/iu.test(err.message),
    );

    // 3. notion_query_database
    const queried = z.object({ results: z.array(z.unknown()) }).parse(
      (
        await call("notion_query_database", {
          data_source: DS_GRANTED,
          page_size: 10,
        })
      )?.value,
    );
    assert.equal(queried.results.length, 1);

    // Out-of-grant data_source rejected
    await assert.rejects(
      call("notion_query_database", { data_source: OUT_PAGE }),
      (err: unknown) => err instanceof IntegrationToolError && /outside.*scope/iu.test(err.message),
    );

    // 4. notion_comment
    await call("notion_comment", {
      page: hop6Id,
      markdown: "Looks **good** [Open in Paseo](https://hub.test/1)",
      discussion_id: "d-1",
    });
    assert.equal(postedComments.length, 1);
    assert.deepEqual(postedComments[0], {
      discussion_id: "d-1",
      markdown: "Looks **good** [Open in Paseo](https://hub.test/1)",
      markdown_version: "v2",
    });

    // 5. notion_update_page (properties + markdown patch)
    await call("notion_update_page", {
      page: hop6Id,
      properties: { Status: { status: { name: "Done" } } },
      content_updates: [{ old_str: "Body text", new_str: "Updated text" }],
    });
    assert.equal(updatedPages.length, 1);
    assert.equal(updatedMarkdown.length, 1);
  });

  it("serializes reactive refresh-on-401 via withRefreshLock and sets requires_reauthorization on invalid_grant", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org-1"] });
    const conn = await database.integrations.bind({
      organizationId: "org-1",
      connectedByUserId: "user-1",
      provider: "notion",
      providerApplicationId: "notion-client-1",
      externalId: `${WS_ID}:${BOT_ID}`,
      workspaceId: WS_ID,
      displayName: "OAuth Workspace",
      credentials: {
        mode: "oauth",
        accessToken: "expired-token",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: null,
        botId: BOT_ID,
        workspaceId: WS_ID,
      },
      metadata: {
        mode: "oauth",
        botId: BOT_ID,
        workspaceId: WS_ID,
        workspaceName: "OAuth Workspace",
      },
    });

    let refreshCalls = 0;
    let shouldInvalidGrant = false;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      if (url.pathname === "/v1/oauth/token") {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (shouldInvalidGrant) {
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        return jsonResponse({
          access_token: "fresh-token",
          refresh_token: "refresh-2",
          expires_in: 3600,
          bot_id: BOT_ID,
          workspace_id: WS_ID,
          workspace_name: "OAuth Workspace",
        });
      }
      if (headers.get("authorization") !== "Bearer fresh-token") {
        return jsonResponse({ code: "unauthorized" }, 401);
      }
      if (url.pathname === `/v1/pages/${ROOT_PAGE_GRANTED}`) {
        return jsonResponse({
          id: ROOT_PAGE_GRANTED,
          url: "https://www.notion.so/root",
          parent: { type: "workspace", workspace: true },
          properties: { title: { type: "title", title: [{ plain_text: "Root" }] } },
        });
      }
      if (url.pathname === `/v1/pages/${ROOT_PAGE_GRANTED}/markdown`) {
        return jsonResponse({ markdown: "Fresh content", truncated: false, unknown_block_ids: [] });
      }
      return jsonResponse({ code: "not_found" }, 404);
    };

    const handler = notionIntegration.tools!.createHandler(
      {
        provider: "notion",
        mode: "oauth",
        clientId: "notion-client-1",
        clientSecret: "notion-secret-1",
      },
      {
        database,
        auth: {
          handle: async () => new Response(),
          resolveAccount: async () => {
            throw new Error("unused");
          },
          resolveOrganizationAccess: async () => {
            throw new Error("unused");
          },
          resources: async () => {
            throw new Error("unused");
          },
          rejectCookieMutation: () => undefined,
          close: async () => {},
        },
        callbackOrigin: "https://hub.test",
        identity: { provider: "notion", id: "notion-client-1", name: "Notion app" },
        configurationVersion: 1,
        fetch: mockFetch,
        now: () => new Date("2026-11-26T12:00:00Z"),
        ingest: { enqueue: async () => ({ status: "accepted" }) },
      },
    );

    const grant = {
      connection: conn.slug,
      actions: ["read"] as const,
      pages: [ROOT_PAGE_GRANTED],
    };

    // Two concurrent tool calls hit 401 on expired-token -> only 1 refresh call happens!
    const [r1, r2] = await Promise.all([
      handler({
        name: "notion_read_page",
        organizationId: "org-1",
        grant,
        args: { page: ROOT_PAGE_GRANTED },
      }),
      handler({
        name: "notion_read_page",
        organizationId: "org-1",
        grant,
        args: { page: ROOT_PAGE_GRANTED },
      }),
    ]);
    const markdownSchema = z.object({ markdown: z.string() });
    assert.equal(refreshCalls, 1);
    assert.equal(markdownSchema.parse(r1).markdown, "Fresh content");
    assert.equal(markdownSchema.parse(r2).markdown, "Fresh content");

    // Now simulate expired token + invalid_grant on refresh -> requires_reauthorization
    await database.integrations.withRefreshLock(conn.id, async (current, update) => {
      await update({
        credentials: {
          ...current!.credentials,
          accessToken: "revoked-token",
          accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
        },
      });
    });
    shouldInvalidGrant = true;

    await assert.rejects(
      handler({
        name: "notion_read_page",
        organizationId: "org-1",
        grant,
        args: { page: ROOT_PAGE_GRANTED },
      }),
      IntegrationToolError,
    );
    const updatedConn = await database.integrations.findById(conn.id);
    assert.equal(updatedConn?.status, "requires_reauthorization");
  });
});
