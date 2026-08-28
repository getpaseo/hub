import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearConnectionRecord } from "../../db/types.js";
import {
  createLinearApiClient,
  createLinearConnectionClient,
  hasRequiredLinearScopes,
} from "./client.js";

describe("Linear connection client", () => {
  it("uses an OAuth callback URL and records the installed workspace identity", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test/base",
      now: () => new Date(1_700_000_000_000),
      fetch: async (url, init) => {
        const requestUrl = readableUrl(url);
        requests.push({ url: requestUrl, body: readableBody(init?.body) });
        if (requestUrl.endsWith("/oauth/token")) {
          return json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: "read,comments:create",
          });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const authorization = new URL(client.authorizationUrl("state-value"));
    assert.equal(authorization.origin, "https://linear.app");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/linear/callback",
    );
    assert.equal(authorization.searchParams.get("scope"), "read,comments:create");
    assert.equal(authorization.searchParams.get("actor"), "app");
    assert.equal(authorization.searchParams.get("state"), "state-value");

    assert.deepEqual(await client.exchangeCode("code-value"), {
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_003_600_000),
      scopes: ["comments:create", "read"],
    });
    assert.match(requests[0]?.body ?? "", /code=code-value/u);
  });

  it("keeps requested scopes when Linear omits them during authorization", async () => {
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url) => {
        if (readableUrl(url).endsWith("/oauth/token")) {
          return json({ access_token: "access-token", refresh_token: "refresh-token" });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const installation = await client.exchangeCode("code-value");

    assert.deepEqual(installation.scopes, ["read", "comments:create"]);
  });

  it("refreshes an expired token before calling the Linear GraphQL API", async () => {
    const updates: unknown[] = [];
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      updateTokens: async (update) => {
        updates.push(update);
      },
      connectionClient: {
        refresh: async () => ({
          accessToken: "fresh-token",
          refreshToken: "next-refresh-token",
          accessTokenExpiresAt: new Date(1_700_003_600_000),
          scopes: ["comments:create", "read"],
        }),
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (url, init) => {
        requests.push({
          url: readableUrl(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({ data: { commentCreate: { success: true } } });
      },
    });

    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
        accessTokenExpiresAt: new Date(1_700_003_600_000),
        scopes: ["comments:create", "read"],
      },
    ]);
    assert.equal(requests[0]?.authorization, "Bearer fresh-token");
    assert.match(requests[0]?.body ?? "", /commentCreate/u);
  });

  it("keeps granted scopes when Linear omits them from a refresh response", async () => {
    const updates: unknown[] = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const request: typeof fetch = async (url) => {
      if (readableUrl(url).endsWith("/oauth/token")) {
        return json({ access_token: "fresh-token", expires_in: 3600 });
      }
      return json({ data: { commentCreate: { success: true } } });
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      updateTokens: async (update) => {
        updates.push(update);
      },
      connectionClient: createLinearConnectionClient({
        clientId: "client-id",
        clientSecret: "client-secret",
        publicBaseUrl: "https://hub.test",
        fetch: request,
        now: () => new Date(1_700_000_010_000),
      }),
      fetch: request,
      now: () => new Date(1_700_000_010_000),
    });

    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        accessTokenExpiresAt: new Date(1_700_003_610_000),
      },
    ]);
  });

  it("coalesces concurrent refreshes for one Linear connection", async () => {
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updates: unknown[] = [];
    const requests: string[] = [];
    let connectionReads = 0;
    let releaseConnections!: () => void;
    let markBothConnectionsRead!: () => void;
    let releaseRefresh!: (value: { accessToken: string; refreshToken: string }) => void;
    let markRefreshStarted!: () => void;
    const connectionsReleased = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    const bothConnectionsRead = new Promise<void>((resolve) => {
      markBothConnectionsRead = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshed = new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => {
        connectionReads += 1;
        if (connectionReads === 2) markBothConnectionsRead();
        await connectionsReleased;
        return connection;
      },
      updateTokens: async (update) => {
        updates.push(update);
      },
      connectionClient: {
        refresh: async () => {
          refreshCalls += 1;
          markRefreshStarted();
          return refreshed;
        },
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url, init) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ data: { commentCreate: { success: true } } });
      },
    });

    const operations = [
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-1", body: "One" }),
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-2", body: "Two" }),
    ];
    await bothConnectionsRead;
    releaseConnections();
    await refreshStarted;

    assert.equal(refreshCalls, 1);
    releaseRefresh({ accessToken: "fresh-token", refreshToken: "next-refresh-token" });
    await Promise.all(operations);

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
      },
    ]);
    assert.deepEqual(requests, ["Bearer fresh-token", "Bearer fresh-token"]);
  });

  it("requires read access and the narrow comment-creation scope", () => {
    assert.equal(hasRequiredLinearScopes(["read", "comments:create"]), true);
    assert.equal(hasRequiredLinearScopes(["read"]), false);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readableUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") return value;
  return value instanceof URL ? value.toString() : value.url;
}

function readableBody(value: BodyInit | null | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof URLSearchParams) return value.toString();
  return "";
}
