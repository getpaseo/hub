import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { DurableProviderEvent } from "../../db/types.js";
import type { ProviderRegistration } from "../../providers/registration.js";
import type { ExternalTrigger, TriggerHandler, TriggerProvider } from "../../triggers/index.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  SlackProviderApplicationConfiguration,
} from "../index.js";
import { DynamicProviderRuntime } from "./runtime-owner.js";

describe("dynamic provider runtime", () => {
  it("publishes a started replacement, retires old resources, and retains in-flight snapshots", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const completed: string[] = [];
    const runtime = new DynamicProviderRuntime({
      database: createMemoryDatabase(),
      auth: testAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ configuration }) =>
        fakeRegistration(configurationId(configuration), started, stopped, completed),
    });
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;
    await stable.sources[0]!.start(() => Promise.resolve());

    const first = await runtime.prepare(
      "slack",
      slackConfiguration("A1"),
      "https://hub.test",
      { provider: "slack", id: "A1", name: "A1" },
      1,
    );
    await first.start();
    first.publish();
    const trigger = stable.triggerProviders[0]!({
      configurationStoreForProject: () => {
        throw new Error("unused");
      },
      connectionsForProject: () => {
        throw new Error("unused");
      },
    })!;
    const matches = await trigger.match(externalTrigger());
    if (typeof matches === "string") throw new Error("expected a match");
    const oldMatch = matches[0];

    const second = await runtime.prepare(
      "slack",
      slackConfiguration("A2"),
      "https://hub.test",
      { provider: "slack", id: "A2", name: "A2" },
      2,
    );
    await second.start();
    second.publish();
    await new Promise((resolve) => setImmediate(resolve));

    await trigger.onAgentExecutionCompleted?.(oldMatch!.triggerContext, oldMatch!.outputContext, {
      status: "succeeded",
    });
    const response = await stable.connection.actions["start"]!(
      new Request("https://hub.test/start", { method: "POST" }),
    );
    assert.deepEqual(started, ["A1", "A2"]);
    assert.deepEqual(stopped, ["A1"]);
    assert.deepEqual(completed, ["A1"]);
    assert.deepEqual(await response.json(), { url: "https://provider.test/A2" });
  });

  it("leaves the active registration untouched when a candidate cannot start", async () => {
    const runtime = new DynamicProviderRuntime({
      database: createMemoryDatabase(),
      auth: testAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ configuration }) =>
        fakeRegistration(
          configurationId(configuration),
          [],
          [],
          [],
          configurationId(configuration) === "A2",
        ),
    });
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;
    await stable.sources[0]!.start(() => Promise.resolve());
    const first = await runtime.prepare(
      "slack",
      slackConfiguration("A1"),
      "https://hub.test",
      { provider: "slack", id: "A1", name: "A1" },
      1,
    );
    await first.start();
    first.publish();
    const failed = await runtime.prepare(
      "slack",
      slackConfiguration("A2"),
      "https://hub.test",
      { provider: "slack", id: "A2", name: "A2" },
      2,
    );

    await assert.rejects(() => failed.start(), /start failed/u);
    await failed.close();
    const response = await stable.connection.actions["start"]!(
      new Request("https://hub.test/start", { method: "POST" }),
    );
    assert.deepEqual(await response.json(), { url: "https://provider.test/A1" });
    assert.equal(runtime.identity("slack")?.id, "A1");
  });

  for (const provider of ["github", "slack", "discord"] as const) {
    it(`activates ${provider} for new connection actions without a restart`, async () => {
      const runtime = new DynamicProviderRuntime({
        database: createMemoryDatabase(),
        auth: testAuth(),
        applicationBaseUrl: "https://hub.test",
        registrationFactory: ({ provider: candidateProvider, configuration }) =>
          connectionRegistration(candidateProvider, providerConfigurationId(configuration)),
      });
      const stable = runtime
        .registrations()
        .find((registration) => registration.connection.name === provider)!;
      await stable.sources[0]!.start(() => Promise.resolve());
      const candidate = await runtime.prepare(
        provider,
        providerConfiguration(provider, "one"),
        "https://hub.test",
        providerIdentity(provider, "one"),
        1,
      );

      await candidate.start();
      candidate.publish();

      const response = await stable.connection.actions["start"]!(
        new Request("https://hub.test/start", { method: "POST" }),
      );
      assert.deepEqual(await response.json(), { url: `https://provider.test/${provider}/one` });
    });

    it(`keeps the working ${provider} registration when replacement startup fails`, async () => {
      const runtime = new DynamicProviderRuntime({
        database: createMemoryDatabase(),
        auth: testAuth(),
        applicationBaseUrl: "https://hub.test",
        registrationFactory: ({ provider: candidateProvider, configuration }) =>
          connectionRegistration(
            candidateProvider,
            providerConfigurationId(configuration),
            providerConfigurationId(configuration) === "two",
          ),
      });
      const stable = runtime
        .registrations()
        .find((registration) => registration.connection.name === provider)!;
      await stable.sources[0]!.start(() => Promise.resolve());
      const first = await runtime.prepare(
        provider,
        providerConfiguration(provider, "one"),
        "https://hub.test",
        providerIdentity(provider, "one"),
        1,
      );
      await first.start();
      first.publish();
      const replacement = await runtime.prepare(
        provider,
        providerConfiguration(provider, "two"),
        "https://hub.test",
        providerIdentity(provider, "two"),
        2,
      );

      await assert.rejects(() => replacement.start(), /start failed/u);
      await replacement.close();

      const response = await stable.connection.actions["start"]!(
        new Request("https://hub.test/start", { method: "POST" }),
      );
      assert.deepEqual(await response.json(), { url: `https://provider.test/${provider}/one` });
      assert.equal(runtime.identity(provider)?.id, "one");
    });
  }

  it("reconstructs callbacks from the configuration version and origin that began OAuth", async () => {
    const database = createMemoryDatabase();
    database.findConnectionAttemptConfiguration = () =>
      Promise.resolve({
        configurationVersion: 1,
        callbackOrigin: "https://old-origin.test",
        configurationSnapshot: slackConfiguration("old"),
        expectedConfigurationVersion: null,
        activateConfiguration: false,
      });
    const runtime = new DynamicProviderRuntime({
      database,
      auth: testAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ provider, configuration, callbackOrigin, configurationVersion }) => ({
        ...connectionRegistration(provider, providerConfigurationId(configuration)),
        configurationSnapshot: { version: configurationVersion, callbackOrigin },
      }),
    });
    const active = await runtime.prepare(
      "slack",
      slackConfiguration("new"),
      "https://new-origin.test",
      { provider: "slack", id: "new", name: "New" },
      2,
    );
    active.publish();
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;

    const response = await stable.connection.actions["callback"]!(
      new Request("https://hub.test/callback?state=attempt-state"),
    );

    assert.deepEqual(await response.json(), { callbackFor: "old" });
  });

  it("admits source events only from the atomically published registration", async () => {
    const sourceHandlers = new Map<string, TriggerHandler>();
    const accepted: string[] = [];
    const runtime = new DynamicProviderRuntime({
      database: createMemoryDatabase(),
      auth: testAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ provider, configuration }) => ({
        ...connectionRegistration(provider, providerConfigurationId(configuration)),
        sources: [
          {
            start: (handler) => {
              sourceHandlers.set(providerConfigurationId(configuration), handler);
              return Promise.resolve();
            },
            stop: () => Promise.resolve(),
          },
        ],
      }),
    });
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;
    await stable.sources[0]!.start((event) => {
      accepted.push(String(event.payload));
      return Promise.resolve();
    });
    const first = await runtime.prepare(
      "slack",
      slackConfiguration("one"),
      "https://hub.test",
      { provider: "slack", id: "one", name: "One" },
      1,
    );
    await first.start();
    await sourceHandlers.get("one")!(durableEvent("before-first-publish"));
    first.publish();
    await sourceHandlers.get("one")!(durableEvent("first-active"));
    const second = await runtime.prepare(
      "slack",
      slackConfiguration("two"),
      "https://hub.test",
      { provider: "slack", id: "two", name: "Two" },
      2,
    );
    await second.start();
    await sourceHandlers.get("two")!(durableEvent("before-second-publish"));
    second.publish();
    await sourceHandlers.get("one")!(durableEvent("retired"));
    await sourceHandlers.get("two")!(durableEvent("second-active"));

    assert.deepEqual(accepted, ["first-active", "second-active"]);
  });
});

function providerConfiguration(provider: Provider, id: string): ProviderApplicationConfiguration {
  if (provider === "github") {
    return {
      provider,
      appId: id,
      appSlug: id,
      clientId: "client",
      clientSecret: "secret",
      privateKey: "key",
      webhookSecret: "webhook",
    };
  }
  if (provider === "slack") return slackConfiguration(id);
  return { provider, applicationId: id, clientSecret: "secret", botToken: "token" };
}

function providerIdentity(provider: Provider, id: string): ProviderApplicationIdentity {
  if (provider === "github") return { provider, id, name: id, ownerLogin: "owner" };
  return { provider, id, name: id };
}

function providerConfigurationId(configuration: ProviderApplicationConfiguration): string {
  if (configuration.provider === "github") return configuration.appId;
  if (configuration.provider === "slack") return configuration.appId;
  return configuration.applicationId;
}

function connectionRegistration(
  provider: Provider,
  id: string,
  failStart = false,
): ProviderRegistration {
  return {
    connection: {
      name: provider,
      status: () => ({ status: "connected" }),
      actions: {
        start: () =>
          Promise.resolve(Response.json({ url: `https://provider.test/${provider}/${id}` })),
        callback: () => Promise.resolve(Response.json({ callbackFor: id })),
      },
    },
    triggerProviders: [],
    sources: [
      {
        start: () => (failStart ? Promise.reject(new Error("start failed")) : Promise.resolve()),
        stop: () => Promise.resolve(),
      },
    ],
    outputs: [],
    requests: [],
  };
}

function slackConfiguration(appId: string): SlackProviderApplicationConfiguration {
  return {
    provider: "slack",
    appId,
    clientId: "client",
    clientSecret: "secret",
    signingSecret: "signing",
  };
}

function configurationId(configuration: ProviderApplicationConfiguration): string {
  if (configuration.provider !== "slack") throw new Error("expected Slack configuration");
  return configuration.appId;
}

function fakeRegistration(
  id: string,
  started: string[],
  stopped: string[],
  completed: string[],
  failStart = false,
): ProviderRegistration {
  const trigger: TriggerProvider<"slack", { id: string }, { id: string }> = {
    name: "slack",
    eventNames: ["slack.mention"],
    match: () =>
      Promise.resolve([
        {
          triggerName: "mention",
          triggerContext: { id },
          outputContext: { id },
          hubConfig: {},
          invocation: { status: "accepted", rawMessage: "", prompt: "", inputs: {} },
        },
      ]),
    onAgentExecutionCompleted: () => {
      completed.push(id);
      return Promise.resolve();
    },
  };
  return {
    connection: {
      name: "slack",
      status: () => ({ status: "connected" }),
      actions: {
        start: () => Promise.resolve(Response.json({ url: `https://provider.test/${id}` })),
      },
    },
    triggerProviders: [() => trigger],
    sources: [
      {
        start: () => {
          if (failStart) return Promise.reject(new Error("start failed"));
          started.push(id);
          return Promise.resolve();
        },
        stop: () => {
          stopped.push(id);
          return Promise.resolve();
        },
      },
    ],
    outputs: [],
    requests: [],
  };
}

function externalTrigger(): ExternalTrigger {
  return {
    providerEventReceiptId: "receipt",
    organizationId: "org",
    projectId: "project",
    configurationRevisionId: "revision",
    source: "slack.mention",
    deliveryId: "delivery",
    receivedAt: new Date(),
    payload: {},
  };
}

function durableEvent(payload: string): DurableProviderEvent {
  return {
    providerEventReceiptId: "receipt",
    organizationId: "org",
    projectId: "project",
    configurationRevisionId: "revision",
    source: "slack.mention",
    deliveryId: payload,
    receivedAt: new Date(),
    payload,
    connectionId: null,
    resourceId: null,
  };
}

function testAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("unused")),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () => Promise.reject(new Error("unused")),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
