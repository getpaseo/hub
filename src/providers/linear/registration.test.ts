import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { StartConnectionAttemptInput } from "../../db/types.js";
import type { LinearConnectionClient } from "./client.js";
import { createLinearRegistration } from "./index.js";

describe("Linear registration", () => {
  it("constructs the complete Linear slice and starts OAuth with a protected state", async () => {
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
    const registration = createLinearRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
      connectionClient: new LinearConnectionFake(),
    });

    assert.equal(registration.connection.name, "linear");
    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.deepEqual(
      registration.outputs.map((output) => output.type),
      ["linear.reply"],
    );
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      ["linear.events"],
    );

    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 200);
    assert.equal(attempt?.provider, "linear");
    assert.equal(attempt?.providerApplicationId, "client");
    assert.deepEqual(attempt?.configurationSnapshot, {
      provider: "linear",
      ...linearConfiguration(),
    });
    const body = z.object({ url: z.string() }).parse(await response.json());
    const state = new URL(body.url).searchParams.get("state");
    assert(state !== null && state.length > 20);
    assert.notEqual(attempt?.stateVerifier, state);
  });

  it("does not construct partial behavior when Linear is not configured", () => {
    const registration = createLinearRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: null,
    });

    assert.deepEqual(
      registration.connection.status({ github: [], discord: [], slack: [], linear: [] }),
      { status: "notConfigured" },
    );
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(registration.requests, []);
  });

  it("requires reconnection when an older token lacks comment authority", () => {
    const registration = createLinearRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
    });

    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [
          {
            id: "linear-connection",
            organizationId: "org",
            slug: "acme-linear",
            providerApplicationId: "client",
            linearOrganizationId: "linear-org",
            linearOrganizationName: "Acme",
            appUserId: "app-user",
            accessToken: "token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: null,
            scopes: ["read"],
          },
        ],
      }),
      { status: "requiresReauthorization" },
    );
  });
});

function linearConfiguration() {
  return { clientId: "client", clientSecret: "secret", webhookSecret: "webhook-secret" };
}

class LinearConnectionFake implements LinearConnectionClient {
  authorizationUrl(state: string): string {
    return `https://linear.test/oauth?state=${state}`;
  }

  exchangeCode(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  refresh(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revoke(): Promise<void> {
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
