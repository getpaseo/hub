import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { browserConfiguration } from "../../providers/browser.js";
import { ProviderConfigurationCatalog } from "../../providers/configuration.js";
import { createProviderRegistry } from "../../providers/server.js";

describe("registered trigger events", () => {
  it("preserves event order and the new-trigger default in both compositions", () => {
    const events = createProviderRegistry().configuration;
    assert.deepEqual(events.list(), browserConfiguration.list());
    assert.deepEqual(events.list().slice(0, 2), ["slack.mention", "discord.mention"]);
    assert.deepEqual(events.list().slice(-2), ["schedule.tick", "manual.run"]);
    assert.deepEqual(events.defaultFor([{ provider: "github", slug: "repo" }]), {
      event: "manual.run",
      connection: "",
    });
    assert.deepEqual(events.defaultFor([{ provider: "slack", slug: "company" }]), {
      event: "slack.mention",
      connection: "company",
    });
    assert.equal(events.replyType("github.future_event"), "github.reply");
    assert.equal(events.replyType("manual.run"), undefined);
    assert.equal(events.parse("unknown.event"), "manual.run");
  });

  it("assembles another implementation's event metadata and reply without a shared event arm", () => {
    const events = new ProviderConfigurationCatalog([
      {
        filterFields: {},
        projectLegacyFilters: () => ({}),
        provider: "example",
        order: 0,
        events: { "example.message": { label: "Example message" } },
        replyType: "example.reply",
      },
    ]);
    assert.equal(events.definition("example.message").provider, "example");
    assert.equal(events.definition("example.message").label, "Example message");
    assert.equal(events.replyType("example.message"), "example.reply");
    assert.throws(() => events.definition("github.issue_created"), /unknown trigger event/);
  });

  it("rejects a provider attempting to replace a Hub-owned source", () => {
    assert.throws(
      () =>
        new ProviderConfigurationCatalog([
          {
            provider: "manual",
            order: 0,
            events: {},
            filterFields: {},
            projectLegacyFilters: () => ({}),
          },
        ]),
      /reserved Hub source/,
    );
  });
});
