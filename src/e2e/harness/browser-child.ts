import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createApplicationRuntime } from "../../application-runtime.js";
import { createAuthServer, type AuthServer } from "../../auth/server.js";
import { composeBilling, type BillingConfig, type BillingRuntime } from "../../billing/index.js";
import { composeEntitlements } from "../../auth/entitlements.js";
import { readInstanceAuthPolicy } from "../../auth/instance-policy.js";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../../db/runtime/index.js";
import { createDatabase } from "../../db/pg.js";
import type { Database } from "../../db/types.js";
import { createFetchServer } from "../../http/node-server.js";
import { loadBuiltStartServer } from "../../server/build.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import type { ProviderRegistration } from "../../providers/registration.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import {
  BrowserDiscordBot,
  BrowserDiscordConnections,
  BrowserGitHubAuth,
  BrowserGitHubConnections,
  BrowserGitHubConfiguration,
  BrowserGitHubReactions,
  BrowserSlackBot,
  type BrowserDiscordEvent,
  type BrowserProviderScenario,
} from "./browser-providers.js";
import {
  FixtureStripeBillingClient,
  FixtureStripeCatalogSource,
  type FixtureBillingProduct,
} from "./browser-billing.js";
import { BrowserAccountSetupFaults } from "./browser-account-setup.js";
import {
  BrowserProviderApplicationVerifier,
  browserRegistrationFactory,
} from "./browser-provider-applications.js";
import {
  activateProviderApplicationsAtStartup,
  DynamicProviderRuntime,
  createProviderApplicationInventory,
  createProviderApplicationStore,
  createProviderApplications,
  readProviderApplicationEnvironment,
  resolveCallbackOrigin,
  type ProviderApplications,
  type ProviderApplicationIdentity,
} from "../../provider-applications/index.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../../http/request-origin.js";

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
  files?: readonly { path: string; content: string }[];
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

interface AccountSetupFailureCommand {
  id: string;
  type: "fail-next-account-setup";
}

interface ProjectReadFailureCommand {
  id: string;
  type: "fail-next-project-read";
}

// Fixture-only: signature verification is local HMAC, so any well-formed secret works
// identically to a real one. STRIPE_WEBHOOK_SECRET must match what e2e/helpers/hub.ts signs
// webhook payloads with — see WEBHOOK_SECRET there and GITHUB_WEBHOOK_SECRET for precedent.
const FIXTURE_STRIPE_SECRET_KEY = "sk_test_e2e_fixture_0000000000000000000000";

async function main(): Promise<void> {
  const publicBaseUrl =
    process.env["PASEO_HUB_APP_URL"] ?? `http://127.0.0.1:${requiredEnvironment("PORT")}`;
  const scenario = readScenario();
  const { database, runtime: databaseRuntime, locks } = await createBrowserDatabase();
  const entitlements = composeEntitlements(database, databaseRuntime);
  // Compose (and sync) billing before auth: a billing-configured harness provisions new
  // organizations onto the Free plan, so the resolver must exist before createAuthServer, and the
  // catalog must be synced before auth.initialize runs any bootstrap.
  const {
    billing,
    billingCatalog,
    billingClient: billingFixtureClient,
  } = await composeFixtureBilling(database, entitlements.seatUsage);
  const authSecret = requiredEnvironment("PASEO_HUB_AUTH_SECRET");
  const accountSetupFaults = new BrowserAccountSetupFaults();
  const auth = browserAuthEnabled()
    ? accountSetupFaults.install(
        createAuthServer({
          database: databaseRuntime,
          locks,
          entitlements: entitlements.service,
          baseURL: publicBaseUrl,
          secret: authSecret,
          policy: readInstanceAuthPolicy(process.env),
          ...billingAuthOptions(billing),
        }),
      )
    : null;
  await auth?.initialize?.();
  const machineAuth = machineAuthEnabled();
  const databaseProfile = requiredEnvironment("PASEO_E2E_DATABASE_PROFILE");
  await seedMachineAuthTargetIfRequired(auth, machineAuth, databaseProfile, databaseRuntime);
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
  const slackBot = new BrowserSlackBot();
  const githubConfiguration = new BrowserGitHubConfiguration();
  const githubConfigured = hasBrowserGitHub(scenario);
  const slackConfigured = scenario === "slack-only";
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
                  appId: "42",
                  appSlug: "paseo",
                  clientId: "client",
                  clientSecret: "secret",
                  webhookSecret: requiredEnvironment("GITHUB_WEBHOOK_SECRET"),
                  privateKey: "fixture-private-key",
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
              scenario === "not-configured" || scenario === "slack-only"
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
            configuration: slackConfigured
              ? {
                  appId: "browser-slack-app",
                  clientId: "browser-slack-client",
                  clientSecret: "browser-slack-client-secret",
                  signingSecret: requiredEnvironment("SLACK_SIGNING_SECRET"),
                }
              : null,
            ...(slackConfigured ? { botClient: slackBot } : {}),
          }),
        ];
  const providers = await providerRuntimeOptions(auth, registrations, {
    database,
    databaseRuntime,
    locks,
    publicBaseUrl,
    scenario,
    bot,
    slackBot,
    githubConfiguration,
  });
  const runtime = await createApplicationRuntime({
    database,
    auth,
    entitlements: entitlements.service,
    billing,
    ...providers,
    publicBaseUrl,
    completionTokenSecret: requiredEnvironment("PASEO_HUB_AUTH_SECRET"),
    async close() {
      await auth?.close();
      await entitlements.close();
      await database.close();
    },
  });
  let failNextProjectRead = false;
  const projectDashboard = runtime.projectDashboard;
  if (projectDashboard !== null) {
    const readProjectSnapshot = projectDashboard.projectSnapshot.bind(projectDashboard);
    projectDashboard.projectSnapshot = async (...args) => {
      if (failNextProjectRead) {
        failNextProjectRead = false;
        throw new Error("project read failed with formatless-project-secret-8ac72f");
      }
      return readProjectSnapshot(...args);
    };
  }
  const start = await loadBuiltStartServer();
  await start.startApplication(() => runtime);
  const server = createFetchServer(
    (request) => browserProviderPage(request, publicBaseUrl) ?? start.default.fetch(request),
    await testServerOptions(),
  );
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void runtime.hub.handleUpgrade?.(request, socket, head);
  });
  server.listen(Number(requiredEnvironment("PORT")), "127.0.0.1");

  process.on("message", (message: unknown) => {
    void acceptCommand(message, {
      bot,
      githubConfiguration,
      billingCatalog,
      billingClient: billingFixtureClient,
      accountSetupFaults,
      failNextProjectRead: () => {
        failNextProjectRead = true;
      },
    });
  });
  const stop = () => void shutdown(server, () => runtime.stop());
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function createBrowserDatabase() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    return createPostgresTestRuntime(databaseUrl);
  }
  const bundle = await embeddedDatabaseRuntime(requiredEnvironment("PASEO_HUB_DATA_DIR"));
  try {
    await bundle.runtime.migrate();
    process.stdout.write("database runtime ready: embedded\n");
    return { ...bundle, database: createDatabase(bundle.runtime, bundle.locks) };
  } catch (error) {
    await bundle.runtime.close().catch(() => undefined);
    throw error;
  }
}

async function testServerOptions(): Promise<{
  tls?: { key: string; cert: string };
  trustedClientIpHeader?: string;
}> {
  const keyPath = process.env["PASEO_E2E_TLS_KEY"];
  const certPath = process.env["PASEO_E2E_TLS_CERT"];
  const trustedClientIpHeader = process.env["PASEO_HUB_TRUSTED_CLIENT_IP_HEADER"];
  const trusted = trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader };
  if (keyPath === undefined && certPath === undefined) return trusted;
  if (keyPath === undefined || certPath === undefined) throw new Error("incomplete test TLS");
  return {
    ...trusted,
    tls: { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") },
  };
}

function browserProviderPage(request: Request, publicBaseUrl: string): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== "/e2e/providers/slack/authorize") return undefined;
  const state = url.searchParams.get("state");
  if (state === null) return new Response("Missing state", { status: 400 });
  const callback = new URL(
    "/api/integrations/slack/callback",
    request.headers.get(TRUSTED_REQUEST_ORIGIN_HEADER) ?? publicBaseUrl,
  );
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", "accepted");
  return new Response(
    `<!doctype html><html><body><main><h1>Install Paseo in Acme</h1><p>Slack is asking you to accept this app.</p><a href="${callback.toString()}">Accept installation</a></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
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

async function seedMachineAuthTarget(database: DatabaseRuntime): Promise<void> {
  await database.query(`
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
}

async function seedMachineAuthTargetIfRequired(
  auth: AuthServer | null,
  machineAuth: boolean,
  databaseProfile: string,
  database: DatabaseRuntime,
): Promise<void> {
  if (auth !== null && machineAuth && databaseProfile === "fresh") {
    await seedMachineAuthTarget(database);
  }
}

interface CommandFixtures {
  bot: BrowserDiscordBot;
  githubConfiguration: BrowserGitHubConfiguration;
  billingCatalog: FixtureStripeCatalogSource | null;
  billingClient: FixtureStripeBillingClient | null;
  accountSetupFaults: BrowserAccountSetupFaults;
  failNextProjectRead(): void;
}

async function acceptCommand(message: unknown, fixtures: CommandFixtures): Promise<void> {
  const { bot, githubConfiguration, billingCatalog, billingClient } = fixtures;
  if (isGitHubConfigurationCommand(message)) {
    githubConfiguration.setRevision(message);
    process.send?.({ id: message.id, ok: true });
    return;
  }
  if (isAccountSetupFailureCommand(message)) {
    fixtures.accountSetupFaults.failNext();
    process.send?.({ id: message.id, ok: true });
    return;
  }
  if (isProjectReadFailureCommand(message)) {
    fixtures.failNextProjectRead();
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
    (Reflect.get(value, "files") === undefined || isBundleFileList(Reflect.get(value, "files")))
  );
}

function isBundleFileList(value: unknown): value is readonly { path: string; content: string }[] {
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

function isAccountSetupFailureCommand(value: unknown): value is AccountSetupFailureCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "fail-next-account-setup" &&
    typeof Reflect.get(value, "id") === "string"
  );
}

function isProjectReadFailureCommand(value: unknown): value is ProjectReadFailureCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "fail-next-project-read" &&
    typeof Reflect.get(value, "id") === "string"
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
    value === "discord-verification-network" ||
    value === "slack-permission-missing" ||
    value === "not-configured" ||
    value === "discord-only" ||
    value === "slack-only"
  ) {
    return value;
  }
  throw new Error(`invalid browser provider scenario: ${value}`);
}

function hasBrowserGitHub(scenario: BrowserProviderScenario): boolean {
  return scenario !== "not-configured" && scenario !== "discord-only" && scenario !== "slack-only";
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

/**
 * The registration set the application runs on. Dynamic mode hands over to the operator-managed
 * runtime entirely; every other scenario keeps the statically configured providers it has always
 * had, so existing journeys are untouched.
 */
async function providerRuntimeOptions(
  auth: Parameters<typeof createApplicationRuntime>[0]["auth"],
  registrations: readonly ProviderRegistration[],
  fixtures: Omit<Parameters<typeof composeProviderApplications>[0], "auth">,
): Promise<
  Pick<Parameters<typeof createApplicationRuntime>[0], "registrations"> & {
    providerApplications?: ProviderApplications;
  }
> {
  const apps = auth === null ? null : await composeProviderApplications({ ...fixtures, auth });
  if (apps !== null) {
    return { registrations: apps.registrations, providerApplications: apps.capability };
  }
  if (auth !== null) {
    await activateStaticProviderApplications(fixtures);
  }
  return { registrations };
}

async function activateStaticProviderApplications(
  input: Omit<Parameters<typeof composeProviderApplications>[0], "auth">,
): Promise<void> {
  const identities: ProviderApplicationIdentity[] = [];
  if (hasBrowserGitHub(input.scenario)) {
    identities.push({ provider: "github", id: "42", name: "paseo", ownerLogin: "acme-inc" });
  }
  if (input.scenario !== "not-configured" && input.scenario !== "slack-only") {
    identities.push({ provider: "discord", id: "900", name: "Paseo" });
  }
  if (input.scenario === "slack-only") {
    identities.push({ provider: "slack", id: "browser-slack-app", name: "Paseo" });
  }
  const store = createProviderApplicationStore(input.databaseRuntime, input.locks, input.database);
  for (const identity of identities) {
    await store.activate({ provider: identity.provider, identity, configurationVersion: 0 });
  }
}

/**
 * The operator-managed provider applications, backed by the fixture provider clients. Dynamic mode
 * replaces the statically configured registrations entirely, so the app setup journey starts on an
 * instance with nothing configured and activates providers exactly the way production does.
 */
async function composeProviderApplications(input: {
  database: Database;
  databaseRuntime: DatabaseRuntime;
  locks: Parameters<typeof createProviderApplicationStore>[1];
  auth: NonNullable<Parameters<typeof createApplicationRuntime>[0]["auth"]>;
  publicBaseUrl: string;
  scenario: BrowserProviderScenario;
  bot: BrowserDiscordBot;
  slackBot: BrowserSlackBot;
  githubConfiguration: BrowserGitHubConfiguration;
}): Promise<{
  capability: ProviderApplications;
  registrations: readonly ProviderRegistration[];
} | null> {
  if (process.env["PASEO_BROWSER_PROVIDER_APPS"] !== "dynamic") return null;
  const environment = await readProviderApplicationEnvironment(process.env);
  const store = createProviderApplicationStore(input.databaseRuntime, input.locks, input.database);
  const verifier = new BrowserProviderApplicationVerifier(input.scenario);
  const inventory = createProviderApplicationInventory(input.databaseRuntime);
  const providerRuntime = new DynamicProviderRuntime({
    database: input.database,
    auth: input.auth,
    applicationBaseUrl: input.publicBaseUrl,
    registrationFactory: browserRegistrationFactory({
      database: input.database,
      auth: input.auth,
      applicationBaseUrl: input.publicBaseUrl,
      scenario: input.scenario,
      bot: input.bot,
      slackBot: input.slackBot,
      githubConfiguration: input.githubConfiguration,
    }),
  });
  const failures = await activateProviderApplicationsAtStartup({
    store,
    environment,
    runtime: providerRuntime,
    verifier,
    inventory,
    callbackOrigin: input.publicBaseUrl,
  });
  if (failures[0] !== undefined) {
    throw failures[0].error;
  }
  const capability = createProviderApplications({
    auth: input.auth,
    store,
    environment,
    runtime: providerRuntime,
    verifier,
    inventory,
    callbackOrigin: (request) => resolveCallbackOrigin(request, process.env["PASEO_HUB_APP_URL"]),
    beginCandidateConnection: async (request, organizationId, returnRoute, begin) => {
      const organizationSlug = await inventory.organizationSlug(organizationId);
      if (organizationSlug === undefined) throw new Error("organization unavailable");
      const url = new URL(request.url);
      url.searchParams.set("organizationSlug", organizationSlug);
      url.searchParams.set("returnRoute", returnRoute);
      return begin(new Request(url, { method: "POST", headers: request.headers }));
    },
  });
  return { capability, registrations: providerRuntime.registrations() };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
