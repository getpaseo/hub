import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import type { GoogleChatBotClient } from "../../triggers/google-chat/client.js";
import { createGoogleChatRegistration, googleChatWebhookUrl } from "./index.js";

const TEST_RSA_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  private_key: TEST_RSA_KEYS.privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "paseo-bot@example-project.iam.gserviceaccount.com",
});

class RegistrationAuth implements AuthServer {
  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }

  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    return Promise.resolve({
      session: { id: "session-1" },
      account: { id: "user-1", email: "operator@example.com", name: "Operator" },
      organization: { id: "org-1", name: "Example Org" },
      membership: { id: "member-1", role: "owner" },
      capabilities: {
        view: true,
        manageMembers: true,
        manageOwners: true,
        manageResources: true,
      },
    });
  }

  async resolveAccount() {
    const access = await this.resolveOrganizationAccess();
    return {
      session: { id: access.session.id, activeOrganizationId: null },
      account: access.account,
      isInstanceOperator: false,
    };
  }

  rejectCookieMutation(): Response | undefined {
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeBotClient(): GoogleChatBotClient {
  return {
    sendMessage: () => Promise.resolve(),
    readThreadMessages: () => Promise.resolve({ status: "loaded", messages: [] }),
    verifySpacesAccess: () => Promise.resolve(),
  };
}

describe("Google Chat registration", () => {
  it("reports notConfigured when Google Chat credentials are absent", () => {
    const registration = createGoogleChatRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.example.com",
      publicBaseUrl: "https://hub.example.com",
      configuration: null,
    });

    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        googleChat: [],
        linear: [],
      }),
      { status: "notConfigured" },
    );
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(registration.requests, []);
  });

  it("constructs Pub/Sub transport registration, binds organization connection, and disconnects", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "paseo-google-chat-reg-"));
    const bundle = await embeddedDatabaseRuntime(dataDirectory);
    try {
      await bundle.runtime.migrate();
      await bundle.runtime.query(`insert into organization (id, name, slug) values ($1, $2, $3)`, [
        "org-1",
        "Example Org",
        "example-org",
      ]);
      await bundle.runtime.query(`insert into "user" (id, name, email) values ($1, $2, $3)`, [
        "user-1",
        "Operator",
        "operator@example.com",
      ]);
      await bundle.runtime.query(
        `insert into session (id, token, user_id, active_organization_id, expires_at)
         values ($1, $2, $3, $4, now() + interval '1 hour')`,
        ["session-1", randomUUID(), "user-1", "org-1"],
      );
      await bundle.runtime.query(
        `insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)`,
        ["member-1", "org-1", "user-1", "owner"],
      );
      await bundle.runtime.query(
        `insert into runtime_provider_activation
           (provider, provider_application_id, configuration_version)
         values ('google-chat', 'example-project', 1)`,
      );

      const database = createDatabase(bundle.runtime, bundle.locks);
      const registration = createGoogleChatRegistration({
        database,
        auth: new RegistrationAuth(),
        applicationBaseUrl: "http://127.0.0.1:3000",
        publicBaseUrl: "http://127.0.0.1:3000",
        configurationVersion: 1,
        botClient: fakeBotClient(),
        configuration: {
          transport: "pubsub",
          projectId: "example-project",
          appName: "Paseo",
          serviceAccountJson: SERVICE_ACCOUNT_JSON,
          subscription: "projects/example-project/subscriptions/chat-events",
        },
      });

      assert.equal(registration.connection.name, "google-chat");
      assert.equal(registration.sources.length, 1);
      assert.equal(registration.triggerProviders.length, 1);
      assert.deepEqual(
        registration.outputs.map((output) => output.type),
        ["google-chat.reply"],
      );
      assert.deepEqual(registration.requests, []);

      const startResponse = await registration.connection.actions["start"]!(
        new Request("http://127.0.0.1:3000/start?organizationSlug=example-org", { method: "POST" }),
      );
      assert.equal(startResponse.status, 200);
      const body: unknown = await startResponse.json();
      assert(body !== null && typeof body === "object" && "url" in body);
      assert.equal(
        body.url,
        "http://127.0.0.1:3000/o/example-org/connections?app=google-chat&result=google-chat_connected",
      );

      const usageAfterBind = await database.organizationConnectionUsage("org-1");
      assert.equal(usageAfterBind.googleChat.length, 1);
      const boundConnection = usageAfterBind.googleChat[0];
      assert(boundConnection !== undefined);
      assert.equal(boundConnection.projectId, "example-project");
      assert.equal(boundConnection.appName, "Paseo");
      assert.equal(
        boundConnection.clientEmail,
        "paseo-bot@example-project.iam.gserviceaccount.com",
      );
      assert.deepEqual(registration.connection.status(usageAfterBind), { status: "connected" });

      const droppedNoRoute = await database.acceptGoogleChatEvent({
        projectId: "example-project",
        deliveryId: "google-chat-spaces/AAAABBBB/messages/msg-1",
        providerApplicationId: "example-project",
        providerConfigurationVersion: 1,
        source: "google-chat.mention",
        payload: { id: "spaces/AAAABBBB/messages/msg-1" },
        receivedAt: new Date("2026-10-01T12:00:00.000Z"),
      });
      assert.equal(droppedNoRoute.status, "dropped");
      assert.equal(droppedNoRoute.reason, "no_project_route");

      const disconnectResponse = await registration.connection.actions["disconnect"]!(
        new Request(
          `http://127.0.0.1:3000/disconnect?organizationSlug=example-org&connectionId=${boundConnection.id}`,
          { method: "POST" },
        ),
      );
      assert.equal(disconnectResponse.status, 200);
      const usageAfterDisconnect = await database.organizationConnectionUsage("org-1");
      assert.equal(usageAfterDisconnect.googleChat.length, 0);
    } finally {
      await bundle.runtime.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("registers HTTP webhook request handler when transport is webhook", () => {
    const registration = createGoogleChatRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.example.com",
      publicBaseUrl: "https://hub.example.com",
      botClient: fakeBotClient(),
      configuration: {
        transport: "webhook",
        projectId: "example-project",
        appName: "Paseo",
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
      },
    });

    assert.equal(
      googleChatWebhookUrl("https://hub.example.com"),
      "https://hub.example.com/api/integrations/google-chat/events",
    );
    assert.equal(registration.sources.length, 1);
    assert.deepEqual(
      registration.requests.map((entry) => entry.name),
      ["google-chat.events"],
    );
  });
});
