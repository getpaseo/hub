import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { ProjectRecord, StartConnectionAttemptInput } from "../../db/types.js";
import type { GitHubConnectionClient } from "./client.js";
import { createGitHubRegistration } from "./index.js";
import { isAcceptedTriggerProviderMatch, type TriggerProviderMatch } from "../../triggers/index.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";

describe("GitHub registration", () => {
  it("synchronizes the default branch at the exact push SHA and preserves the valid revision", async () => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "docker", image: "paseo/initial" }],
      triggers: [],
    });
    await database.setProjectGitHubConfigurationSource({
      projectId: project.id,
      githubConnectionId: "connection-1",
      githubRepositoryId: 9001,
      githubRepositoryFullName: "acme/app",
      githubDefaultBranch: "main",
      automaticDeploymentEnabled: true,
      userId: "user",
    });
    database.findGitHubConnection = () =>
      Promise.resolve({
        id: "connection-1",
        organizationId: project.organizationId,
        slug: "connection-1",
        installationId: 42,
        accountId: "account-42",
        accountLogin: "acme",
        accountType: "Organization",
        status: "active" as const,
      });
    const target = {
      id: "repository-catalog-1",
      organizationId: project.organizationId,
      projectId: project.id,
      connectionId: "connection-1",
      installationId: 42,
      repositoryId: 9001,
      fullName: "acme/app",
      defaultBranch: "main",
      automaticDeploymentEnabled: true,
    } as const;
    database.findGitHubConfigurationTarget = () => Promise.resolve(target);
    database.listGitHubConfigurationTargets = () => Promise.resolve([target]);
    database.acceptGitHubTrigger = (input) =>
      Promise.resolve({
        status: "accepted",
        triggers: [
          {
            triggerId: `trigger-${input.deliveryId}`,
            organizationId: project.organizationId,
            projectId: project.id,
            deliveryId: input.deliveryId,
            source: input.source,
            payload: input.payload,
            receivedAt: input.receivedAt,
            connectionId: "connection-1",
            resourceId: input.repositoryId === undefined ? null : String(input.repositoryId),
          },
        ],
        receiptId: `receipt-${input.deliveryId}`,
      });
    const configuration = new RegistrationConfigurationFake({
      "valid-sha":
        "environments:\n  - name: runner\n    kind: docker\n    image: paseo/valid\ntriggers: []",
      "invalid-sha": "environments: []\ntriggers: invalid",
    });
    const registration = createGitHubRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: githubConfiguration(),
      appAuth: githubAuth(),
      connectionClient: new GitHubClientFake(),
      configurationProvider: configuration,
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });

    await configuration.push(registration, "valid-sha", "push-valid");
    const active = await database.findActiveProjectConfiguration(project.id);
    assert.notEqual(active?.id, initial.id);
    await configuration.push(registration, "invalid-sha", "push-invalid");
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, active?.id);
    assert.deepEqual(configuration.reads, [
      { installationId: 42, repositoryId: 9001, commitSha: "valid-sha", path: ".paseo/hub.yml" },
      { installationId: 42, repositoryId: 9001, commitSha: "invalid-sha", path: ".paseo/hub.yml" },
    ]);
    assert.equal(
      (await database.projectConfigurationReadModel(project.id)).lastSyncAttempt?.outcome,
      "invalid",
    );
  });

  it("constructs the complete GitHub slice and delegates connection start", async () => {
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
    const registration = createGitHubRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: {
        appSlug: "paseo",
        clientId: "client",
        clientSecret: "secret",
        webhookSecret: "webhook-secret",
      },
      appAuth: {
        getInstallation: () => Promise.resolve(undefined),
        getInstallationToken: () => Promise.resolve("token"),
        mintInstallationToken: () => Promise.resolve("token"),
        mintExecutionToken: () => Promise.resolve("execution-token"),
        revokeInstallationToken: () => Promise.resolve(),
        createInstallationOctokit: () => Promise.reject(new Error("unused")),
      },
      connectionClient: new GitHubClientFake(),
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });

    assert.equal(registration.connection.name, "github");
    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.deepEqual(
      registration.outputs.map((output) => output.type),
      [],
    );
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      ["webhook"],
    );

    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 200);
    assert.equal(attempt?.provider, "github");
    const body: unknown = await response.json();
    assert(body !== null && typeof body === "object" && "url" in body);
    assert(typeof body.url === "string");
    assert.match(body.url, /^https:\/\/github\.test\/setup/u);
  });

  it("reports readiness without constructing partial provider behavior", () => {
    const registration = createGitHubRegistration({
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
  });

  it("resolves the project's active GitHub installation token", async () => {
    const database = createMemoryDatabase();
    database.findProjectById = async (projectId) =>
      testProject(projectId, projectId === "project-1" ? "org_1" : "org_2");
    database.organizationConnectionUsage = async (organizationId) => ({
      github:
        organizationId === "org_1"
          ? [
              {
                id: "github-connection",
                organizationId: "org_1",
                slug: "getpaseo-github",
                installationId: 142,
                accountId: "501",
                accountLogin: "getpaseo",
                accountType: "Organization",
                status: "active",
              },
            ]
          : [],
      discord: [],
      slack: [],
    });
    const installations: number[] = [];
    const registration = createGitHubRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: githubConfiguration(),
      appAuth: {
        getInstallation: () => Promise.resolve(undefined),
        getInstallationToken: () => Promise.reject(new Error("unused")),
        mintInstallationToken: (installationId) => {
          installations.push(installationId);
          return Promise.resolve("test-installation-token");
        },
        mintExecutionToken: () => Promise.resolve("execution-token"),
        revokeInstallationToken: () => Promise.resolve(),
        createInstallationOctokit: () => Promise.reject(new Error("unused")),
      },
      connectionClient: new GitHubClientFake(),
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });

    assert.equal(
      await registration.integration?.resolve("project-1", "getpaseo-github", "token"),
      "test-installation-token",
    );
    assert.deepEqual(installations, [142]);
    await assert.rejects(
      () => registration.integration!.resolve("project-2", "getpaseo-github", "token"),
      /connection is unavailable/u,
    );
  });

  it("mints a distinct GitHub installation token for each execution", async () => {
    const { provider, appAuth } = await createExecutionProvider(githubTokenConfig());

    const first = await provider.match(githubExecution("delivery-1"));
    const second = await provider.match(githubExecution("delivery-2"));
    const firstLaunch = await materialize(provider, first[0], "execution-1");
    const secondLaunch = await materialize(provider, second[0], "execution-2");

    assert.deepEqual(
      [firstLaunch.environmentEnv?.["GH_TOKEN"], secondLaunch.environmentEnv?.["GH_TOKEN"]],
      ["test-execution-token-1", "test-execution-token-2"],
    );
    assert.deepEqual(appAuth.installationTokenMints, [142, 142]);
  });

  it("revokes explicitly resolved GitHub tokens with the execution token", async () => {
    const { provider, appAuth } = await createExecutionProvider(githubTokenConfig());
    const [execution] = await provider.match(githubExecution("delivery-explicit-token"));
    assert.ok(execution);
    await materialize(provider, execution, "execution-explicit-token");

    await provider.onAgentExecutionTerminal?.("execution-explicit-token", execution.triggerContext);

    assert.deepEqual(appAuth.revocations, ["test-execution-token-1"]);
  });

  it("revokes a GitHub token resolved by a cross-provider execution", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "docker", image: "paseo/runner" }],
      triggers: [],
    });
    database.organizationConnectionUsage = async () => ({
      github: [
        {
          id: "github-selected",
          organizationId: project.organizationId,
          slug: "selected-github",
          installationId: 142,
          accountId: "501",
          accountLogin: "getpaseo",
          accountType: "Organization" as const,
          status: "active" as const,
        },
      ],
      discord: [],
      slack: [],
    });
    const appAuth = new ExecutionGitHubAuth();
    const registration = createGitHubRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: githubConfiguration(),
      appAuth,
      connectionClient: new GitHubClientFake(),
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });

    const token = await registration.integration!.resolve(project.id, "selected-github", "token", {
      executionId: "execution-discord-1",
    });
    await registration.integration!.onExecutionTerminal?.("execution-discord-1");

    assert.equal(token, "test-execution-token-1");
    assert.deepEqual(appAuth.revocations, ["test-execution-token-1"]);
  });

  it("keeps provider runtime active without browser authentication", async () => {
    const registration = createGitHubRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: githubConfiguration(),
      appAuth: githubAuth(),
      connectionClient: new GitHubClientFake(),
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });

    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.equal(registration.outputs.length, 0);
    assert.deepEqual(registration.connection.actions, {});
  });

  it("keeps signature verification available while the database is unavailable", async () => {
    const registration = createGitHubRegistration({
      database: null,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: githubConfiguration(),
    });

    const response = await registration.requests[0]!.handle(
      signedWebhookRequest("database-unavailable"),
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "database_unavailable" });
  });

  it("claims lifecycle replay before provider I/O and applies verified evidence afterward", async () => {
    const database = createMemoryDatabase();
    const order: string[] = [];
    database.claimGitHubLifecycle = (input) => {
      order.push(`claim:${input.deliveryId}`);
      return Promise.resolve({
        status: "claimed",
        triggerId: "lifecycle-trigger",
        installationId: 42,
      });
    };
    database.applyGitHubLifecycle = (_claim, result) => {
      order.push(`apply:${result.status}`);
      return Promise.resolve();
    };
    const client = new GitHubClientFake();
    client.getInstallation = () => {
      order.push("verify");
      return Promise.resolve({
        status: "present" as const,
        identity: {
          installationId: 42,
          accountId: "account-42",
          accountLogin: "acme",
          accountType: "Organization",
          status: "suspended" as const,
        },
      });
    };
    const registration = createGitHubRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: {
        appSlug: "paseo",
        clientId: "client",
        clientSecret: "secret",
        webhookSecret: "webhook-secret",
      },
      appAuth: {
        getInstallation: () => Promise.resolve(undefined),
        getInstallationToken: () => Promise.resolve("token"),
        mintInstallationToken: () => Promise.resolve("token"),
        mintExecutionToken: () => Promise.resolve("execution-token"),
        revokeInstallationToken: () => Promise.resolve(),
        createInstallationOctokit: () => Promise.reject(new Error("unused")),
      },
      connectionClient: client,
      reactionClient: {
        createReaction: () => Promise.resolve({ id: 1 }),
        deleteReaction: () => Promise.resolve(),
      },
    });
    const body = JSON.stringify({ action: "suspend", installation: { id: 42 } });
    const signature = "sha256=" + createHmac("sha256", "webhook-secret").update(body).digest("hex");
    const response = await registration.requests[0]!.handle(
      new Request("https://hub.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "lifecycle-1",
          "x-github-event": "installation",
          "x-hub-signature-256": signature,
        },
        body,
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(order, ["claim:lifecycle-1", "verify", "apply:present"]);
  });
});

class RegistrationConfigurationFake implements GitHubConfigurationProvider {
  readonly reads: Array<{ repositoryId: number; commitSha: string; path: string }> = [];
  private head = "";
  constructor(private readonly files: Readonly<Record<string, string>>) {}
  listInstallationRepositories() {
    return Promise.resolve([]);
  }
  readDefaultBranchHead() {
    return Promise.resolve(this.head);
  }
  readFileAtCommit(input: { repositoryId: number; commitSha: string; path: string }) {
    this.reads.push(input);
    const rawYaml = this.files[input.commitSha];
    return Promise.resolve(rawYaml === undefined ? undefined : { rawYaml });
  }
  async push(
    registration: ReturnType<typeof createGitHubRegistration>,
    sha: string,
    deliveryId: string,
  ) {
    this.head = sha;
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: sha,
      repository: { id: 9001, full_name: "acme/app" },
      installation: { id: 42 },
      commits: [],
    });
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
    const response = await registration.requests[0]!.handle(
      new Request("https://hub.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "push",
          "x-hub-signature-256": signature,
        },
        body,
      }),
    );
    assert.equal(response.status, 200);
  }
}

class GitHubClientFake implements GitHubConnectionClient {
  setupUrl(state: string): string {
    return `https://github.test/setup?state=${state}`;
  }
  authorizationUrl({ state }: { state: string; challenge: string }): string {
    return `https://github.test/authorize?state=${state}`;
  }
  verifyUserInstallation() {
    return Promise.resolve(undefined);
  }
  getInstallation(): ReturnType<GitHubConnectionClient["getInstallation"]> {
    return Promise.resolve({ status: "absent" as const });
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
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class ExecutionGitHubAuth {
  readonly installationTokenMints: number[] = [];
  readonly revocations: string[] = [];

  getInstallation() {
    return Promise.resolve(undefined);
  }

  getInstallationToken() {
    return Promise.resolve("test-shared-token");
  }

  mintInstallationToken(installationId: number) {
    this.installationTokenMints.push(installationId);
    return Promise.resolve(`test-execution-token-${this.installationTokenMints.length}`);
  }

  mintExecutionToken(input: { installationId: number; repository: string }) {
    this.installationTokenMints.push(input.installationId);
    return Promise.resolve(`test-execution-token-${this.installationTokenMints.length}`);
  }

  revokeInstallationToken(token: string) {
    this.revocations.push(token);
    return Promise.resolve();
  }

  createInstallationOctokit() {
    return Promise.reject(new Error("unused"));
  }
}

function githubConfiguration() {
  return {
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    webhookSecret: "webhook-secret",
  };
}

function githubTokenConfig(_env: Record<string, string> = {}) {
  return {
    environments: [
      {
        name: "daemon",
        kind: "daemon",
        daemon: "test-daemon",
        cwd: "/workspace",
      },
    ],
    triggers: [
      {
        name: "github-token",
        on: "github.issue_comment",
        max_runtime: "2h",
        filters: { repo: "acme/app", contains: "@paseo", from_users: ["octocat"] },
        steps: [
          {
            id: "github-step",
            environment: "daemon",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "run" }],
          },
        ],
      },
    ],
  };
}

async function createExecutionProvider(rawConfig: unknown) {
  const database = createMemoryDatabase();
  database.findProjectById = async (projectId) => testProject(projectId, "org_1");
  database.organizationConnectionUsage = async () => ({
    github: [
      {
        id: "github-connection",
        organizationId: "org_1",
        slug: "getpaseo-github",
        installationId: 142,
        accountId: "501",
        accountLogin: "getpaseo",
        accountType: "Organization",
        status: "active",
      },
    ],
    discord: [],
    slack: [],
  });
  const { store } = await createActiveProjectConfiguration(database, rawConfig);
  const appAuth = new ExecutionGitHubAuth();
  const registration = createGitHubRegistration({
    database,
    auth: null,
    applicationBaseUrl: "https://hub.test",
    publicBaseUrl: "https://hub.test",
    configuration: githubConfiguration(),
    appAuth,
    connectionClient: new GitHubClientFake(),
    reactionClient: {
      createReaction: () => Promise.resolve({ id: 1 }),
      deleteReaction: () => Promise.resolve(),
    },
  });
  const provider = registration.triggerProviders[0]?.({
    configurationStoreForProject: () => store,
    connectionsForProject: (projectId) => (slug, value, context) =>
      registration.integration!.resolve(projectId, slug, value, context),
  });
  assert.ok(provider);
  return { provider, appAuth };
}

function testProject(id: string, organizationId: string): ProjectRecord {
  const now = new Date(0);
  return {
    id,
    organizationId,
    name: "Test project",
    slug: "test-project",
    status: "active",
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    activeConfigurationRevisionId: null,
  };
}

async function materialize(
  provider: Awaited<ReturnType<typeof createExecutionProvider>>["provider"],
  match: TriggerProviderMatch | undefined,
  executionId: string,
) {
  if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
  if (provider.materializeLaunch === undefined) throw new Error("materializer is unavailable");
  return provider.materializeLaunch({
    executionId,
    organizationId: "org_1",
    projectId: "project-1",
    prompt: match.prompt,
    ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
    triggerContext: match.triggerContext,
  });
}

function githubExecution(deliveryId: string) {
  return {
    organizationId: "org_1",
    projectId: "project-1",
    source: "github.issue_comment",
    deliveryId,
    receivedAt: new Date("2026-07-28T00:00:00.000Z"),
    payload: {
      id: deliveryId,
      type: "issue_comment",
      repo: "acme/app",
      repositoryId: 7,
      installationId: 142,
      payload: {
        issue: { number: 1, title: "Test", body: "Test" },
        comment: {
          id: 10,
          body: "@paseo run",
          html_url: "https://github.test/acme/app/issues/1#issuecomment-10",
          user: { login: "octocat" },
        },
        sender: { login: "octocat" },
      },
      createdAt: "2026-07-28T00:00:00.000Z",
    },
  };
}

function githubAuth() {
  return {
    getInstallation: () => Promise.resolve(undefined),
    getInstallationToken: () => Promise.resolve("token"),
    mintInstallationToken: () => Promise.resolve("token"),
    mintExecutionToken: () => Promise.resolve("execution-token"),
    revokeInstallationToken: () => Promise.resolve(),
    createInstallationOctokit: () => Promise.reject(new Error("unused")),
  };
}

function signedWebhookRequest(deliveryId: string): Request {
  const body = JSON.stringify({ installation: { id: 42 }, repository: { full_name: "acme/app" } });
  const signature = "sha256=" + createHmac("sha256", "webhook-secret").update(body).digest("hex");
  return new Request("https://hub.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signature,
    },
    body,
  });
}
