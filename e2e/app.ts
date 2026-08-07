import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { test as base } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import {
  PaseoHub,
  setBuiltApplicationMachineKey,
  type BuiltApplication,
  type BuiltApplicationOptions,
} from "./helpers/hub.js";
import { createDatabase } from "../src/db/pg.js";
import { SourcePaseo } from "./helpers/source-paseo.js";
import type { BrowserDiscordEvent } from "../src/e2e/harness/browser-providers.js";
import type { BrowserProviderScenario } from "../src/e2e/harness/browser-providers.js";
import type { FixtureBillingProduct } from "../src/e2e/harness/browser-billing.js";
import { ProjectExternalFacts } from "./helpers/projects/external.js";

let primaryApplication: BuiltApplication | undefined;

export const test = base.extend<{
  hub: PaseoHub;
  projectExternal: ProjectExternalFacts;
  billing: boolean;
}>({
  // Set with `test.use({ billing: true })` to configure the primary app with the fixture Stripe
  // catalog — the money test in billing-subscription.spec.ts needs a billing-configured instance.
  billing: [false, { option: true }],
  hub: async ({ browser, browserName, page, context, billing }, provide, testInfo) => {
    if (browserName !== "chromium") {
      throw new Error(`unsupported Phase 0 browser: ${browserName}`);
    }
    const applications = new BuiltApplications();
    try {
      await page.addInitScript(() => {
        const request = window.fetch;
        window.fetch = function (input, init) {
          if (this !== undefined && this !== window) throw new TypeError("Illegal invocation");
          return request.call(window, input, init);
        };
      });
      const primary = await applications.start({
        databaseProfile: "fresh",
        billing,
      });
      primaryApplication = primary;
      await provide(
        new PaseoHub(
          primary,
          browser,
          page,
          context.request,
          (options) => applications.start(options),
          () => applications.startSourcePaseo(),
        ),
      );
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("application.log", {
          body: primary.logs(),
          contentType: "text/plain",
        });
      }
    } finally {
      primaryApplication = undefined;
      await applications.stop();
    }
  },
  projectExternal: async ({ hub: _hub, request }, provide) => {
    if (primaryApplication === undefined) throw new Error("primary application is unavailable");
    await provide(new ProjectExternalFacts(primaryApplication, request));
  },
});

class BuiltApplications {
  private readonly running: RunningApplication[] = [];
  private readonly sourcePaseos: SourcePaseo[] = [];

  async start(options: BuiltApplicationOptions = {}): Promise<BuiltApplication> {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(30_000)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    await prepareDatabase(databaseUrl, options.databaseProfile ?? "legacy");
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const machineKeyFile = join(tmpdir(), `paseo-e2e-machine-key-${randomUUID()}`);
    const server = spawn(process.execPath, ["dist/e2e/harness/browser-child.js"], {
      cwd: process.cwd(),
      env: applicationEnvironment({
        databaseUrl,
        origin,
        port,
        machineKeyFile,
        ...options,
      }),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const output: string[] = [];
    const application = {
      origin,
      databaseUrl,
      postgres,
      server,
      logs: () => output.join(""),
      deliverDiscord: (event: BrowserDiscordEvent) => deliverDiscord(server, event),
      setGitHubConfiguration: (input: {
        repositoryId: number;
        commitSha: string;
        rawYaml?: string;
      }) => deliverCommand(server, { type: "github-configuration", ...input }),
      setBillingProduct: (product: FixtureBillingProduct) =>
        deliverCommand(server, { type: "billing-product", product }),
    };
    this.running.push(application);
    await serverReady(server, origin, output);
    setBuiltApplicationMachineKey((await readFile(machineKeyFile, "utf8")).trim());
    return application;
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.sourcePaseos
        .splice(0)
        .reverse()
        .map((source) => source.stop()),
    );
    const applications = this.running.splice(0).reverse();
    await Promise.all(
      applications.map(async (application) => {
        await stopServer(application.server);
        await application.postgres.stop();
      }),
    );
  }

  async startSourcePaseo(): Promise<SourcePaseo> {
    const source = await SourcePaseo.start();
    this.sourcePaseos.push(source);
    return source;
  }
}

interface RunningApplication extends BuiltApplication {
  postgres: StartedPostgreSqlContainer;
  server: ChildProcess;
}

interface ApplicationEnvironmentInput {
  databaseUrl: string;
  origin: string;
  port: number;
  registrationMode?: BuiltApplicationOptions["registrationMode"];
  organizationCreation?: BuiltApplicationOptions["organizationCreation"];
  browserAuth?: boolean;
  machineAuth?: boolean;
  providerConnections?: boolean;
  githubApprovalRequired?: boolean;
  providerScenario?: BrowserProviderScenario;
  machineKeyFile: string;
  databaseProfile?: BuiltApplicationOptions["databaseProfile"];
  bootstrap?: BuiltApplicationOptions["bootstrap"];
  billing?: BuiltApplicationOptions["billing"];
}

function applicationEnvironment(input: ApplicationEnvironmentInput): NodeJS.ProcessEnv {
  const browserAuthEnabled = input.browserAuth !== false;
  return {
    ...process.env,
    DATABASE_URL: input.databaseUrl,
    PORT: String(input.port),
    PASEO_HUB_BIND: "127.0.0.1",
    PASEO_HUB_APP_URL: input.origin,
    PASEO_REGISTRATION_MODE:
      input.registrationMode ?? (input.bootstrap === undefined ? "open" : "invite_only"),
    PASEO_ORGANIZATION_CREATION:
      input.organizationCreation ?? (input.bootstrap === undefined ? "open" : "disabled"),
    PASEO_HUB_AUTH_SECRET: browserAuthEnabled
      ? "phase-zero-playwright-secret-at-least-32-characters"
      : `phase-zero-isolated-disabled-auth-${randomUUID()}`,
    PASEO_BROWSER_AUTH_ENABLED: String(browserAuthEnabled),
    PASEO_MACHINE_AUTH_ENABLED: String(input.machineAuth !== false),
    PASEO_E2E_MACHINE_KEY_FILE: input.machineKeyFile,
    PASEO_E2E_DATABASE_PROFILE: input.databaseProfile ?? "legacy",
    GITHUB_WEBHOOK_SECRET: "phase-zero-webhook-secret",
    STRIPE_WEBHOOK_SECRET: "whsec_phase_zero_fixture_secret",
    PASEO_BROWSER_BILLING_SCENARIO: input.billing === true ? "configured" : "unconfigured",
    PASEO_BROWSER_PROVIDER_SCENARIO:
      input.providerScenario ??
      (input.providerConnections === false
        ? "not-configured"
        : input.githubApprovalRequired === true
          ? "approval"
          : "connected"),
    ...(input.bootstrap === undefined
      ? {}
      : {
          PASEO_BOOTSTRAP_ORGANIZATION: input.bootstrap.organizationName,
          PASEO_BOOTSTRAP_OWNER_EMAIL: input.bootstrap.ownerEmail,
          PASEO_BOOTSTRAP_OWNER_PASSWORD: input.bootstrap.ownerPassword,
        }),
  };
}

async function deliverDiscord(server: ChildProcess, event: BrowserDiscordEvent): Promise<void> {
  await deliverCommand(server, { type: "discord", event });
}

async function deliverCommand(
  server: ChildProcess,
  command: Record<string, unknown>,
): Promise<void> {
  const id = randomUUID();
  const result = new Promise<void>((resolve, reject) => {
    const receive = (message: unknown) => {
      if (typeof message !== "object" || message === null || Reflect.get(message, "id") !== id) {
        return;
      }
      server.off("message", receive);
      if (Reflect.get(message, "ok") === true) resolve();
      else reject(new Error(String(Reflect.get(message, "error"))));
    };
    server.on("message", receive);
  });
  server.send({ id, ...command });
  await result;
}

async function prepareDatabase(
  databaseUrl: string,
  profile: NonNullable<BuiltApplicationOptions["databaseProfile"]>,
): Promise<void> {
  const database = await createDatabase(databaseUrl);
  await database.close();
  if (profile === "fresh") return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    `insert into organization (id, name, slug)
     values ('phase-zero', 'Phase Zero', 'phase-zero')`,
  );
  // A faithful legacy organization: it predates the meters field, so its granted document has
  // the exact shape migration 0025 backfilled. Enforcement reads it on every provider event
  // through the versioned normalization boundary, so the built server exercises that upgrade
  // path end to end — without a row here, metering would throw and manual runs would 500.
  await client.query(
    `insert into organization_entitlements
       (organization_id, granted, overrides, plan_id, plan_version, stamped_at, updated_at)
     values ('phase-zero', '{"seats":{"max":null},"canInviteMembers":true}'::jsonb,
             '{}'::jsonb, null, null, now(), now())`,
  );
  await client.query(
    `insert into "user" (id, name, email, email_verified)
     values ('phase-zero-user', 'Phase Zero', 'phase-zero@example.test', true)`,
  );
  await client.query(
    `insert into member (id, organization_id, user_id, role)
     values ('phase-zero-owner', 'phase-zero', 'phase-zero-user', 'owner')`,
  );
  await client.query(`
    insert into projects (organization_id, name, slug)
    select id, 'Default', 'default' from organization
    on conflict (organization_id, slug) do nothing;
    insert into project_configuration_sources (organization_id, project_id, kind)
    select organization_id, id, 'manual' from projects
    on conflict (project_id) do nothing;
  `);
  await client.end();
}

async function serverReady(server: ChildProcess, origin: string, output: string[]): Promise<void> {
  server.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`built application exited before readiness\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.status === 200) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`built application did not become ready\n${output.join("")}`);
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => server.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to allocate port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}
