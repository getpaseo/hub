import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import type { AuthServer } from "./auth/server.js";
import type { OrganizationAccessValue } from "./auth/organization-access.js";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "./agent-executions/completion-token.js";
import { createMemoryDatabase } from "./db/memory.js";
import type { ProviderRegistration, TriggerProviderResources } from "./providers/registration.js";
import { createApplicationRuntime } from "./application-runtime.js";
import { replyOutputTool } from "./execution-capabilities/outputs.js";

describe("application runtime provider composition", () => {
  it("collects a fake registration without a concrete-provider case", async () => {
    const events: string[] = [];
    const registration: ProviderRegistration = {
      connection: {
        name: "fake",
        status: () => ({ status: "connected" }),
        actions: {
          start: () => Promise.resolve(Response.json({ provider: "fake" })),
        },
      },
      triggerProviders: [
        () => {
          events.push("provider");
          return { name: "fake", eventNames: ["fake.event"], match: () => Promise.resolve([]) };
        },
      ],
      sources: [
        {
          start: async () => {
            events.push("source:start");
          },
          stop: async () => {
            events.push("source:stop");
          },
        },
      ],
      outputs: [{ type: "fake.output", tool: replyOutputTool, execute: () => Promise.resolve() }],
      requests: [
        {
          name: "webhook",
          handle: () => Promise.resolve(new Response("fake webhook")),
        },
      ],
    };
    let closed = false;
    const runtime = await createApplicationRuntime({
      database: await runtimeDatabase("owner"),
      auth: new RuntimeAuth(),
      registrations: [registration],
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });

    assert.deepEqual(events, ["provider", "source:start"]);
    assert.equal(
      await (await runtime.webhook(new Request("https://hub.test/webhook"))).text(),
      "fake webhook",
    );
    assert.equal(
      await (
        await runtime.providerRequest("webhook", new Request("https://hub.test/webhook"))
      ).text(),
      "fake webhook",
    );
    assert.deepEqual(
      await (
        await runtime.connectionAction(new Request("https://hub.test/start"), "fake", "start")
      ).json(),
      { provider: "fake" },
    );
    assert.deepEqual(
      await (await runtime.connectionStatus(new Request(scopedStatusUrl()))).json(),
      { canManage: true, fake: { status: "connected" } },
    );
    assert.deepEqual(
      await (
        await runtime.connectionStatus(new Request("https://hub.test/status?organizationSlug=org"))
      ).json(),
      { canManage: true, fake: { status: "connected" } },
    );

    await runtime.stop();
    assert.deepEqual(events, ["provider", "source:start", "source:stop"]);
    assert.equal(closed, true);
  });

  it("rejects duplicate provider request registrations", async () => {
    const first = fakeRegistration();
    first.connection = { ...first.connection, name: "first" };
    first.requests = [{ name: "events", handle: () => Promise.resolve(new Response()) }];
    const second = fakeRegistration();
    second.connection = { ...second.connection, name: "second" };
    second.requests = [{ name: "events", handle: () => Promise.resolve(new Response()) }];

    await assert.rejects(
      () =>
        createApplicationRuntime({
          database: createMemoryDatabase(),
          auth: new RuntimeAuth(),
          registrations: [first, second],
          close: () => Promise.resolve(),
        }),
      /provider request registrations must have unique names: events/u,
    );
  });

  it("reports member connection status as read-only", async () => {
    const runtime = await createApplicationRuntime({
      database: await runtimeDatabase("member"),
      auth: new RuntimeAuth("member"),
      registrations: [fakeRegistration()],
      close: () => Promise.resolve(),
    });

    assert.deepEqual(
      await (await runtime.connectionStatus(new Request(scopedStatusUrl()))).json(),
      { canManage: false, fake: { status: "connected" } },
    );
    await runtime.stop();
  });

  it("shares provider integrations with every trigger provider for the same organization", async () => {
    const calls: Array<{ projectId: string; slug: string; value: string }> = [];
    let providerResources: TriggerProviderResources | undefined;
    const database = createMemoryDatabase();
    database.findProjectById = async () => ({
      id: "project-1",
      organizationId: "org-1",
      name: "Project",
      slug: "project",
      status: "active",
      createdByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      archivedAt: null,
      activeConfigurationRevisionId: null,
    });
    database.organizationConnectionUsage = async () => ({
      github: [
        {
          id: "connection-1",
          organizationId: "org-1",
          slug: "getpaseo-github",
          installationId: 42,
          accountId: "account-1",
          accountLogin: "getpaseo",
          accountType: "Organization",
          status: "active",
        },
        {
          id: "connection-2",
          organizationId: "org-1",
          slug: "secondary-getpaseo-github",
          installationId: 84,
          accountId: "account-2",
          accountLogin: "paseo",
          accountType: "Organization",
          status: "active",
        },
      ],
      discord: [],
      slack: [],
    });
    const registration: ProviderRegistration = {
      ...fakeRegistration("github"),
      integration: {
        resolve: (projectId, slug, value) => {
          calls.push({ projectId, slug, value });
          return Promise.resolve("organization-secret");
        },
      },
      triggerProviders: [
        (resources) => {
          providerResources = resources;
          return undefined;
        },
      ],
    };
    const runtime = await createApplicationRuntime({
      database,
      auth: new RuntimeAuth(),
      registrations: [registration],
      close: () => Promise.resolve(),
    });

    assert.ok(providerResources);
    const resolveConnection = providerResources.connectionsForProject("project-1");
    assert.equal(
      await resolveConnection("secondary-getpaseo-github", "token"),
      "organization-secret",
    );
    assert.deepEqual(calls, [
      { projectId: "project-1", slug: "secondary-getpaseo-github", value: "token" },
    ]);
    await assert.rejects(
      async () => resolveConnection("missing-github", "token"),
      /connection slug is unavailable/u,
    );
    await assert.rejects(
      async () => resolveConnection("org-2-github", "token"),
      /connection slug is unavailable/u,
    );
    await runtime.stop();
  });

  it("routes terminal execution cleanup through the composed integration", async () => {
    const database = await runtimeDatabase("owner");
    const [project] = await database.listProjectsForOrganization("org");
    assert(project !== undefined);
    const executionId = randomUUID();
    const completionToken = deriveAgentExecutionCompletionToken(
      "runtime-completion-secret",
      executionId,
    );
    const terminalExecutionIds: string[] = [];
    const runtime = await createApplicationRuntime({
      database,
      auth: new RuntimeAuth(),
      registrations: [
        {
          ...fakeRegistration("github"),
          integration: {
            resolve: () => Promise.resolve("token"),
            onExecutionTerminal: async (id) => {
              terminalExecutionIds.push(id);
            },
          },
        },
      ],
      close: () => Promise.resolve(),
    });

    try {
      await database.insertAgentExecution({
        id: executionId,
        organizationId: project.organizationId,
        projectId: project.id,
        machineId: null,
        triggerContext: { provider: "discord" },
        outputContext: {},
        configurationRevisionId: "configuration-runtime-terminal",
        completionTokenHash: hashAgentExecutionCompletionToken(completionToken),
      });
      await runtime.hub.daemonModule!.lifecycle.completeAgentExecutionFromCallback({
        executionId,
        token: completionToken,
      });

      assert.deepEqual(terminalExecutionIds, [executionId]);
    } finally {
      await runtime.stop();
    }
  });
});

class RuntimeAuth implements AuthServer {
  constructor(private readonly role: "owner" | "member" = "owner") {}
  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }
  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    return Promise.resolve({
      session: { id: "session" },
      account: { id: "user", name: "User", email: "user@example.test" },
      organization: { id: "org", name: "Org" },
      membership: { id: "membership", role: this.role },
      capabilities: {
        view: true,
        manageMembers: this.role === "owner",
        manageOwners: this.role === "owner",
        manageResources: this.role === "owner",
      },
    });
  }
  async resolveAccount() {
    const access = await this.resolveOrganizationAccess();
    return {
      session: { id: access.session.id, activeOrganizationId: null },
      account: access.account,
    };
  }
  rejectCookieMutation(): Response | undefined {
    return undefined;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeRegistration(name = "fake"): ProviderRegistration {
  return {
    connection: {
      name,
      status: () => ({ status: "connected" }),
      actions: {},
    },
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

async function runtimeDatabase(role: "owner" | "member") {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user",
        organizationId: "org",
        organizationName: "Org",
        organizationSlug: "org",
        membershipId: "membership",
        role,
      },
    ],
  });
  await database.createProject({
    organizationId: "org",
    name: "Default",
    slug: "default",
    createdByUserId: "user",
  });
  return database;
}

function scopedStatusUrl(): string {
  return "https://hub.test/status?organizationSlug=org&projectSlug=default";
}
