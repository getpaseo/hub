import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createConnectionsForProject } from "../application-runtime.js";
import type { ConnectionInventory } from "../application-runtime.js";

const PROJECT_ID = "70000000-0000-4000-8000-000000000001";

// linear was missing from the slug candidates, so every linear connection's token
// resolved as "unavailable" however correctly it was authored
describe("Linear connection values in a step environment", () => {
  it("finds a linear connection by the slug an author wrote", async () => {
    const resolve = resolver();
    assert.equal(await resolve("acme-linear", "token"), "linear-access-token");
  });

  it("still refuses a slug no connection carries", async () => {
    const resolve = resolver();
    await assert.rejects(
      async () => resolve("vogon-linear", "token"),
      /connection slug is unavailable/u,
    );
  });
});

function resolver() {
  const db = database();
  return createConnectionsForProject(
    db,
    new Map([
      [
        "linear",
        {
          resolve: (_projectId: string, _slug: string, value: string) => {
            if (value !== "token") throw new Error(`unsupported linear value: ${value}`);
            return Promise.resolve("linear-access-token");
          },
        },
      ],
    ]),
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
    id: "70000000-0000-4000-8000-000000000002",
    organizationId: "acme",
    slug: "acme-linear",
    providerApplicationId: null,
    linearOrganizationId: "linear-org-1",
    linearOrganizationName: "Acme",
    appUserId: "linear-app-user-1",
    accessToken: "linear-access-token",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: [],
  };
  return {
    findProjectById: (id: string) => Promise.resolve(id === PROJECT_ID ? project : undefined),
    organizationConnectionUsage: () =>
      Promise.resolve({ github: [], discord: [], slack: [], linear: [connection], forgejo: [] }),
  };
}
