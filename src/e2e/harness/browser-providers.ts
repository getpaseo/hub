import type { Message } from "discord.js";
import type { GitHubAuth, GitHubExecutionTokenAuth } from "../../auth/github.js";
import type { DiscordGuildIdentity } from "../../providers/discord/client.js";
import type { DiscordConnectionClient } from "../../providers/discord/client.js";
import type {
  GitHubConnectionClient,
  GitHubInstallationIdentity,
} from "../../providers/github/client.js";
import type {
  GitHubCreatedReaction,
  GitHubReactionClient,
} from "../../triggers/github/provider.js";
import { MemoryDiscordBotClient } from "../../triggers/discord/memory-bot.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";

const GITHUB_INSTALLATIONS: readonly GitHubInstallationIdentity[] = [
  {
    installationId: 42,
    accountId: "420",
    accountLogin: "acme-inc",
    accountType: "Organization",
    status: "active",
  },
  {
    installationId: 84,
    accountId: "840",
    accountLogin: "orbit-inc",
    accountType: "Organization",
    status: "active",
  },
];

const DISCORD_GUILDS: readonly DiscordGuildIdentity[] = [
  { guildId: "100", guildName: "Acme Guild" },
  { guildId: "200", guildName: "Orbit Guild" },
];

export type BrowserProviderScenario = "connected" | "approval" | "conflict" | "not-configured";

export class BrowserGitHubAuth implements GitHubAuth, GitHubExecutionTokenAuth {
  getInstallation() {
    return Promise.resolve(undefined);
  }

  getInstallationToken(installationId: number) {
    return Promise.resolve(`installation-token-${installationId}`);
  }

  mintInstallationToken(installationId: number) {
    return Promise.resolve(`installation-token-${installationId}`);
  }

  mintExecutionToken(input: { installationId: number; repository: string }) {
    return Promise.resolve(`execution-token-${input.installationId}-${input.repository}`);
  }

  revokeInstallationToken() {
    return Promise.resolve();
  }

  createInstallationOctokit() {
    return Promise.reject(new Error("unused by the browser harness"));
  }
}

export class BrowserGitHubConnections implements GitHubConnectionClient {
  private pendingAuthorization: GitHubInstallationIdentity | undefined;
  private nextInstallation = 0;

  constructor(
    private readonly publicBaseUrl: string,
    private readonly scenario: BrowserProviderScenario,
  ) {}

  setupUrl(state: string): string {
    const callback = new URL("/api/integrations/github/setup", this.publicBaseUrl);
    callback.searchParams.set("state", state);
    if (this.scenario === "approval") {
      callback.searchParams.set("setup_action", "request");
      return callback.toString();
    }
    const identity =
      this.scenario === "conflict"
        ? GITHUB_INSTALLATIONS[0]
        : GITHUB_INSTALLATIONS[this.nextInstallation++];
    if (identity === undefined) throw new Error("no deterministic GitHub installation remains");
    this.pendingAuthorization = identity;
    callback.searchParams.set("setup_action", "install");
    callback.searchParams.set("installation_id", String(identity.installationId));
    return callback.toString();
  }

  authorizationUrl(input: { state: string; challenge: string }): string {
    const identity = this.pendingAuthorization;
    if (identity === undefined) throw new Error("GitHub authorization has no verified setup");
    this.pendingAuthorization = undefined;
    const callback = new URL("/api/integrations/github/callback", this.publicBaseUrl);
    callback.searchParams.set("state", input.state);
    callback.searchParams.set("code", `github-${identity.installationId}`);
    return callback.toString();
  }

  verifyUserInstallation(input: {
    code: string;
    installationId: number;
  }): Promise<GitHubInstallationIdentity | undefined> {
    const expectedCode = `github-${input.installationId}`;
    return Promise.resolve(
      input.code === expectedCode ? this.installation(input.installationId) : undefined,
    );
  }

  getInstallation(installationId: number) {
    const identity = this.installation(installationId);
    return Promise.resolve(
      identity === undefined
        ? { status: "absent" as const }
        : { status: "present" as const, identity },
    );
  }

  private installation(installationId: number): GitHubInstallationIdentity | undefined {
    return GITHUB_INSTALLATIONS.find((identity) => identity.installationId === installationId);
  }
}

export class BrowserGitHubConfiguration implements GitHubConfigurationProvider {
  private readonly heads = new Map<number, string>();
  private readonly files = new Map<string, string>();

  listInstallationRepositories({ installationId }: { installationId: number }) {
    return Promise.resolve(
      installationId === 42
        ? [
            { repositoryId: 9001, fullName: "acme-inc/app", defaultBranch: "main" },
            { repositoryId: 9002, fullName: "acme-inc/docs", defaultBranch: "main" },
          ]
        : [{ repositoryId: 9101, fullName: "orbit-inc/app", defaultBranch: "main" }],
    );
  }

  readDefaultBranchHead(input: { repositoryId: number }) {
    const head = this.heads.get(input.repositoryId);
    if (head === undefined) throw new Error("browser repository has no branch head");
    return Promise.resolve(head);
  }

  readFileAtCommit(input: { repositoryId: number; commitSha: string }) {
    const rawYaml = this.files.get(`${input.repositoryId}:${input.commitSha}`);
    return Promise.resolve(
      rawYaml === undefined ? undefined : { kind: "file" as const, content: rawYaml },
    );
  }

  setRevision(input: { repositoryId: number; commitSha: string; rawYaml?: string }) {
    this.heads.set(input.repositoryId, input.commitSha);
    if (input.rawYaml !== undefined) {
      this.files.set(`${input.repositoryId}:${input.commitSha}`, input.rawYaml);
    }
  }
}

export class BrowserDiscordConnections implements DiscordConnectionClient {
  private readonly guilds = new Map(DISCORD_GUILDS.map((guild) => [guild.guildId, guild]));
  private nextGuild = 0;

  constructor(
    private readonly publicBaseUrl: string,
    private readonly scenario: BrowserProviderScenario,
  ) {}

  authorizationUrl(state: string): string {
    const guild =
      this.scenario === "conflict" ? DISCORD_GUILDS[0] : DISCORD_GUILDS[this.nextGuild++];
    if (guild === undefined) throw new Error("no deterministic Discord guild remains");
    const callback = new URL("/api/integrations/discord/callback", this.publicBaseUrl);
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", `discord-${guild.guildId}`);
    return callback.toString();
  }

  verifyGuild(code: string): Promise<DiscordGuildIdentity | undefined> {
    return Promise.resolve(this.guilds.get(code.replace(/^discord-/u, "")));
  }

  leaveGuild(guildId: string): Promise<void> {
    this.guilds.delete(guildId);
    return Promise.resolve();
  }

  guildMembership(guildId: string) {
    return Promise.resolve(this.guilds.has(guildId) ? ("present" as const) : ("absent" as const));
  }
}

export interface BrowserDiscordEvent {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorUsername: string;
  content: string;
}

export class BrowserDiscordBot extends MemoryDiscordBotClient {
  constructor() {
    super({ selfUserId: "900" });
  }

  deliver(event: BrowserDiscordEvent): Promise<void> {
    const message: unknown = {
      guildId: event.guildId,
      channelId: event.channelId,
      channel: { isThread: () => false, parentId: null },
      id: event.messageId,
      content: event.content,
      mentions: {
        users: [{ id: this.getSelfUserId() }],
        roles: [],
      },
      author: { id: event.authorId, username: event.authorUsername, bot: false },
      createdAt: new Date(),
      attachments: new Map(),
      reference: null,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return this.emitMessage(message as Message);
  }
}

export class BrowserGitHubReactions implements GitHubReactionClient {
  private nextId = 1;

  createReaction(): Promise<GitHubCreatedReaction> {
    return Promise.resolve({ id: this.nextId++ });
  }

  deleteReaction(): Promise<void> {
    return Promise.resolve();
  }
}
