import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import { field, record } from "./contract-test-read.js";
import { loadForgejoContractFixtures } from "./fake-server.js";
import { handleForgejoConnectionsRequest } from "./connections.js";
import {
  createMemoryForgejoDirectory,
  handleForgejoInstancesRequest,
  type ForgejoAccessResolver,
  type ForgejoHttp,
} from "./instances.js";
import { handleForgejoRepositoriesRequest } from "./repositories.js";
import type { SecretEncryptionKeySource } from "../../secrets/authenticated-envelope.js";

describe("Forgejo repository enrollment", () => {
  it("enumerates only visible repositories and enrolls an explicit subset by immutable id", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const directory = createMemoryForgejoDirectory();
    const secrets = testSecrets();
    const pages: string[] = [];
    const http = fixtureHttp(fixtures, pages);
    const approved = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://forgejo.example.test" }),
      { access: operatorAccess(), directory, http },
    );
    const instance = record(
      field(record(await approved.json(), "approved"), "instance"),
      "instance",
    );
    const created = await handleForgejoConnectionsRequest(
      jsonRequest("https://hub.test/connections", {
        instanceId: instance["id"],
        slug: "forgejo-bot",
        claimedUsername: "t00user",
        pat: "forgejo_pat_repository_limited",
        scopes: ["write:issue", "write:repository"],
        repositories: [1],
      }),
      { access: ownerAccess(), directory, http, secrets },
    );
    const connection = record(
      field(record(await created.json(), "created"), "connection"),
      "connection",
    );
    assert.equal(pages.filter((path) => path.startsWith("/api/v1/repos/search")).length >= 2, true);

    const rejected = await handleForgejoRepositoriesRequest(
      jsonRequest(`https://hub.test/connections/${String(connection["id"])}/repositories`, {
        repositoryIds: [99],
      }),
      { access: ownerAccess(), directory, http, secrets },
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "forgejo_scope_invalid" });

    const enrolled = await handleForgejoRepositoriesRequest(
      jsonRequest(`https://hub.test/connections/${String(connection["id"])}/repositories`, {
        repositoryIds: [1],
      }),
      { access: ownerAccess(), directory, http, secrets },
    );
    assert.equal(enrolled.status, 200);
    const body = record(await enrolled.json(), "enrolled");
    const repositories = field(body, "repositories");
    assert.equal(Array.isArray(repositories), true);
    const rows = Array.isArray(repositories) ? repositories.map((row) => record(row, "repo")) : [];
    const enrolledRow = rows.find((row) => row["repositoryId"] === 1);
    const visibleOnly = rows.find((row) => row["repositoryId"] === 2);
    assert.equal(enrolledRow?.["enrolled"], true);
    assert.equal(enrolledRow?.["fullName"], "t00org/t00repo");
    assert.equal(visibleOnly?.["enrolled"], false);

    const renamed = await handleForgejoRepositoriesRequest(
      jsonRequest(`https://hub.test/connections/${String(connection["id"])}/repositories`, {
        repositoryIds: [1],
      }),
      {
        access: ownerAccess(),
        directory,
        http: fixtureHttp(fixtures, pages, { renamed: true }),
        secrets,
      },
    );
    const renamedBody = record(await renamed.json(), "renamed");
    const renamedRows = field(renamedBody, "repositories");
    const renamedList = Array.isArray(renamedRows)
      ? renamedRows.map((row) => record(row, "renamed-repo"))
      : [];
    const stillSame = renamedList.find((row) => row["repositoryId"] === 1);
    assert.equal(stillSame?.["enrolled"], true);
    assert.equal(stillSame?.["fullName"], "t00org/renamed");
    assert.equal(JSON.stringify(renamedBody).includes("forgejo_pat_repository_limited"), false);
  });
});

function operatorAccess(): ForgejoAccessResolver {
  return {
    resolve: async () => ({
      userId: "user-1",
      isInstanceOperator: true,
      organizationId: null,
      organizationRole: null,
    }),
  };
}

function ownerAccess(): ForgejoAccessResolver {
  return {
    resolve: async () => ({
      userId: "user-1",
      isInstanceOperator: false,
      organizationId: "org-1",
      organizationRole: "owner",
    }),
  };
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function testSecrets(): SecretEncryptionKeySource {
  const key = randomBytes(32);
  const current = { keyId: 1, key };
  return {
    current: () => current,
    byId: (id) => (id === 1 ? current : undefined),
  };
}

function fixtureHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  pages: string[],
  options: { renamed?: boolean } = {},
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  const first = record(
    field(record(fixtures.hydration["repository"], "repository"), "body"),
    "body",
  );
  const second = {
    ...first,
    id: 2,
    name: "other",
    full_name: "t00org/other",
    html_url: "https://forgejo.example.test/t00org/other",
  };
  const renamedFirst = {
    ...first,
    name: "renamed",
    full_name: "t00org/renamed",
    html_url: "https://forgejo.example.test/t00org/renamed",
  };
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input) => {
      const url = requestUrl(input);
      pages.push(url.pathname + url.search);
      if (url.pathname === "/api/v1/user") {
        throw new Error("GET /api/v1/user is forbidden for repository-limited PATs");
      }
      if (url.pathname === "/api/v1/version") return Response.json(version);
      if (url.pathname === "/api/v1/settings/api") return Response.json(settings);
      if (url.pathname === "/api/v1/repos/search") {
        const page = url.searchParams.get("page");
        if (page === "2") {
          return new Response(
            JSON.stringify({ ok: true, data: [options.renamed === true ? renamedFirst : first] }),
            {
              headers: { "content-type": "application/json", "x-total-count": "2" },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, data: [second] }), {
          headers: {
            "content-type": "application/json",
            "x-total-count": "2",
            link: '<https://forgejo.example.test/api/v1/repos/search?limit=50&page=2>; rel="next"',
          },
        });
      }
      if (url.pathname.includes("/collaborators/")) {
        return Response.json({
          permission: "admin",
          role_name: "owner",
          user: { id: 7, login: "t00user" },
        });
      }
      throw new Error(`unexpected Forgejo path ${url.pathname}`);
    },
  };
}
