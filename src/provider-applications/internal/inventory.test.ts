import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CONNECTION_PROVIDERS } from "../../db/schema.js";
import { connectionIdentityQuery, connectionTable } from "./inventory.js";

/**
 * Direct coverage for the two provider→table and provider→query mappings in inventory.ts.
 *
 * The failure mode they guard against: both functions previously fell through to a bare else
 * that returned discord_connections for any unrecognised provider, so a new provider added to
 * CONNECTION_PROVIDERS would silently touch Discord's rows instead of failing loudly.
 *
 * The `satisfies` compile-time guard ensures that if CONNECTION_PROVIDERS gains a new member,
 * the expected table map below stops compiling until someone adds a matching entry.
 */
describe("inventory provider mappings", () => {
  const EXPECTED_TABLES = {
    github: "github_connections",
    slack: "slack_connections",
    discord: "discord_connections",
    linear: "linear_connections",
  } satisfies Record<(typeof CONNECTION_PROVIDERS)[number], string>;

  it("connectionTable returns the correct table for every provider", () => {
    for (const provider of CONNECTION_PROVIDERS) {
      assert.equal(connectionTable(provider), EXPECTED_TABLES[provider]);
    }
  });

  it("every provider maps to a distinct table", () => {
    const tables = CONNECTION_PROVIDERS.map(connectionTable);
    assert.equal(new Set(tables).size, tables.length);
  });

  it("connectionIdentityQuery reads from the provider's own table and no other provider's table", () => {
    for (const provider of CONNECTION_PROVIDERS) {
      const query = connectionIdentityQuery(provider);
      const ownTable = EXPECTED_TABLES[provider];

      assert.ok(query.includes(ownTable), `query for "${provider}" should mention ${ownTable}`);

      for (const other of CONNECTION_PROVIDERS) {
        if (other === provider) continue;
        const otherTable = EXPECTED_TABLES[other];
        assert.ok(
          !query.includes(otherTable),
          `query for "${provider}" should not mention ${otherTable}`,
        );
      }
    }
  });
});
