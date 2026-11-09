import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { compileHubConfig, parseCompiledHubConfig } from "../config/compiler.js";
import { ProviderConfigurationCatalog } from "./configuration.js";
import { createProviderRegistry } from "./server.js";

const room = z.string().min(1).optional();
const nativeFilters = z.object({ room });
const catalog = new ProviderConfigurationCatalog([
  {
    provider: "example",
    order: 0,
    events: { "example.message": { label: "Example message" } },
    filterFields: { room },
    projectLegacyFilters: (value) => nativeFilters.parse(value),
  },
]);

function configuration(filters: Record<string, unknown>) {
  return {
    environments: [{ name: "local", kind: "daemon", daemon: "dev", cwd: "/repo" }],
    triggers: [
      {
        name: "answer",
        on: "example.message",
        max_runtime: "1h",
        filters,
        steps: [
          {
            id: "run",
            environment: "local",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Answer this request." }],
          },
        ],
      },
    ],
  };
}

describe("registered configuration codecs", () => {
  it("compiles and reads a native filter without adding it to the shared schema", () => {
    const compiled = compileHubConfig(
      configuration({ room: "support", from_users: ["*"] }),
      catalog,
    );
    assert.equal(compiled.triggers[0]?.filters?.["room"], "support");
    assert.deepEqual(parseCompiledHubConfig(compiled, catalog), compiled);
    assert.throws(
      () => parseCompiledHubConfig(compiled, createProviderRegistry().configuration),
      /invalid compiled workflow contract/,
    );
  });

  it("keeps native validation, unknown-field rejection and the external actor policy", () => {
    assert.throws(
      () => compileHubConfig(configuration({ room: 42, from_users: ["*"] }), catalog),
      /room/,
    );
    assert.throws(
      () =>
        compileHubConfig(
          configuration({ room: "support", unknown: true, from_users: ["*"] }),
          catalog,
        ),
      /unknown/,
    );
    assert.throws(
      () => compileHubConfig(configuration({ room: "support" }), catalog),
      /requires a non-empty filters.from_users allowlist/,
    );
  });
});
