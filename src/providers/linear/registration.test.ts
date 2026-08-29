import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { BindLinearConnectionInput, StartConnectionAttemptInput } from "../../db/types.js";
import {
  createLinearConnectionClient,
  type LinearApiClient,
  type LinearAuthorizationMode,
  type LinearConnectionClient,
} from "./client.js";
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
    const authorization = new URL(body.url);
    const state = authorization.searchParams.get("state");
    assert(state !== null && state.length > 20);
    assert.notEqual(attempt?.stateVerifier, state);
    assert.equal(authorization.searchParams.get("mode"), "baseline");

    const agentResponse = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org&linearAgentSessions=true", {
        method: "POST",
      }),
    );
    const agentBody = z.object({ url: z.string() }).parse(await agentResponse.json());
    const agentAuthorization = new URL(agentBody.url);
    assert.equal(agentAuthorization.searchParams.get("mode"), "agentSessions");
    assert.match(agentAuthorization.searchParams.get("state") ?? "", /^agent-sessions\./u);
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

  it("carries the Agent Session opt-in through a scope-omitting OAuth callback", async () => {
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
    let binding: BindLinearConnectionInput | undefined;
    database.startConnectionAttempt = (input) => {
      attempt = input;
      return Promise.resolve();
    };
    database.readConnectionAttempt = () => {
      if (attempt === undefined) return Promise.reject(new Error("connection attempt missing"));
      return Promise.resolve({
        id: "attempt",
        provider: "linear" as const,
        phase: "linear_authorization" as const,
        organizationId: attempt.access.organizationId,
        returnRoute: attempt.access.returnRoute,
        userId: attempt.access.userId,
        sessionId: attempt.access.sessionId,
        candidateExternalId: null,
        pkceVerifier: null,
        configurationVersion: attempt.configurationVersion,
        providerApplicationId: attempt.providerApplicationId,
        callbackOrigin: attempt.callbackOrigin,
        configurationSnapshot: attempt.configurationSnapshot,
        expectedConfigurationVersion: attempt.expectedConfigurationVersion,
        activateConfiguration: false,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });
    };
    database.bindLinearConnection = (input) => {
      binding = input;
      return Promise.resolve();
    };
    const connectionClient = createLinearConnectionClient({
      clientId: "client",
      clientSecret: "secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url) => {
        let requestUrl: string;
        if (typeof url === "string") requestUrl = url;
        else if (url instanceof URL) requestUrl = url.href;
        else requestUrl = url.url;
        return requestUrl.endsWith("/oauth/token")
          ? Response.json({ access_token: "token", refresh_token: "refresh" })
          : Response.json({
              data: {
                viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } },
              },
            });
      },
    });
    const registration = createLinearRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
      connectionClient,
    });
    const start = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org&linearAgentSessions=true", {
        method: "POST",
      }),
    );
    const authorization = z.object({ url: z.string() }).parse(await start.json());
    const state = new URL(authorization.url).searchParams.get("state");
    assert(state !== null);

    const callback = await registration.connection.actions["callback"]!(
      new Request(
        `https://hub.test/api/integrations/linear/callback?state=${encodeURIComponent(state)}&code=code`,
      ),
    );

    assert.equal(callback.status, 303);
    assert.deepEqual(binding?.scopes, ["read", "write", "app:assignable", "app:mentionable"]);
  });

  it("rejects an insecure direct connection start before auth or attempt persistence", async () => {
    const database = createMemoryDatabase();
    let attempts = 0;
    database.startConnectionAttempt = () => {
      attempts += 1;
      return Promise.resolve();
    };
    const auth = new RegistrationAuth();
    const registration = createLinearRegistration({
      database,
      auth,
      applicationBaseUrl: "http://hub.test",
      publicBaseUrl: "http://hub.test",
      configuration: linearConfiguration(),
      connectionClient: new LinearConnectionFake(),
    });

    const response = await registration.connection.actions["start"]!(
      new Request("http://hub.test/start?organizationSlug=org", { method: "POST" }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "https_required" });
    assert.equal(attempts, 0);
    assert.equal(auth.cookieMutationChecks, 0);
    assert.equal(auth.organizationAccessReads, 0);
  });

  it("requires reconnection for missing authority or an expired non-refreshable token", () => {
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

    const expired = {
      id: "linear-connection",
      organizationId: "org",
      slug: "acme-linear",
      providerApplicationId: "client",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date(0),
      scopes: ["read", "write", "app:assignable", "app:mentionable"],
    };
    assert.deepEqual(
      registration.connection.status({ github: [], discord: [], slack: [], linear: [expired] }),
      { status: "requiresReauthorization" },
    );
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [{ ...expired, refreshToken: "refresh-token" }],
      }),
      { status: "connected" },
    );
  });

  it("drops an under-scoped compact event before attempting issue hydration", async () => {
    const database = createMemoryDatabase();
    database.findLinearConnection = async (linearOrganizationId) =>
      linearOrganizationId === "linear-org"
        ? {
            id: "linear-connection",
            organizationId: "org",
            slug: "acme-linear",
            providerApplicationId: "client",
            linearOrganizationId,
            linearOrganizationName: "Acme",
            appUserId: "app-user",
            accessToken: "under-scoped-token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: null,
            scopes: ["comments:create"],
          }
        : undefined;
    let accepts = 0;
    let acceptedProjectId: string | undefined;
    database.acceptLinearEvent = async (input) => {
      accepts += 1;
      acceptedProjectId = input.projectId;
      return {
        status: "dropped",
        receiptId: input.deliveryId,
        reason: "configuration_unavailable",
      };
    };
    let issueReads = 0;
    const apiClient: LinearApiClient = {
      readIssue: async () => {
        issueReads += 1;
        throw new Error("under-scoped token must not hydrate");
      },
      readIssueComments: async () => ({ comments: [], complete: true }),
      readAgentSessionActivities: async () => ({ activities: [], complete: true }),
      createComment: async () => {},
      createAgentActivity: async () => {},
    };
    const registration = createLinearRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
      apiClient,
    });

    const response = await registration.requests[0]!.handle(linearCommentRequest());

    assert.equal(response.status, 200);
    assert.equal(issueReads, 0);
    assert.equal(accepts, 1);
    assert.equal(acceptedProjectId, undefined);
  });
});

function linearConfiguration() {
  return { clientId: "client", clientSecret: "secret", webhookSecret: "webhook-secret" };
}

function linearCommentRequest(): Request {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    webhookTimestamp: Date.now(),
    data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
  });
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": "under-scoped-compact-comment",
      "linear-event": "Comment",
      "linear-signature": createHmac("sha256", linearConfiguration().webhookSecret)
        .update(body)
        .digest("hex"),
    },
    body,
  });
}

class LinearConnectionFake implements LinearConnectionClient {
  authorizationUrl(state: string, mode: LinearAuthorizationMode = "baseline"): string {
    const url = new URL("https://linear.test/oauth");
    url.searchParams.set("state", state);
    url.searchParams.set("mode", mode);
    return url.toString();
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
  cookieMutationChecks = 0;
  organizationAccessReads = 0;

  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }

  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    this.organizationAccessReads += 1;
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
    this.cookieMutationChecks += 1;
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
