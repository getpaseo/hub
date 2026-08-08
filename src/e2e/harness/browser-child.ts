import { writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createApplicationRuntime } from "../../application-runtime.js";
import { createAuthServer } from "../../auth/server.js";
import { composeBilling, type BillingConfig, type BillingRuntime } from "../../billing/index.js";
import { composeEntitlements } from "../../auth/entitlements.js";
import { readInstanceAuthPolicy } from "../../auth/instance-policy.js";
import { createDatabase, createPostgresPool } from "../../db/pg.js";
import type { Database } from "../../db/types.js";
import { createFetchServer } from "../../http/node-server.js";
import { loadBuiltStartServer } from "../../server/build.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import {
  BrowserDiscordBot,
  BrowserDiscordConnections,
  BrowserGitHubAuth,
  BrowserGitHubConnections,
  BrowserGitHubConfiguration,
  BrowserGitHubReactions,
  type BrowserDiscordEvent,
  type BrowserProviderScenario,
} from "./browser-providers.js";
import {
  FixtureStripeBillingClient,
  FixtureStripeCatalogSource,
  type FixtureBillingProduct,
} from "./browser-billing.js";

interface DiscordCommand {
  id: string;
  type: "discord";
  event: BrowserDiscordEvent;
}

interface GitHubConfigurationCommand {
  id: string;
  type: "github-configuration";
  repositoryId: number;
  commitSha: string;
  rawYaml?: string;
  partials?: readonly { path: string; content: string }[];
}

interface BillingProductCommand {
  id: string;
  type: "billing-product";
  product: FixtureBillingProduct;
}

interface BillingCancelSubscriptionCommand {
  id: string;
  type: "billing-cancel-subscription";
  organizationId: string;
}

interface BillingInspectCommand {
  id: string;
  type: "billing-inspect";
  organizationId: string;
}

// Fixture-only: signature verification is local HMAC, so any well-formed secret works
// identically to a real one. STRIPE_WEBHOOK_SECRET must match what e2e/helpers/hub.ts signs
// webhook payloads with — see WEBHOOK_SECRET there and GITHUB_WEBHOOK_SECRET for precedent.
const FIXTURE_STRIPE_SECRET_KEY = "sk_test_e2e_fixture_0000000000000000000000";

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const publicBaseUrl = requiredEnvironment("PASEO_HUB_APP_URL");
  const scenario = readScenario();
  const database = await createDatabase(databaseUrl);
  const entitlements = composeEntitlements(database, databaseUrl);
  // Compose (and sync) billing before auth: a billing-configured harness provisions new
  // organizations onto the Free plan, so the resolver must exist before createAuthServer, and the
  // catalog must be synced before auth.initialize runs any bootstrap.
  const {
    billing,
    billingCatalog,
    billingClient: billingFixtureClient,
  } = await composeFixtureBilling(database, entitlements.seatUsage);
  const authSecret = requiredEnvironment("PASEO_HUB_AUTH_SECRET");
  const auth = browserAuthEnabled()
    ? createAuthServer({
        databaseUrl,
        entitlements: entitlements.service,
        baseURL: requiredEnvironment("PASEO_HUB_APP_URL"),
        secret: authSecret,
        policy: readInstanceAuthPolicy(),
        ...billingAuthOptions(billing),
      })
    : null;
  await auth?.initialize?.();
  const machineAuth = machineAuthEnabled();
  const databaseProfile = requiredEnvironment("PASEO_E2E_DATABASE_PROFILE");
  if (auth !== null && machineAuth && databaseProfile === "fresh") {
    await seedMachineAuthTarget(databaseUrl);
  }
  const machineKey =
    auth === null || !machineAuth
      ? undefined
      : await auth.apiKeys?.create("phase-zero", "phase-zero-user", "browser e2e automation", [
          "configuration:install",
          "runs:dispatch",
          "daemons:enroll",
        ]);
  await writeFile(
    requiredEnvironment("PASEO_E2E_MACHINE_KEY_FILE"),
    machineKey?.secret ?? "",
    "utf8",
  );
  const bot = new BrowserDiscordBot();
  const githubConfiguration = new BrowserGitHubConfiguration();
  const githubConfigured = hasBrowserGitHub(scenario);
  const registrations =
    auth === null
      ? []
      : [
          createGitHubRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration: githubConfigured
              ? {
                  appSlug: "paseo",
                  clientId: "client",
                  clientSecret: "secret",
                  webhookSecret: requiredEnvironment("GITHUB_WEBHOOK_SECRET"),
                }
              : null,
            ...(githubConfigured
              ? {
                  appAuth: new BrowserGitHubAuth(),
                  connectionClient: new BrowserGitHubConnections(publicBaseUrl, scenario),
                  configurationProvider: githubConfiguration,
                  reactionClient: new BrowserGitHubReactions(),
                }
              : {}),
          }),
          createDiscordRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration:
              scenario === "not-configured"
                ? null
                : {
                    botToken: "token",
                    clientId: "900",
                    clientSecret: "secret",
                  },
            bot,
            ...(scenario === "not-configured"
              ? {}
              : { connectionClient: new BrowserDiscordConnections(publicBaseUrl, scenario) }),
          }),
          createSlackRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration: null,
          }),
        ];
  const runtime = await createApplicationRuntime({
    database,
    auth,
    entitlements: entitlements.service,
    billing,
    registrations,
    publicBaseUrl,
    completionTokenSecret: requiredEnvironment("PASEO_HUB_AUTH_SECRET"),
    async close() {
      await auth?.close();
      await entitlements.close();
      await database.close();
    },
  });
  const start = await loadBuiltStartServer();
  await start.startApplication(() => runtime);
  const server = createFetchServer((request) => start.default.fetch(request));
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void runtime.hub.handleUpgrade?.(request, socket, head);
  });
  server.listen(Number(requiredEnvironment("PORT")), "127.0.0.1");

  process.on("message", (message: unknown) => {
    void acceptCommand(message, bot, githubConfiguration, billingCatalog, billingFixtureClient);
  });
  const stop = () => void shutdown(server, () => runtime.stop());
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

/** Hosted harness: new organizations start on the Free plan and membership changes re-report
 * seats to Stripe; self-hosted keeps the unlimited default and no reporting. Kept out of `main` so
 * its branch does not push that function past the complexity cap. */
function billingAuthOptions(billing: BillingRuntime | null) {
  if (billing === null) return {};
  return {
    provisioningEntitlements: () => billing.provisioningEntitlement(),
    onMembershipChanged: (organizationId: string) => billing.reportSeatUsage(organizationId),
  };
}

async function seedMachineAuthTarget(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(`
      insert into organization (id, name, slug)
      values ('phase-zero', 'E2E machine organization', 'phase-zero')
      on conflict (id) do nothing;
      insert into organization_entitlements
        (organization_id, granted, overrides, plan_id, plan_version, stamped_at, updated_at)
      values ('phase-zero',
              '{"seats":{"max":null},"canInviteMembers":true,"meters":{"executions.monthly":{"limit":null}}}'::jsonb,
              '{}'::jsonb, null, null, now(), now())
      on conflict (organization_id) do nothing;
      insert into "user" (id, name, email, email_verified)
      values ('phase-zero-user', 'E2E machine user', 'phase-zero@example.test', true)
      on conflict (id) do nothing;
      insert into member (id, organization_id, user_id, role)
      values ('phase-zero-owner', 'phase-zero', 'phase-zero-user', 'owner')
      on conflict (id) do nothing;
    `);
  } finally {
    await pool.end();
  }
}

async function acceptCommand(
  message: unknown,
  bot: BrowserDiscordBot,
  githubConfiguration: BrowserGitHubConfiguration,
  billingCatalog: FixtureStripeCatalogSource | null,
  billingClient: FixtureStripeBillingClient | null,
): Promise<void> {
  if (isGitHubConfigurationCommand(message)) {
    githubConfiguration.setRevision(message);
    process.send?.({ id: message.id, ok: true });
    return;
  }
  if (acceptBillingCommand(message, billingCatalog, billingClient)) return;
  if (!isDiscordCommand(message)) return;
  try {
    await bot.deliver(message.event);
    process.send?.({ id: message.id, ok: true });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Handle the fixture billing IPC commands (product edit, cancel, seat inspection). Returns true
 * when it recognized and replied to a billing command, keeping `acceptCommand` under the
 * complexity cap. */
function acceptBillingCommand(
  message: unknown,
  billingCatalog: FixtureStripeCatalogSource | null,
  billingClient: FixtureStripeBillingClient | null,
): boolean {
  if (isBillingProductCommand(message)) {
    if (billingCatalog === null) {
      process.send?.({ id: message.id, ok: false, error: "billing is not configured" });
      return true;
    }
    billingCatalog.setProduct(message.product);
    process.send?.({ id: message.id, ok: true });
    return true;
  }
  if (isBillingCancelSubscriptionCommand(message)) {
    if (billingClient === null) {
      process.send?.({ id: message.id, ok: false, error: "billing is not configured" });
      return true;
    }
    // Stand in for the customer canceling in the Stripe portal: the subscription now reads
    // canceled, and the caller then delivers the signed customer.subscription.deleted webhook.
    const canceled = billingClient.cancelSubscription(message.organizationId);
    process.send?.({
      id: message.id,
      ok: canceled,
      error: canceled ? undefined : "no subscription",
    });
    return true;
  }
  if (isBillingInspectCommand(message)) {
    if (billingClient === null) {
      process.send?.({ id: message.id, ok: false, error: "billing is not configured" });
      return true;
    }
    // The seat quantity Stripe was last told to bill — what the seat-quantity E2E asserts.
    process.send?.({
      id: message.id,
      ok: true,
      data: { reportedSeatQuantity: billingClient.reportedSeatQuantity(message.organizationId) },
    });
    return true;
  }
  return false;
}

function isGitHubConfigurationCommand(value: unknown): value is GitHubConfigurationCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "github-configuration" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "repositoryId") === "number" &&
    typeof Reflect.get(value, "commitSha") === "string" &&
    (Reflect.get(value, "rawYaml") === undefined ||
      typeof Reflect.get(value, "rawYaml") === "string") &&
    (Reflect.get(value, "partials") === undefined ||
      isPartialFileList(Reflect.get(value, "partials")))
  );
}

function isPartialFileList(value: unknown): value is readonly { path: string; content: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof Reflect.get(file, "path") === "string" &&
        typeof Reflect.get(file, "content") === "string",
    )
  );
}

function isBillingProductCommand(value: unknown): value is BillingProductCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "billing-product" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "product") === "object"
  );
}

function isBillingCancelSubscriptionCommand(
  value: unknown,
): value is BillingCancelSubscriptionCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "billing-cancel-subscription" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "organizationId") === "string"
  );
}

function isBillingInspectCommand(value: unknown): value is BillingInspectCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "billing-inspect" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "organizationId") === "string"
  );
}

function isDiscordCommand(value: unknown): value is DiscordCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "discord" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "event") === "object"
  );
}

async function shutdown(
  server: ReturnType<typeof createFetchServer>,
  stopRuntime: () => Promise<void>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
  await stopRuntime();
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
  process.exit(0);
}

function readScenario(): BrowserProviderScenario {
  const value = process.env["PASEO_BROWSER_PROVIDER_SCENARIO"] ?? "connected";
  if (
    value === "connected" ||
    value === "approval" ||
    value === "conflict" ||
    value === "not-configured" ||
    value === "discord-only"
  ) {
    return value;
  }
  throw new Error(`invalid browser provider scenario: ${value}`);
}

function hasBrowserGitHub(scenario: BrowserProviderScenario): boolean {
  return scenario !== "not-configured" && scenario !== "discord-only";
}

function browserAuthEnabled(): boolean {
  const value = requiredEnvironment("PASEO_BROWSER_AUTH_ENABLED");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid browser auth setting: ${value}`);
}

function machineAuthEnabled(): boolean {
  const value = requiredEnvironment("PASEO_MACHINE_AUTH_ENABLED");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid machine auth setting: ${value}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function billingEnabled(): boolean {
  return process.env["PASEO_BROWSER_BILLING_SCENARIO"] === "configured";
}

function readFixtureBillingConfig(): BillingConfig {
  return {
    stripeSecretKey: FIXTURE_STRIPE_SECRET_KEY,
    stripeWebhookSecret: requiredEnvironment("STRIPE_WEBHOOK_SECRET"),
  };
}

/**
 * Composes the fixture billing runtime and syncs it on boot, mirroring what `src/index.ts`
 * does in production with the real Stripe SDK. `billingCatalog` is returned separately so the
 * IPC handler can mutate it later — see the `billing-product` command below.
 */
async function composeFixtureBilling(
  database: Database,
  seatUsage: (organizationId: string) => Promise<number>,
): Promise<{
  billing: BillingRuntime | null;
  billingCatalog: FixtureStripeCatalogSource | null;
  billingClient: FixtureStripeBillingClient | null;
}> {
  if (!billingEnabled()) return { billing: null, billingCatalog: null, billingClient: null };
  const billingCatalog = new FixtureStripeCatalogSource();
  const billingClient = new FixtureStripeBillingClient();
  const billing = composeBilling({
    config: readFixtureBillingConfig(),
    database,
    catalogSource: billingCatalog,
    billingClient,
    seatUsage,
  });
  await billing.syncCatalog();
  return { billing, billingCatalog, billingClient };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
