import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationActivity } from "./helpers/activity.js";
import { OrganizationHome } from "./helpers/home.js";
import { OrganizationIntegrations } from "./helpers/integrations.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/home";
const owner = {
  name: "Home Owner",
  email: "home-owner@example.com",
  password: "home-owner-password",
};

test.describe.configure({ timeout: 180_000 });

/**
 * The hosted journey the funnel loses people on, step by step: each step is done by the real
 * thing — a provider connection, a daemon over the wire, a saved trigger, a dispatched run — and
 * Home only ever repeats what those records say.
 */
test("walks a hosted organization from sign-in to its first run", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const home = new OrganizationHome(page);
  const triggers = new OrganizationTriggers(page);
  const activity = new OrganizationActivity(page);
  const integrations = new OrganizationIntegrations(page);
  let firstRun: Awaited<ReturnType<typeof hub.runManualInput>> = { status: 0 };

  await test.step("a fresh organization lands on Home with the daemon step open", async () => {
    await home.expectOpen();
    await home.expectProgress("0 of 3");
    await home.expectCurrentStep("Connect a daemon");
    await expect(home.command("Connect a daemon")).toHaveText(
      `paseo hub login ${hub.primaryApplication().origin}`,
    );
    await home.expectStep("Create a trigger", "to do");
    await home.expectStep("Run it", "to do");
    await home.expectIntegrationOffer("Start runs from GitHub, Slack, Discord, or Linear events");
    await home.expectNoAlert();
    await home.expectNoOverview();
    await home.capture(`${SHOTS}/01-fresh.png`);
  });

  await test.step("connecting GitHub from the offer retires it and leaves the daemon step open", async () => {
    await home.followIntegrationOffer("Connect integration");
    await hub.connectGitHub("owner");
    await home.open();
    await home.expectNoIntegrationOffer();
    await home.expectCurrentStep("Connect a daemon");
    await home.expectProgress("0 of 3");
  });

  await test.step("a daemon enrolled without execute permission is connected but cannot run agents", async () => {
    await hub.seedConnectedOnlyDaemon("owner", "laptop");
    await home.reload();
    await home.expectStep("Connect a daemon", "needs attention");
    await home.expectStepText("Connect a daemon", "laptop cannot run agents yet");
    await expect(home.command("Connect a daemon")).toHaveText(
      "paseo hub permissions grant hub.execute",
    );
    await home.capture(`${SHOTS}/02-cannot-run.png`);
  });

  let daemon = "";
  await test.step("a daemon that can run agents completes the first step", async () => {
    daemon = await hub.connectProviderDaemon("owner", "Acme");
    await home.reload();
    await home.expectStep("Connect a daemon", "done");
    await home.expectProgress("1 of 3");
  });

  await test.step("events no trigger listens to raise no alert, and the trigger step leads on", async () => {
    await hub.deliverUnroutedGitHubEvent("home-unrouted-1");
    await hub.deliverUnroutedGitHubEvent("home-unrouted-2");
    await home.reload();
    await home.expectNoAlert();
    await home.expectCurrentStep("Create a trigger");
    await home.followStepAction("Create a trigger", "New trigger");
  });

  await test.step("the editor starts from the connected daemon, and saving completes the second step", async () => {
    await triggers.expectDaemonPreselected(daemon);
    await triggers.configureManual({
      name: "deploy",
      daemon,
      cwd: "/workspace",
      agent: "codex/gpt-5.4",
      mode: "full-access",
      thinking: "high",
      prompt: "${{ paseo.prompt }}",
    });
    await triggers.save("deploy");
    await home.open();
    await home.expectStep("Create a trigger", "done");
    await home.expectCurrentStep("Run it");
    await home.expectStepText("Run it", "POST /api/v1/manual-runs");
    await home.expectProgress("2 of 3");
  });

  await test.step("the first run completes the list, which collapses and stays toggleable", async () => {
    const apiKey = await hub.createRunApiKey("owner");
    firstRun = await hub.runManualInput({
      rawInput: "run it",
      deliveryKey: "home-first-run",
      apiKey,
    });
    expect(firstRun.workflowStatus).toBe("running");
    await home.open();
    await home.expectProgress("3 of 3");
    await home.expectCollapsed();
    await home.expectFigure("Runs", "1", "0 succeeded · 1 running");
    await home.expectTrigger("deploy", { runs: 1, failed: 0 });
    await home.toggle();
    await home.expectExpanded();
    await home.expectStep("Run it", "done");
    await home.expectWholeTitlesAtPhoneWidth(["Connect a daemon", "Create a trigger", "Run it"]);
    await home.reload();
    await home.expectCollapsed();
  });

  await test.step("the run's execution link opens that run in Activity", async () => {
    const runId = firstRun.triggerRunId!;
    await hub.viewRunFromExecutionLink(await hub.executionOfRun(runId));
    await activity.expectUrl({ selected: runId });
    await activity.expectRecord("deploy");
    await activity.closeRecordWithEscape();
    await home.open();
  });

  await test.step("the overview counts every run in the range, past the first 50", async () => {
    for (let run = 1; run <= 52; run += 1) {
      await hub.seedTriggerRun("deploy", { minutesAgo: 10 + run * 20, status: "succeeded" });
    }
    for (const minutesAgo of [2 * 1440, 2 * 1440 + 30]) {
      await hub.seedTriggerRun("deploy", { minutesAgo, status: "failed" });
    }
    await home.reload();
    await home.expectFigure("Runs", "55", "52 succeeded · 1 running");
    await home.expectFigure("Failed", "2", "3.6% failure rate · 0 timed out");
    await home.expectTrigger("deploy", { runs: 55, failed: 2 });
    await home.capture(`${SHOTS}/04-overview.png`);
  });

  await test.step("a range narrows every figure and survives a reload", async () => {
    await home.chooseRange("24h");
    await home.expectFigure("Runs", "53", "52 succeeded · 1 running");
    await home.expectFigure("Failed", "0", "0% failure rate · 0 timed out");
    await home.expectTrigger("deploy", { runs: 53, failed: 0 });
    await home.reload();
    await home.expectFigure("Runs", "53", "52 succeeded · 1 running");
    await home.chooseRange("7d");
    await home.expectFigure("Runs", "55", "52 succeeded · 1 running");
  });

  await test.step("the failed figure opens Activity on the failed runs in the range", async () => {
    await home.openFigure("Failed");
    await activity.expectOpen();
    await activity.expectUrl({ range: null, status: "failed,timed_out,rejected" });
    await activity.expectRows("Runs", 2);
  });

  await test.step("a trigger row opens Activity on that trigger's runs in the range", async () => {
    await home.open();
    await home.chooseRange("24h");
    await home.openTrigger("deploy");
    await activity.expectOpen();
    await activity.expectUrl({ range: "24h", status: null });
    await expect.poll(() => new URL(page.url()).searchParams.get("trigger")).not.toBeNull();
    await activity.expectPageRange("Runs", "1–25 of 53");
  });

  await test.step("a daemon's runs open in Activity filtered to that daemon", async () => {
    await home.open();
    await home.openDaemonRuns(daemon);
    await activity.expectOpen();
    await expect.poll(() => new URL(page.url()).searchParams.get("daemon")).not.toBeNull();
  });

  await test.step("the quiet unmatched events link opens the events that started nothing", async () => {
    await home.open();
    await home.openUnmatchedEvents();
    await activity.expectOpen();
    await activity.expectUrl({ view: "unmatched", range: null });
    await activity.expectRows("Unmatched events", 2);
  });

  await test.step("a Slack workspace short of Hub's permissions raises the one alert", async () => {
    await hub.seedSlackConnection("owner", "acme-eng", "Acme Engineering");
    await home.open();
    await home.expectConnectionFault("Acme Engineering needs reauthorizing on Slack");
    await home.openIntegrationsFromAlert();
  });

  await test.step("a provider's card opens Activity on that provider's runs and events", async () => {
    await integrations.openProviderRuns("GitHub");
    await activity.expectOpen();
    await activity.expectUrl({ view: null, provider: "github" });
    await integrations.open();
    await integrations.openProviderUnmatchedEvents("GitHub");
    await activity.expectOpen();
    await activity.expectUrl({ view: "unmatched", provider: "github" });
    await activity.expectRows("Unmatched events", 2);
  });
});

/** A self-hosted operator who deferred app setup is offered it beside the checklist. */
test("sends a self-hosted operator with no provider app to app setup", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: owner,
    providerScenario: "not-configured",
  });
  try {
    await session.surface.leave("Do this later");
    const home = new OrganizationHome(session.page);
    await home.expectOpen();
    await home.expectCurrentStep("Connect a daemon");
    await home.expectIntegrationOffer("Start runs from GitHub, Slack, Discord, or Linear events");
    await home.capture(`${SHOTS}/05-self-hosted-setup.png`);
    await home.followIntegrationOffer("Set up apps");
    await expect(session.page).toHaveURL(/\/apps$/u);
    await session.surface.expectManagement();
  } finally {
    await session.close();
  }
});
