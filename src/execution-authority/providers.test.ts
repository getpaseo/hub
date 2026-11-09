import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createProviderRegistry } from "../providers/server.js";
import { createExecutionAuthority } from "./index.js";

const catalog = createProviderRegistry().configuration;

describe("registered execution credential owners", () => {
  it("returns a connection credential to its registered revoker without a step capability", async () => {
    const database = createMemoryDatabase(catalog);
    const revoked: string[] = [];
    const authority = createExecutionAuthority({
      database,
      isExecutionActive: async () => true,
      providerAuthorities: new Map([
        [
          "example",
          {
            revoke: async (token) => {
              revoked.push(token);
            },
          },
        ],
      ]),
      connectionsForProject: () => async (_slug, _value, context) => {
        const register = context?.registerToken;
        assert.ok(register);
        await register({
          provider: "example",
          token: "example-token",
          expiresAt: Date.now() + 60000,
        });
        return "example-token";
      },
    });
    try {
      assert.deepEqual(
        await authority.materialize({
          executionId: "execution",
          projectId: "project",
          triggerContext: {},
          env: { TOKEN: "${{ paseo.connections.account.credential }}" },
        }),
        { env: { TOKEN: "example-token" } },
      );
      await authority.onExecutionTerminal("execution");
      assert.deepEqual(revoked, ["example-token"]);
      assert.deepEqual(await database.executionAuthority.leases(), []);
    } finally {
      await authority.stop();
    }
  });

  it("rejects an unknown credential owner before recording a lease", async () => {
    const database = createMemoryDatabase(catalog);
    const authority = createExecutionAuthority({
      database,
      isExecutionActive: async () => true,
      providerAuthorities: new Map(),
      connectionsForProject: () => async (_slug, _value, context) => {
        const register = context?.registerToken;
        assert.ok(register);
        await register({
          provider: "unknown",
          token: "unknown-token",
          expiresAt: Date.now() + 60000,
        });
        return "unknown-token";
      },
    });
    try {
      await assert.rejects(
        authority.materialize({
          executionId: "execution",
          projectId: "project",
          triggerContext: {},
          env: { TOKEN: "${{ paseo.connections.account.credential }}" },
        }),
        /unknown execution credential provider: unknown/,
      );
      assert.deepEqual(await database.executionAuthority.leases(), []);
      assert.equal(await database.executionAuthority.read("execution"), undefined);
    } finally {
      await authority.stop();
    }
  });
});
