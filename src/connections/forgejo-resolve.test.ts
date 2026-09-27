import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createConnectionsForProject } from "../application-runtime.js";
import type { ConnectionInventory } from "../application-runtime.js";
import type { Database } from "../db/types.js";
import { createForgejoRegistration } from "../providers/forgejo/index.js";

const PROJECT_ID = "60000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "60000000-0000-4000-8000-000000000002";

describe("Forgejo connection values in a step environment", () => {
  it("hands back the token the authored slug names", async () => {
    const resolve = resolver(database());
    assert.equal(await resolve("acme-forge", "token"), "forgejo-access-token");
  });

  it("hands back the instance url and account login too", async () => {
    const resolve = resolver(database());
    assert.equal(await resolve("acme-forge", "url"), "https://git.example.test");
    assert.equal(await resolve("acme-forge", "login"), "trillian");
  });

  it("refuses a slug no connection in the organization carries", async () => {
    const resolve = resolver(database());
    await assert.rejects(
      async () => resolve("vogon-forge", "token"),
      /connection slug is unavailable/u,
    );
  });

  it("refuses a value the provider does not publish", async () => {
    const resolve = resolver(database());
    await assert.rejects(
      async () => resolve("acme-forge", "webhookSecret"),
      /unsupported forgejo/u,
    );
  });

  it("never registers a lease, because nothing here can revoke one", async () => {
    const leases: unknown[] = [];
    const resolve = resolver(database());
    await resolve("acme-forge", "token", {
      executionId: "execution-1",
      registerToken: (lease) => {
        leases.push(lease);
      },
    });
    assert.deepEqual(leases, []);
  });
});

// integration.resolve only reads the two members below; anything else throws so a
// resolver that starts reading more fails loudly here instead of silently
function forgejoStore(inventory: ConnectionInventory): Database {
  const store = new Proxy(inventory, {
    get(target, property: string) {
      if (property in target) return Reflect.get(target, property) as unknown;
      throw new Error(`forgejo resolve should not need Database.${property}`);
    },
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the proxy answers every other member by throwing, which no type can express
  return store as Database;
}

function resolver(db: ConnectionInventory) {
  const registration = createForgejoRegistration({
    database: forgejoStore(db),
    auth: null,
    applicationBaseUrl: "https://hub.example.test",
  });
  assert.ok(registration.integration !== undefined);
  return createConnectionsForProject(
    db,
    new Map([["forgejo", registration.integration]]),
  )(PROJECT_ID);
}

function database(): ConnectionInventory {
  const project = {
    id: PROJECT_ID,
    organizationId: "acme",
    name: "Widgets",
    slug: "widgets",
    status: "active" as const,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
    activeConfigurationRevisionId: null,
  };
  const connection = {
    id: CONNECTION_ID,
    organizationId: "acme",
    slug: "acme-forge",
    instanceBaseUrl: "https://git.example.test",
    instanceHost: "git.example.test",
    webhookSecret: "hook-secret",
    accessToken: "forgejo-access-token",
    accountLogin: "trillian",
    accountId: 42,
    instanceFlavor: "forgejo" as const,
    instanceVersion: "16.0.5+gitea-1.22.0",
  };
  return {
    findProjectById: (id: string) => Promise.resolve(id === PROJECT_ID ? project : undefined),
    organizationConnectionUsage: () =>
      Promise.resolve({ github: [], discord: [], slack: [], linear: [], forgejo: [connection] }),
  };
}
