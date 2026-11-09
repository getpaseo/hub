import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { browserProvider, browserProviders } from "./browser.js";
import { ProviderRegistry } from "./registry.js";
import { createProviderRegistry } from "./server.js";

describe("provider registration", () => {
  it("rejects duplicate IDs without constructing provider runtimes", () => {
    let created = 0;
    const original = createProviderRegistry().require("github");
    const module = {
      ...original,
      createRuntime: () => {
        created += 1;
        throw new Error("not activated");
      },
    };
    assert.throws(
      () => new ProviderRegistry([module, module]),
      /provider already registered: github/u,
    );
    assert.equal(created, 0);
  });

  it("accepts an implementation ID outside the built-in provider list", () => {
    const module = {
      ...createProviderRegistry().require("github"),
      manifest: {
        ...createProviderRegistry().require("github").manifest,
        id: "example-provider",
      },
      configuration: {
        filterFields: {},
        projectLegacyFilters: () => ({}),
        provider: "example-provider",
        order: 4,
        events: { "example-provider.event": { label: "Example event" } },
      },
    };
    const registry = new ProviderRegistry([module]);
    assert.equal(registry.require("example-provider"), module);
    assert.throws(() => registry.require("github"), /unknown provider: github/u);
  });

  it("rejects malformed provider IDs at composition", () => {
    const module = createProviderRegistry().require("github");
    assert.throws(
      () => new ProviderRegistry([{ ...module, manifest: { ...module.manifest, id: "" } }]),
      /invalid provider id/u,
    );
  });

  it("registers a browser setup module for each installed server provider", () => {
    const registry = createProviderRegistry();
    assert.deepEqual(
      registry.list().map((module) => module.manifest.id),
      browserProviders.map((module) => module.id),
    );
    for (const module of registry.list())
      assert.equal(browserProvider(module.manifest.id).guide.provider, module.manifest.id);
    assert.throws(() => browserProvider("unknown"), /unknown provider/u);
  });
});
