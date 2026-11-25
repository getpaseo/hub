import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationActivity } from "./helpers/activity.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/triggers";
const owner = {
  name: "Trigger Owner",
  email: "trigger-owner@example.com",
  password: "trigger-owner-password",
};

test("requires daemon setup before trigger configuration", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const triggers = new OrganizationTriggers(page);

  await triggers.open();
  await expect(page.getByRole("alert")).toContainText("Add a daemon first");
  await expect(page.getByRole("link", { name: "Go to Daemons" })).toHaveAttribute(
    "href",
    /\/o\/[^/]+\/daemons$/u,
  );
  await page.screenshot({ path: `${SHOTS}/00-no-daemon-callout.png`, fullPage: true });
  await triggers.startNew();
  await triggers.expectWaitingForDaemon("Connect a daemon first");
  await triggers.exploreEventQualifiers();
  await expect(
    page.getByText("A trigger runs on a daemon, and none is connected yet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Daemon", exact: true })).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/00-no-daemons.png`, fullPage: true });
  await page.getByRole("link", { name: "Go to Daemons" }).click();
  await expect(page).toHaveURL(/\/daemons$/u);
  await expect(page.getByRole("heading", { name: "Daemons", level: 1 })).toBeVisible();
});

test("creates a trigger visually, preserves advanced YAML through the form, and explains legacy workflows", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const triggers = new OrganizationTriggers(page);

  await test.step("the flat organization trigger list is the starting point", async () => {
    await triggers.open();
    await triggers.expectEmpty();
    await triggers.capture(`${SHOTS}/01-empty-trigger-list.png`);
  });

  await test.step("the common setup stays in one small form", async () => {
    await triggers.startNew();
    await triggers.expectDaemonPreselected(daemon);
    await triggers.expectWaitingForWorkingDirectory();
    await page.screenshot({ path: `${SHOTS}/01b-daemon-required.png`, fullPage: true });
    await triggers.expectEventPickerScrolls(`${SHOTS}/01c-event-picker-scrolls.png`);
    await triggers.expectRefusedOnSubmit("Working directory is required");
    await triggers.configureSlackMention({
      name: "slack-help",
      connection: "company-slack",
      daemon,
      cwd: "/workspace/acme",
      users: "U123, U456",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "high",
      providerOptions: '{"sandbox_mode":"workspace-write"}',
      prompt: "Handle the Slack request.",
    });
    await triggers.exerciseContinuity();
    await triggers.expectMergeTagsAndAutosizing();
    await triggers.expectAgentSearch();
    await triggers.expectComboboxes();
    await triggers.changePrompt("Handle the Slack request.");
    await triggers.expectDisclosureRailsAtPhoneWidth();
    await triggers.expectAdvancedFitsAtPhoneWidth();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await triggers.capture(`${SHOTS}/02-configured-form.png`);
    await triggers.captureInstructions(`${SHOTS}/02b-agent-instructions.png`);
    await triggers.captureExpandedAgent(`${SHOTS}/02c-expanded-model-combobox.png`);
  });

  await test.step("YAML mirrors the form and remains the canonical editable document", async () => {
    await triggers.switchToYaml();
    await page.waitForFunction(() => window.scrollY === 0);
    await triggers.expectYamlContains(
      "provider: opencode",
      "model: gateway/vendor/model-v1",
      "mode: full-access",
      "sandbox_mode: workspace-write",
      "mode: conversation",
    );
    await triggers.capture(`${SHOTS}/03-generated-yaml.png`);
  });

  await test.step("a mode the daemon does not offer is refused at save, not at the first run", async () => {
    // `Invalid mode 'default' for provider 'opencode'. Available modes: build, plan` was a
    // production run failure. The daemon's catalog answers before anything is stored.
    await triggers.replaceYaml(
      advancedTriggerYaml(daemon).replace("mode: full-access", "mode: default"),
    );
    await triggers.expectRefusedOnSubmit(
      "run.agent.mode: Mode 'default' is not available for provider 'opencode'",
    );
    await triggers.capture(`${SHOTS}/03b-refused-mode.png`);
  });

  await test.step("valid YAML saves and lists", async () => {
    await triggers.replaceYaml(advancedTriggerYaml(daemon));
    await triggers.save("slack-help");
    await triggers.expectOperationalList("slack-help");
    await triggers.capture(`${SHOTS}/04-saved-trigger-list.png`);
  });

  await test.step("the form projects advanced YAML without hiding or deleting it", async () => {
    await triggers.openTrigger("slack-help");
    await triggers.expectFormAgent({
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      providerOptions: '{\n  "sandbox_mode": "workspace-write",\n  "approval_policy": "never"\n}',
      prompt: "Handle the Slack request.",
    });
    await triggers.capture(`${SHOTS}/05-round-tripped-form.png`);
    await triggers.changePrompt("Handle the Slack request and report what changed.");
    await triggers.save("slack-help");
  });

  await test.step("a form save retains comments and every YAML-only field", async () => {
    await triggers.openTrigger("slack-help");
    await triggers.switchToYaml();
    await triggers.expectYamlContains(
      "# survives form edits",
      "thinkingOptionId: high",
      "newBranch: trigger-work",
      "channels:",
      "slack.reply:",
      "auto_archive: false",
      "Handle the Slack request and report what changed.",
    );
    await triggers.capture(`${SHOTS}/06-preserved-advanced-yaml.png`);
    await page.getByRole("button", { name: "Triggers" }).click();
  });

  await test.step("legacy multi-step workflows remain visible and are never silently flattened", async () => {
    await hub.seedLegacyTrigger("owner", "legacy-review", legacyWorkflowYaml);
    await triggers.open();
    await triggers.openTrigger("legacy-review");
    await triggers.expectLegacyReadOnly();
    await triggers.capture(`${SHOTS}/07-legacy-workflow-warning.png`);
  });
});

test("a GitHub trigger starts at members, waits for a daemon, and runs in one of its projects", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const olderDaemon = await hub.connectProviderDaemon("owner", "Acme");
  const silentDaemon = await hub.connectProviderDaemon("owner", "Acme");
  hub.holdDaemonProjectList(silentDaemon);
  hub.openDaemonProjects(daemon, [
    {
      projectId: "project-hub",
      projectDisplayName: "hub",
      projectRootPath: "/srv/acme/hub",
      projectKind: "git",
    },
    {
      projectId: "project-storefront",
      projectDisplayName: "web",
      projectCustomName: "Storefront",
      projectRootPath: "/srv/acme/web",
      projectKind: "git",
    },
  ]);
  await hub.connectGitHub("owner");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();

  await test.step("with several daemons none is chosen, and the later steps wait for one", async () => {
    await triggers.expectWaitingForDaemon("Choose a daemon first");
    await triggers.capture(`${SHOTS}/08-waiting-for-daemon.png`);
  });

  await test.step("a GitHub comment is open to repository members until the author widens it", async () => {
    await triggers.chooseEvent("github.issue_comment_created");
    await triggers.chooseConnection("acme-inc-github");
    await triggers.expectAudience("Members");
    await triggers.openAudience();
    await triggers.expectAudienceChoices(
      ["Members", "Contributors", "Everyone", "Specific people"],
      "Members",
    );
    // GitHub reports no sender association on pushes or updates another maintainer can push.
    await triggers.chooseEvent("github.push");
    await triggers.expectAudienceChoices(["Everyone", "Specific people"], "Everyone");
    await triggers.chooseEvent("github.pull_request_synchronized");
    await triggers.expectAudienceChoices(["Everyone", "Specific people"], "Everyone");
    await triggers.chooseEvent("github.issue_comment_created");
    await triggers.expectAudienceChoices(
      ["Members", "Contributors", "Everyone", "Specific people"],
      "Members",
    );
    await triggers.chooseAudience("Contributors");
    await triggers.capture(`${SHOTS}/09-github-audience.png`);
  });

  await test.step("the working directory is one of the chosen daemon's projects", async () => {
    await triggers.chooseDaemon(daemon);
    await triggers.expectProjectChoices([
      { name: "hub", path: "/srv/acme/hub" },
      { name: "Storefront", path: "/srv/acme/web" },
    ]);
    await triggers.capture(`${SHOTS}/10-daemon-projects.png`);
    await triggers.chooseListedProject("store", "/srv/acme/web");
    // Pressing Enter on an absolute path that prefixes a suggested project keeps the typed path.
    await triggers.chooseTypedPathOverMatchingProject("/srv/acme/hu", "/srv/acme/hub");
  });

  await test.step("a daemon whose project list is still loading still takes a typed path with Enter", async () => {
    await triggers.chooseDaemon(silentDaemon);
    await triggers.expectWorkingDirectory("");
    await triggers.chooseWorkingDirectoryWhileLoading("/workspace/pending");
  });

  await test.step("a daemon that lists no projects still takes a typed path", async () => {
    await triggers.chooseDaemon(olderDaemon);
    await triggers.expectWorkingDirectory("");
    await triggers.chooseWorkingDirectory("/workspace/acme");
  });

  await test.step("the audience is saved as repository associations and read back", async () => {
    await triggers.nameTrigger("github-comments");
    await triggers.selectAgent("opencode/gateway/vendor/model-v1");
    await triggers.changePrompt("Answer the comment.");
    await triggers.switchToYaml();
    await triggers.expectYamlMatches({
      on: {
        "github.issue_comment_created": {
          connection: "acme-inc-github",
          filters: { author_associations: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"] },
        },
      },
      run: { target: { daemon: olderDaemon, cwd: "/workspace/acme" } },
    });
    await triggers.expectYamlOmits("from_users");
    await triggers.save("github-comments");
    await triggers.openTrigger("github-comments");
    await triggers.expectAudience("Contributors");
    await triggers.expectWorkingDirectory("/workspace/acme");
  });
});

for (const scenario of [
  { event: "github.issue_label_added", name: "issue-label" },
  { event: "github.pull_request_label_added", name: "pr-label" },
]) {
  test(`saves, reloads, and requires a label for ${scenario.event}`, async ({ hub, page }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    const daemon = await hub.connectProviderDaemon("owner", "Acme");
    await hub.connectGitHub("owner");
    const triggers = new OrganizationTriggers(page);

    await test.step("reject an otherwise complete form with an empty or blank label", async () => {
      await triggers.open();
      await triggers.startNew();
      await triggers.configureLabelAdded({ ...scenario, daemon });
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.changeAddedLabel("   ");
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.capture(`${SHOTS}/${scenario.name}-required.png`);
    });

    await test.step("save through the form and verify persisted YAML after reload", async () => {
      await triggers.changeAddedLabel("ready-for-review");
      await triggers.save(scenario.name);
      await triggers.openTrigger(scenario.name);
      await triggers.expectPersistedLabel(scenario.event, "ready-for-review");
    });

    await test.step("reject clearing a saved label without changing the saved trigger", async () => {
      await triggers.changeAddedLabel("");
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.expectPersistedLabel(scenario.event, "ready-for-review");
    });

    await test.step("edit the label and verify the new value survives another reload", async () => {
      await triggers.changeAddedLabel("ready-to-ship");
      await triggers.save(scenario.name);
      await triggers.openTrigger(scenario.name);
      await triggers.expectPersistedLabel(scenario.event, "ready-to-ship");
      await triggers.capture(`${SHOTS}/${scenario.name}-persisted.png`);
    });
  });
}

function advancedTriggerYaml(daemon: string) {
  return `# survives form edits
name: slack-help
enabled: true
on:
  slack.mention:
    connection: company-slack
    filters:
      from_users: [U123, U456]
      channels: [engineering]
run:
  target:
    daemon: ${daemon}
    cwd: /workspace/acme
    worktree:
      mode: branch-off
      newBranch: trigger-work
  agent:
    provider: opencode
    model: gateway/vendor/model-v1
    mode: full-access
    thinkingOptionId: high
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle the Slack request.
  max_runtime: 90m
  idle_timeout: 15m
  outputs:
    slack.reply:
      max: 5
  auto_archive: false
`;
}

const legacyWorkflowYaml = `name: legacy-review
on: slack.mention
steps:
  - id: classify
    agent: classifier
    prompt: Classify the request.
  - id: implement
    agent: engineer
    prompt: Implement it.
`;

test("round-trips unknown daemon providers and advertised settings through form, YAML, and launch", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const apiKey = await hub.createRunApiKey("owner");
  const daemon = await hub.connectProviderDaemon("owner", "Acme", [
    {
      provider: "plugin-added-agent",
      label: "Plugin agent",
      status: "ready",
      enabled: true,
      models: ["vendor/first", "vendor/second"].map((id) => ({
        provider: "plugin-added-agent",
        id,
        label: id,
        thinkingOptions: [
          { id: "deliberate", label: "Deliberate" },
          { id: "rapid", label: "Rapid" },
        ],
      })),
      defaultModeId: "inspect",
      modes: [
        { id: "evaluate", label: "Evaluate" },
        { id: "inspect", label: "Inspect" },
      ],
    },
    {
      provider: "modeless-agent",
      label: "Modeless agent",
      status: "ready",
      enabled: true,
      models: [{ provider: "modeless-agent", id: "vendor/modeless", label: "vendor/modeless" }],
      modes: [],
    },
    // An agent the daemon has no binary for fails to report, beside agents that work.
    {
      provider: "uninstalled-agent",
      label: "Uninstalled agent",
      status: "error",
      enabled: true,
      error: "spawn uninstalled-agent ENOENT",
    },
  ]);
  let holdSecondModel = false;
  let markSecondModelRequested: (() => void) | undefined;
  let releaseSecondModel: (() => void) | undefined;
  let secondModelGate: Promise<void> | undefined;
  const armSecondModelHold = () => {
    holdSecondModel = true;
    const requested = new Promise<void>((resolve) => {
      markSecondModelRequested = resolve;
    });
    secondModelGate = new Promise<void>((resolve) => {
      releaseSecondModel = resolve;
    });
    return {
      requested,
      release: () => {
        holdSecondModel = false;
        releaseSecondModel?.();
      },
    };
  };
  hub.setDaemonProviderControls(daemon, async (draft) => {
    if (draft.provider !== "plugin-added-agent" || draft.cwd === "/workspace/no-controls") {
      return { controls: [], options: {} };
    }
    if (draft.model === "vendor/second" && holdSecondModel) {
      markSecondModelRequested?.();
      await secondModelGate;
    }
    const isFirst = draft.model === "vendor/first";
    return {
      controls: [
        {
          type: "select",
          key: "service_tier",
          label: "Speed",
          description: "Choose processing speed",
          defaultValue: "default",
          choices: isFirst
            ? [
                { value: "default", label: "Normal" },
                { value: "flex", label: "Flex", description: "Slower processing, reduced usage" },
                { value: "fast", label: "Fast", description: "Faster processing, higher usage" },
              ]
            : [
                { value: "default", label: "Normal" },
                { value: "flex", label: "Flex", description: "Slower processing, reduced usage" },
              ],
        },
        {
          type: "toggle",
          key: "plan_mode",
          label: "Plan",
          description: "Switch into planning-only collaboration mode",
        },
        ...(isFirst
          ? [
              {
                type: "toggle" as const,
                key: "turbo_mode",
                label: "Turbo",
                description: "Enable model-specific turbo mode",
              },
            ]
          : []),
      ],
      options: draft.providerOptions ?? {},
    };
  });
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.expectReportedModelChoices("/workspace/acme", [
    "vendor/first",
    "vendor/second",
    "vendor/modeless",
  ]);
  await triggers.expectNoProviderFailure();
  await triggers.configureManual({
    name: "unknown-run",
    daemon,
    cwd: "/workspace/acme",
    agent: "plugin-added-agent/vendor/first",
    providerOptions: '{"custom_setting":{"limit":7}}',
    prompt: "Perform the task.",
  });
  await triggers.expectMaterializedSelections("inspect", "deliberate");
  await test.step("daemon-exposed provider options configure inside Step 3 Advanced and round-trip", async () => {
    await triggers.selectProviderOption("Speed", "fast");
    await triggers.setProviderOptionToggle("Plan", true);
    await triggers.setProviderOptionToggle("Turbo", true);
    await triggers.closeContinuity();
    await triggers.expectAdvancedSummary("Speed: Fast", "Plan", "Turbo");
    await triggers.setPaseoVisibility({ background: true, autoArchive: false });
  });
  await triggers.switchToYaml();
  await triggers.expectYamlContains(
    "model: vendor/first",
    "mode: inspect",
    "thinkingOptionId: deliberate",
    "service_tier: fast",
    "plan_mode: true",
    "turbo_mode: true",
    "background: true",
    "auto_archive: false",
  );
  await triggers.save("unknown-run");
  await hub.launchSavedTrigger("unknown-run", apiKey);
  await hub.expectProviderLaunch(daemon, {
    provider: "plugin-added-agent",
    model: "vendor/first",
    modeId: "inspect",
    thinkingOptionId: "deliberate",
    providerOptions: {
      custom_setting: { limit: 7 },
      service_tier: "fast",
      plan_mode: true,
      turbo_mode: true,
    },
  });
  await test.step("a background run's agent opens straight in Paseo from Activity", async () => {
    await hub.expectProviderLaunchInBackground(daemon, true);
    const activity = new OrganizationActivity(page);
    await activity.open();
    await activity.openRecord("Runs", "unknown-run");
    await activity.expectRecord("unknown-run");
    await activity.expectOpensInPaseo(await hub.agentDeepLinkOfLatestRun("unknown-run"));
    await activity.expectAgentVisibilityNote("This run requested a background workspace");
    await activity.expectAgentVisibilityNote("If the agent is hidden, turn on Show background");
    await activity.closeRecordWithEscape();
    await triggers.open();
  });
  await test.step("changing cwd to a directory with no controls preserves authored provider options", async () => {
    await triggers.openTrigger("unknown-run");
    await triggers.expectProviderOptionSelect("Speed", "fast");
    await triggers.expectProviderOptionToggle("Plan", true);
    await triggers.expectProviderOptionToggle("Turbo", true);
    await triggers.chooseWorkingDirectory("/workspace/no-controls");
    await triggers.expectNoProviderOptionControl("Speed");
    await triggers.switchToYaml();
    await triggers.expectYamlMatches({
      run: {
        target: { cwd: "/workspace/no-controls" },
        agent: {
          provider: "plugin-added-agent",
          model: "vendor/first",
          options: {
            custom_setting: { limit: 7 },
            service_tier: "fast",
            plan_mode: true,
            turbo_mode: true,
          },
        },
      },
    });
    await triggers.switchToForm();
    await triggers.chooseWorkingDirectory("/workspace/acme");
    await triggers.expectProviderOptionSelect("Speed", "fast");
    await triggers.expectProviderOptionToggle("Turbo", true);
  });
  await test.step("saving while a model-switch lookup is pending reconciles lost controls before saving", async () => {
    const held = armSecondModelHold();
    await triggers.selectAgent("plugin-added-agent/vendor/second");
    await held.requested;
    const saving = triggers.save("unknown-run");
    await expect(
      page.locator("#trigger-editor-form").getByRole("button", { name: "Save changes" }),
    ).toHaveAttribute("aria-busy", "true");
    held.release();
    await saving;
    await triggers.openTrigger("unknown-run");
    await triggers.expectNoProviderOptionControl("Turbo");
    await triggers.expectProviderOptionSelect("Speed", "default");
    await triggers.expectProviderOptionToggle("Plan", true);
    await triggers.switchToYaml();
    await triggers.expectYamlMatches({
      run: {
        agent: {
          provider: "plugin-added-agent",
          model: "vendor/second",
          options: {
            custom_setting: { limit: 7 },
            plan_mode: true,
          },
        },
      },
    });
    await triggers.expectYamlOmits("turbo_mode");
    await triggers.expectYamlOmits("service_tier");
  });
  await triggers.replaceYaml(`name: unknown-run
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${daemon}, cwd: /workspace/acme }
  agent: { provider: plugin-added-agent, model: vendor/second, mode: evaluate, thinkingOptionId: rapid, options: { custom_setting: { limit: 9 } } }
  prompt: Perform the task from YAML
  max_runtime: 1h
  idle_timeout: 5m
`);
  await triggers.save("unknown-run");
  await hub.launchSavedTrigger("unknown-run", apiKey);
  await hub.expectProviderLaunch(daemon, {
    provider: "plugin-added-agent",
    model: "vendor/second",
    modeId: "evaluate",
    thinkingOptionId: "rapid",
    providerOptions: { custom_setting: { limit: 9 } },
  });
  await test.step("the form saves and launches a selected model with no execution modes or provider options", async () => {
    await triggers.openTrigger("unknown-run");
    await triggers.selectAgent("modeless-agent/vendor/modeless");
    await triggers.expectNoExecutionModes();
    await triggers.expectNoProviderOptionControl("Speed");
    await triggers.expectNoProviderOptionControl("Plan");
    await triggers.save("unknown-run");
    await hub.launchSavedTrigger("unknown-run", apiKey);
    await hub.expectProviderLaunch(daemon, {
      provider: "modeless-agent",
      model: "vendor/modeless",
    });
  });
  await triggers.openTrigger("unknown-run");
  await triggers.switchToYaml();
  await triggers.replaceYaml(`name: unknown-run
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${daemon}, cwd: /workspace/acme }
  agent: { provider: modeless-agent }
  prompt: Preserve authored YAML without model or mode
  max_runtime: 1h
  idle_timeout: 5m
`);
  await triggers.save("unknown-run");
  await hub.launchSavedTrigger("unknown-run", apiKey);
  await hub.expectProviderLaunch(daemon, { provider: "modeless-agent" });
  await triggers.openTrigger("unknown-run");
  await expect(page.getByRole("radio", { name: "YAML" })).toBeChecked();
  await triggers.switchToForm();
  await triggers.expectRefusedOnSubmit("Choose a provider and model");
  await triggers.switchToYaml();
  await triggers.save("unknown-run");
});
