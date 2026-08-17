import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import { createSlackSocketInstallationVerifier } from "../../providers/slack/installation.js";
import type { SlackConnectionClient, SlackInstallation } from "../../providers/slack/client.js";
import type { ProviderRegistration } from "../../providers/registration.js";
import {
  ProviderVerificationError,
  type Provider,
  type ProviderApplicationConfiguration,
  type ProviderApplicationIdentity,
  type ProviderApplicationVerifier,
} from "../../provider-applications/index.js";
import {
  BrowserDiscordBot,
  BrowserDiscordConnections,
  BrowserGitHubAuth,
  BrowserGitHubConnections,
  BrowserGitHubConfiguration,
  BrowserGitHubReactions,
  BrowserSlackBot,
  type BrowserProviderScenario,
} from "./browser-providers.js";

/**
 * The credentials the fixture providers accept. A browser journey types exactly these to make
 * verification succeed and anything else to make it fail, so the failure path exercises a real
 * server answer rather than a client-side guess about what the provider would have said.
 */
export const FIXTURE_APP_CREDENTIALS = {
  github: {
    appId: "42",
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    privateKey: "fixture-private-key",
  },
  discord: {
    applicationId: "900",
    clientSecret: "secret",
    botToken: "token",
  },
  slack: {
    appId: "browser-slack-app",
    clientId: "browser-slack-client",
    clientSecret: "browser-slack-client-secret",
  },
} as const;

export const FIXTURE_SLACK_SOCKET_CREDENTIALS = {
  appToken: "xapp-browser-fixture",
  botToken: "xoxb-browser-fixture",
} as const;

/** A provider-side HTTP + WebSocket fixture. Browser journeys cross the same wire boundaries as
 * production; only Slack's side of the internet is local. */
export class BrowserSlackSocketFixture {
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly acknowledgements = new Map<string, () => void>();
  private server: Server | undefined;
  apiBaseUrl = "";

  constructor(
    private readonly scenario: BrowserProviderScenario = "connected",
    private readonly port = 0,
  ) {}

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const authorization = request.headers.authorization;
      const url = new URL(request.url ?? "/", this.apiBaseUrl);
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/api/apps.connections.open") {
        if (this.scenario === "slack-startup-server-error") {
          response.statusCode = 503;
          response.end(JSON.stringify({ ok: false, error: "temporarily_unavailable" }));
          return;
        }
        if (authorization !== `Bearer ${FIXTURE_SLACK_SOCKET_CREDENTIALS.appToken}`) {
          response.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            url: `${this.apiBaseUrl.replace("http", "ws")}/socket`,
          }),
        );
        return;
      }
      if (url.pathname === "/api/auth.test") {
        if (authorization !== `Bearer ${FIXTURE_SLACK_SOCKET_CREDENTIALS.botToken}`) {
          response.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
          return;
        }
        response.setHeader(
          "x-oauth-scopes",
          this.scenario === "slack-permission-missing"
            ? "chat:write"
            : "app_mentions:read,channels:history,chat:write,files:read,groups:history,reactions:write,users:read",
        );
        response.end(
          JSON.stringify({
            ok: true,
            team_id: "T-ACME",
            team: "Acme",
            user_id: "B1",
            bot_id: "B-BROWSER",
          }),
        );
        return;
      }
      if (url.pathname === "/api/bots.info") {
        response.end(
          JSON.stringify({
            ok: true,
            bot: {
              id: "B-BROWSER",
              app_id: FIXTURE_APP_CREDENTIALS.slack.appId,
              user_id: "B1",
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/socket") {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.sockets.emit("connection", webSocket, request);
      });
    });
    this.sockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const value: unknown = JSON.parse(slackFrameText(data));
        if (value === null || typeof value !== "object") return;
        const envelopeId: unknown = Reflect.get(value, "envelope_id");
        if (typeof envelopeId !== "string") return;
        this.acknowledgements.get(envelopeId)?.();
        this.acknowledgements.delete(envelopeId);
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          num_connections: this.sockets.clients.size,
          connection_info: { app_id: FIXTURE_APP_CREDENTIALS.slack.appId },
        }),
      );
    });
    server.listen(this.port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Slack fixture did not listen");
    this.server = server;
    this.apiBaseUrl = `http://127.0.0.1:${address.port}`;
  }

  verifier() {
    return createSlackSocketInstallationVerifier({
      apiBaseUrl: `${this.apiBaseUrl}/api`,
    });
  }

  async deliverMention(eventId: string): Promise<void> {
    const connectedDeadline = Date.now() + 5_000;
    while (this.sockets.clients.size === 0 && Date.now() < connectedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.sockets.clients.size === 0)
      throw new Error("Slack fixture has no connected Hub instance");
    const envelopeId = `envelope-${eventId}`;
    const acknowledged = new Promise<void>((resolve) => {
      this.acknowledgements.set(envelopeId, resolve);
    });
    const payload = JSON.stringify({
      type: "events_api",
      envelope_id: envelopeId,
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        team_id: "T-ACME",
        api_app_id: FIXTURE_APP_CREDENTIALS.slack.appId,
        event_id: eventId,
        event_time: Math.floor(Date.now() / 1_000),
        event: {
          type: "app_mention",
          user: "U1",
          channel: "C1",
          text: "<@B1> socket delivery",
          ts: "1700000000.000100",
          event_ts: "1700000000.000100",
        },
      },
    });
    for (const socket of this.sockets.clients) socket.send(payload);
    await Promise.race([
      acknowledged,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Slack fixture did not receive an acknowledgement")),
          5_000,
        ),
      ),
    ]);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    if (this.server === undefined) return;
    await closeServer(this.server);
  }
}

function slackFrameText(data: import("ws").RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export const FIXTURE_APP_IDENTITIES: Readonly<Record<Provider, ProviderApplicationIdentity>> = {
  github: {
    provider: "github",
    id: "42",
    name: "Paseo Hub",
    ownerLogin: "acme-inc",
  },
  discord: { provider: "discord", id: "900", name: "Paseo" },
  slack: { provider: "slack", id: "browser-slack-app", name: "Paseo" },
};

/** The identity an environment-configured provider activates with at boot. */
export function fixtureEnvironmentIdentity(provider: Provider): ProviderApplicationIdentity {
  return FIXTURE_APP_IDENTITIES[provider];
}

/**
 * Stands in for authenticating as the App at GitHub and for `users/@me` at Discord. It answers
 * the way those endpoints do — identity on a match, rejection otherwise — so the surface's honest
 * status ladder is driven by a real round trip through the provider-applications boundary.
 */
export class BrowserProviderApplicationVerifier implements ProviderApplicationVerifier {
  constructor(private readonly scenario: BrowserProviderScenario = "connected") {}

  verify(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
  ): Promise<ProviderApplicationIdentity> {
    if (provider !== configuration.provider) {
      return Promise.reject(new ProviderVerificationError("credentialsRejected"));
    }
    if (configuration.provider === "github") {
      if (this.scenario === "github-verification-internal") {
        return Promise.reject(new Error("fixture github verification fault"));
      }
      const expected = FIXTURE_APP_CREDENTIALS.github;
      if (configuration.privateKey !== expected.privateKey) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", 401, {
            subject: "privateKey",
          }),
        );
      }
      // The key authenticated an App; the App ID names which one. A mismatch is its own answer.
      return configuration.appId === expected.appId
        ? Promise.resolve(FIXTURE_APP_IDENTITIES.github)
        : Promise.reject(
            new ProviderVerificationError("credentialsRejected", undefined, {
              subject: "identityMismatch",
            }),
          );
    }
    if (configuration.provider === "discord") {
      if (this.scenario === "discord-verification-network") {
        return Promise.reject(new ProviderVerificationError("network"));
      }
      if (this.scenario === "discord-rate-limited") {
        return Promise.reject(new ProviderVerificationError("rateLimited", 429));
      }
      if (
        this.scenario === "discord-disallowed-intents" &&
        configuration.applicationId === FIXTURE_APP_CREDENTIALS.discord.applicationId
      ) {
        return Promise.resolve(FIXTURE_APP_IDENTITIES.discord);
      }
      const expected = FIXTURE_APP_CREDENTIALS.discord;
      if (configuration.botToken !== expected.botToken) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", 401, {
            subject: "botToken",
          }),
        );
      }
      if (configuration.applicationId !== expected.applicationId) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", undefined, {
            subject: "identityMismatch",
          }),
        );
      }
      // Discord's client credentials grant is the only thing that can prove the Client Secret,
      // so the fixture checks it too — otherwise "Verified" would mean less here than in production.
      return this.scenario === "discord-client-secret-rejected" ||
        configuration.clientSecret !== expected.clientSecret
        ? Promise.reject(
            new ProviderVerificationError("credentialsRejected", 401, {
              subject: "clientSecret",
            }),
          )
        : Promise.resolve(FIXTURE_APP_IDENTITIES.discord);
    }
    // Slack matches production: client credentials have no honest verification endpoint, so the
    // installation callback is the only thing that can accept them.
    return Promise.reject(new ProviderVerificationError("credentialsRejected"));
  }
}

export interface BrowserProviderApplicationFixtures {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  scenario: BrowserProviderScenario;
  bot: BrowserDiscordBot;
  slackBot: BrowserSlackBot;
  githubConfiguration: BrowserGitHubConfiguration;
  slackSocket: BrowserSlackSocketFixture;
}

/**
 * Builds a registration from a configuration the operator just saved, wired to the fixture
 * provider clients instead of the real APIs. This is the same seam `src/index.ts` leaves open for
 * production, so the dynamic activation path under test is the production one.
 */
export function browserRegistrationFactory(fixtures: BrowserProviderApplicationFixtures) {
  // These clients model the provider, not one Hub registration. Connection starts use a
  // short-lived registration while callbacks may be handled by the active or reconstructed
  // registration, so the provider-side authorization state must outlive either one.
  const githubConnections = new BrowserGitHubConnections(
    fixtures.applicationBaseUrl,
    fixtures.scenario,
  );
  const discordConnections = new BrowserDiscordConnections(
    fixtures.applicationBaseUrl,
    fixtures.scenario,
  );
  return (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: NonNullable<
      Parameters<typeof createSlackRegistration>[0]["onVerifiedInstallation"]
    >;
  }): ProviderRegistration => {
    const shared = {
      database: fixtures.database,
      auth: fixtures.auth,
      applicationBaseUrl: fixtures.applicationBaseUrl,
      publicBaseUrl: input.callbackOrigin,
      configurationVersion: input.configurationVersion,
    };
    const { configuration } = input;
    if (configuration.provider === "github") {
      return createGitHubRegistration({
        ...shared,
        configuration,
        appAuth: new BrowserGitHubAuth(),
        connectionClient: githubConnections,
        configurationProvider: fixtures.githubConfiguration,
        reactionClient: new BrowserGitHubReactions(),
      });
    }
    if (configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
        bot: fixtures.bot,
        connectionClient: discordConnections,
      });
    }
    return createSlackRegistration({
      ...shared,
      configuration,
      botClient: fixtures.slackBot,
      connectionClient: new BrowserSlackConnections(input.callbackOrigin, fixtures.scenario),
      ...(input.expectedConfigurationVersion === undefined
        ? {}
        : { expectedConfigurationVersion: input.expectedConfigurationVersion }),
      activateConfiguration: input.activateConfiguration,
      onVerifiedInstallation: input.onVerifiedSlackInstallation,
      socket: {
        apiUrl: `${fixtures.slackSocket.apiBaseUrl}/api/apps.connections.open`,
      },
    });
  };
}

class BrowserSlackConnections implements SlackConnectionClient {
  constructor(
    private readonly publicBaseUrl: string,
    private readonly scenario: BrowserProviderScenario,
  ) {}

  authorizationUrl(state: string): string {
    const url = new URL("/e2e/providers/slack/authorize", this.publicBaseUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<SlackInstallation> {
    if (code !== "accepted") return Promise.reject(new Error("installation rejected"));
    return Promise.resolve({
      appId: FIXTURE_APP_CREDENTIALS.slack.appId,
      teamId: "T-ACME",
      teamName: "Acme",
      botUserId: "B1",
      botAccessToken: "xoxb-fixture",
      scopes:
        this.scenario === "slack-permission-missing"
          ? ["chat:write"]
          : [
              "app_mentions:read",
              "channels:history",
              "chat:write",
              "files:read",
              "groups:history",
              "reactions:write",
              "users:read",
            ],
    });
  }

  verifyInstallation(installation: SlackInstallation): Promise<void> {
    if (installation.teamId !== "T-ACME" || installation.botUserId !== "B1") {
      return Promise.reject(new Error("auth.test rejected the bot"));
    }
    return Promise.resolve();
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }
}
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
