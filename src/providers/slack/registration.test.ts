import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { StartConnectionAttemptInput } from "../../db/types.js";
import { EntitlementsService } from "../../entitlements/service.js";
import type { SlackBotClient } from "../../triggers/slack/client.js";
import type { SlackConnectionClient } from "./client.js";
import { createSlackRegistration } from "./index.js";

describe("Slack registration", () => {
  it("constructs the complete webhook slice and starts OAuth with a protected state", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user",
          organizationId: "org",
          organizationName: "Org",
          organizationSlug: "org",
          membershipId: "membership",
          role: "owner",
        },
      ],
    });
    let attempt: StartConnectionAttemptInput | undefined;
    database.startConnectionAttempt = (input) => {
      attempt = input;
      return Promise.resolve();
    };
    const registration = createSlackRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: slackConfiguration(),
      connectionClient: new SlackConnectionFake(),
      botClient: new SlackBotFake(),
    });

    assert.equal(registration.connection.name, "slack");
    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.deepEqual(
      registration.outputs.map((output) => output.type),
      ["slack.reply"],
    );
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      ["slack.events"],
    );

    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 200);
    assert.equal(attempt?.provider, "slack");
    const body = z.object({ url: z.string() }).parse(await response.json());
    const state = new URL(body.url).searchParams.get("state");
    assert(state !== null && state.length > 20);
    assert.notEqual(attempt?.stateVerifier, state);
  });

  it("does not construct partial behavior when app configuration is absent", () => {
    const registration = createSlackRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: null,
    });
    assert.deepEqual(registration.connection.status({ github: [], discord: [], slack: [] }), {
      status: "notConfigured",
    });
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(registration.requests, []);
  });

  it("surfaces legacy Slack installations that need the expanded grant", () => {
    const registration = createSlackRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: slackConfiguration(),
    });
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [
          {
            id: "slack-connection",
            organizationId: "org",
            slug: "slack-workspace",
            teamId: "T1",
            teamName: "Workspace",
            botUserId: "UBOT",
            botAccessToken: "token",
            scopes: [],
          },
        ],
      }),
      { status: "requiresReauthorization" },
    );
  });

  it("does not lend a rebound workspace token to an older organization execution", async () => {
    const database = createMemoryDatabase();
    database.findSlackConnectionForOrganization = () =>
      Promise.resolve({
        id: "slack-connection",
        organizationId: "org-b",
        slug: "slack-workspace",
        teamId: "T1",
        teamName: "Workspace",
        botUserId: "UBOT-B",
        botAccessToken: "token-b",
        scopes: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "files:read",
          "groups:history",
          "reactions:write",
        ],
      });
    const requests: string[] = [];
    const registration = createSlackRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: slackConfiguration(),
      fetch: async (_input, init) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ ok: true });
      },
    });
    const reply = registration.outputs[0]?.execute;
    assert(reply !== undefined);
    const context = {
      provider: "slack",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      messageTs: "1.1",
    };

    await assert.rejects(() =>
      reply({
        agentExecutionId: "old-org-a-execution",
        toolType: "slack.reply",
        args: { content: "old reply" },
        outputContext: { ...context, organizationId: "org-a" },
      }),
    );
    assert.deepEqual(requests, []);

    await reply({
      agentExecutionId: "new-org-b-execution",
      toolType: "slack.reply",
      args: { content: "new reply" },
      outputContext: { ...context, organizationId: "org-b" },
    });
    assert.deepEqual(requests, ["Bearer token-b"]);
  });
});

function slackConfiguration() {
  return { appId: "A1", clientId: "client", clientSecret: "secret", signingSecret: "signing" };
}

class SlackConnectionFake implements SlackConnectionClient {
  authorizationUrl(state: string): string {
    return `https://slack.test/oauth?state=${state}`;
  }
  exchangeCode(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  revoke(): Promise<void> {
    return Promise.resolve();
  }
}

class SlackBotFake implements SlackBotClient {
  sendMessage(): Promise<void> {
    return Promise.resolve();
  }
  addReaction(): Promise<void> {
    return Promise.resolve();
  }
  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
}

class RegistrationAuth implements AuthServer {
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
      membership: { id: "membership", role: "owner" },
      capabilities: { view: true, manageMembers: true, manageOwners: true, manageResources: true },
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
  entitlements = new EntitlementsService(createMemoryDatabase(), {
    seats: () => Promise.resolve(0),
  });
  close(): Promise<void> {
    return Promise.resolve();
  }
}
