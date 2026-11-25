import { defaultAudience, EDITOR_EVENTS, eventDefinition } from "./events.js";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { TriggerDocumentSchema } from "./schema.js";
import {
  changeTriggerEvent,
  createTriggerYaml,
  describeTriggerEvent,
  mergeTriggerForm,
  patchTriggerYaml,
  projectTriggerForm,
  splitAgentId,
  triggerFormErrors,
} from "./editor.js";

import {
  GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES,
  GITHUB_TRIGGER_SOURCE_NAMES,
} from "../github/classification.js";

const ADVANCED = `# keep this heading
name: answer
enabled: true
on:
  slack.mention:
    connection: company
    filters:
      from_users: ["*"]
      channels: [engineering]
inputs:
  urgency:
    type: string
    default: normal
max_runtime: 4h
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: hub-work
  agent:
    provider: codex
    model: gpt-5.4
    mode: full-access
    thinkingOptionId: xhigh
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle it.
  max_runtime: 3h
  idle_timeout: 15m
  startup_timeout: 3m
  env:
    TEAM: core
  github:
    connection: company-github
    repositories: [paseo/hub]
  output:
    schema:
      type: object
  outputs:
    slack.reply:
      max: 3
  auto_archive: false
`;

describe("trigger form YAML bridge", () => {
  test("returns the original YAML byte-for-byte when the form did not change", () => {
    const projection = projectTriggerForm(ADVANCED);
    expect(projection.status).toBe("editable");
    if (projection.status === "editable") {
      expect(patchTriggerYaml(ADVANCED, projection.value)).toBe(ADVANCED);
    }
  });

  const CHAT_GRANT = ADVANCED.replace(
    "run:",
    `run:
  tools:
    slack:
      channels: [CDIGEST] # keep the channel comment
      connection: engineering-slack
      actions: [post]`,
  );

  test.each([
    [
      "into the grant",
      CHAT_GRANT.replace("connection: company", "connection: &workspace company").replace(
        "connection: engineering-slack",
        "connection: *workspace",
      ),
    ],
    [
      "out of the grant",
      CHAT_GRANT.replace(
        "connection: engineering-slack",
        "connection: &workspace engineering-slack",
      ).replace("TEAM: core", "TEAM: core\n    DIGEST_CONNECTION: *workspace"),
    ],
  ])("keeps a trigger in YAML when anchors link %s", (_, yaml) => {
    expect(TriggerDocumentSchema.safeParse(parseDocument(yaml).toJS()).success).toBe(true);
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "yaml_only") throw new Error("Expected the form to be unavailable.");
    expect(projection.reason).toMatch(/integration tool grants.*anchors or aliases/i);
  });

  test("preserves channel comments when changing unrelated grant fields", () => {
    const projection = projectTriggerForm(CHAT_GRANT);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const saved = patchTriggerYaml(CHAT_GRANT, {
      ...projection.value,
      tools: {
        slack: { ...projection.value.tools.slack!, actions: ["read", "post"] },
      },
    });
    expect(saved).toMatch(/channels: \[\s*CDIGEST\s*\] # keep the channel comment/);
    const amended = projectTriggerForm(saved);
    if (amended.status !== "editable") throw new Error(amended.reason);
    expect(amended.value.tools.slack?.actions).toEqual(["read", "post"]);
  });

  test("patches owned nodes while preserving comments and advanced configuration", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      cwd: "/new-workspace",
      agent: "pi/gateway/vendor/model-v1",
      mode: "safe",
    });
    expect(yaml).toContain("# keep this heading");
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(value.run.target).toEqual({
      daemon: "office",
      cwd: "/new-workspace",
      worktree: { mode: "branch-off", newBranch: "hub-work" },
    });
    expect(value.run.agent).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
      mode: "safe",
      thinkingOptionId: "xhigh",
      options: { sandbox_mode: "workspace-write", approval_policy: "never" },
    });
    expect(value.inputs).toBeDefined();
    expect(value.max_runtime).toBe("4h");
    expect(value.run.startup_timeout).toBe("3m");
    expect(value.run.env).toEqual({ TEAM: "core" });
    expect(value.run.github).toEqual({
      connection: "company-github",
      repositories: ["paseo/hub"],
    });
    expect(value.run.output).toBeDefined();
    expect(value.run.outputs).toEqual({ "slack.reply": { max: 3 } });
    expect(value.run.auto_archive).toBe(false);
    expect(value.on["slack.mention"]?.filters?.channels).toEqual(["engineering"]);
  });

  test("edits provider options without touching thinking selection", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      providerOptions: '{"sandbox_mode":"read-only"}',
    });
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    if ("choices" in value.run.agent) throw new Error("expected an inline agent");
    expect(value.run.agent.options).toEqual({ sandbox_mode: "read-only" });
    expect(value.run.agent.thinkingOptionId).toBe("xhigh");
  });

  test("keeps advanced YAML added before a new trigger's first save", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const merged = mergeTriggerForm(ADVANCED, { ...projection.value, prompt: "Changed." });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("# keep this heading");
    const value = TriggerDocumentSchema.parse(parseDocument(merged.yaml).toJS());
    expect(value.run.prompt).toBe("Changed.");
    expect(value.run.target.worktree).toBeDefined();
    expect(value.run.outputs).toBeDefined();
  });

  test("keeps unsupported shapes in YAML-only mode", () => {
    expect(projectTriggerForm(ADVANCED.replace("slack.mention:", "custom.event:"))).toEqual({
      status: "yaml_only",
      reason: "The form does not support the custom.event event",
    });
    expect(
      projectTriggerForm(
        ADVANCED.replace(
          "provider: codex\n    model: gpt-5.4",
          "select: primary\n    choices:\n      primary:\n        provider: codex",
        ),
      ).status,
    ).toBe("yaml_only");
  });

  test("creates a deliberately minimal new trigger", () => {
    const yaml = createTriggerYaml({
      name: "answer",
      enabled: true,
      event: "manual.run",
      connection: "",
      audience: "everyone",
      allowedUsers: "",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "codex/gpt-5.4",
      mode: "full-access",
      thinkingOptionId: "",
      providerOptions: "",
      continuationMode: "conversation",
      continuationKey: "",
      maxRuntime: "2h",
      idleTimeout: "10m",
      background: false,
      autoArchive: true,
      githubConnection: "",
      githubRepositories: "",
      githubPermissions: "",
      githubDuration: "1h",
      tools: {},
      prompt: "Handle it.",
    });
    expect(parseDocument(yaml).toJS()).toEqual({
      name: "answer",
      enabled: true,
      on: { "manual.run": {} },
      run: {
        target: { daemon: "office", cwd: "/workspace" },
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        continuation: { mode: "conversation" },
        max_runtime: "2h",
        idle_timeout: "10m",
        prompt: "Handle it.",
      },
    });
  });

  test("submits an unchanged minimal manual trigger", () => {
    const initial = createTriggerYaml({
      name: "deploy",
      enabled: true,
      event: "manual.run",
      connection: "",
      audience: "everyone",
      allowedUsers: "",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "opencode",
      mode: "full-access",
      thinkingOptionId: "",
      providerOptions: "",
      continuationMode: "conversation",
      continuationKey: "",
      maxRuntime: "2h",
      idleTimeout: "10m",
      background: false,
      autoArchive: true,
      githubConnection: "",
      githubRepositories: "",
      githubPermissions: "",
      githubDuration: "1h",
      tools: {},
      prompt: "${{ paseo.prompt }}",
    });
    const projection = projectTriggerForm(initial);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm(initial, { ...projection.value, name: "release" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("name: release");
  });

  test("round-trips background and auto-archive through the form", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value).toMatchObject({ background: false, autoArchive: false });

    const patched = patchTriggerYaml(ADVANCED, { ...projection.value, background: true });
    expect(parseDocument(patched).toJS()).toMatchObject({
      run: { background: true, auto_archive: false },
    });
    expect(patched).toContain("# keep this heading");
    const reprojected = projectTriggerForm(patched);
    if (reprojected.status !== "editable") throw new Error(reprojected.reason);
    expect(reprojected.value).toMatchObject({ background: true, autoArchive: false });

    const archived = patchTriggerYaml(patched, { ...reprojected.value, autoArchive: true });
    expect(parseDocument(archived).toJS()).toMatchObject({
      run: { background: true, auto_archive: true },
    });
  });

  test("leaves the defaults out of a new trigger and writes only what differs", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const defaults = createTriggerYaml({
      ...projection.value,
      background: false,
      autoArchive: true,
    });
    expect(parseDocument(defaults).toJS()).not.toHaveProperty("run.background");
    expect(parseDocument(defaults).toJS()).not.toHaveProperty("run.auto_archive");

    const changed = createTriggerYaml({
      ...projection.value,
      background: true,
      autoArchive: false,
    });
    expect(parseDocument(changed).toJS()).toMatchObject({
      run: { background: true, auto_archive: false },
    });
  });

  test("does not write the defaults when another field changes", () => {
    const projection = projectTriggerForm(ADVANCED.replace("  auto_archive: false\n", ""));
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value).toMatchObject({ background: false, autoArchive: true });
    const yaml = patchTriggerYaml(ADVANCED.replace("  auto_archive: false\n", ""), {
      ...projection.value,
      name: "renamed",
    });
    expect(yaml).not.toContain("background");
    expect(yaml).not.toContain("auto_archive");
  });

  test("splits only the first slash in a full agent ID", () => {
    expect(splitAgentId("pi/gateway/vendor/model-v1")).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
    });
  });

  test("reports the missing field instead of throwing when the form is half filled", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    expect(mergeTriggerForm("", { ...projection.value, daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Daemon is required",
    });
    expect(mergeTriggerForm("", { ...projection.value, agent: "" })).toEqual({
      status: "incomplete",
      reason: "Agent is required",
    });
    expect(mergeTriggerForm("", { ...projection.value, providerOptions: "{" })).toEqual({
      status: "incomplete",
      reason: "Provider options must be valid JSON",
    });
  });

  test("serialises a complete new trigger that has no document yet", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm("", projection.value);
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("daemon: office");
  });
});

describe("what the form still needs", () => {
  function editable() {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    return projection.value;
  }

  test("finds nothing wrong with a document that already parses", () => {
    expect(triggerFormErrors(editable())).toEqual({});
  });

  test("names the field, not just the problem", () => {
    expect(triggerFormErrors({ ...editable(), daemon: "" })).toEqual({
      daemon: "Daemon is required",
    });
    expect(triggerFormErrors({ ...editable(), cwd: "workspace" })).toEqual({
      cwd: "Working directory must be an absolute path",
    });
    expect(triggerFormErrors({ ...editable(), agent: "" })).toEqual({
      agent: "Agent is required",
    });
    expect(triggerFormErrors({ ...editable(), providerOptions: "{" })).toEqual({
      providerOptions: "Provider options must be valid JSON",
    });
    expect(triggerFormErrors({ ...editable(), prompt: "  " })).toEqual({
      prompt: "Instructions are required",
    });
  });

  test("holds the name to the document's own alphabet", () => {
    expect(triggerFormErrors({ ...editable(), name: "" }).name).toBe("Trigger name is required");
    expect(triggerFormErrors({ ...editable(), name: "Slack Triage" }).name).toBe(
      "Use lowercase letters, digits, and hyphens, starting with a letter",
    );
    expect(triggerFormErrors({ ...editable(), name: "slack-triage" }).name).toBeUndefined();
  });

  test("asks for a connection only when an event arrives on one", () => {
    expect(triggerFormErrors({ ...editable(), connection: "" }).connection).toBe(
      "Connection is required",
    );
    expect(
      triggerFormErrors({ ...editable(), event: "manual.run", connection: "", allowedUsers: "" })
        .connection,
    ).toBeUndefined();
  });

  test("reads GitHub permissions only when a GitHub connection is chosen", () => {
    expect(
      triggerFormErrors({ ...editable(), githubConnection: "", githubPermissions: "{" })
        .githubPermissions,
    ).toBeUndefined();
    expect(
      triggerFormErrors({ ...editable(), githubConnection: "company", githubPermissions: "{" })
        .githubPermissions,
    ).toBe("GitHub permissions must be valid JSON");
    expect(
      triggerFormErrors({
        ...editable(),
        githubConnection: "company",
        githubPermissions: '{"a":1}',
      }).githubPermissions,
    ).toBe('GitHub permissions map a scope to "read", "write", or "admin"');
  });

  test("refuses an added integration grant whose connection is still blank instead of dropping it", () => {
    const withBlankSlack = {
      ...editable(),
      tools: { slack: { connection: "", actions: ["post" as const], channels: "C12345" } },
    };
    expect(triggerFormErrors(withBlankSlack)["tools.slack.connection"]).toBe(
      "Choose a Slack connection",
    );
    expect(mergeTriggerForm("", withBlankSlack)).toEqual({
      status: "incomplete",
      reason: "Choose a Slack connection",
    });

    const withBlankGitHub = {
      ...editable(),
      githubEnabled: true,
      githubConnection: "",
      githubRepositories: "acme/hub",
    };
    expect(triggerFormErrors(withBlankGitHub).githubConnection).toBe("Choose a GitHub connection");
    expect(mergeTriggerForm("", withBlankGitHub)).toEqual({
      status: "incomplete",
      reason: "Choose a GitHub connection",
    });
  });

  test("reports the topmost problem when the document cannot be written at all", () => {
    expect(mergeTriggerForm("", { ...editable(), name: "", daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Trigger name is required",
    });
  });
});

test.each([
  "github.pull_request_created",
  "github.pull_request_ready_for_review",
  "github.issue_created",
  "linear.issue_assigned",
  "linear.comment_created",
  "linear.issue_entered_scope",
])("edits supported event %s", (event) => {
  expect(projectTriggerForm(ADVANCED.replace("slack.mention", event)).status).toBe("editable");
});

test("round trips the added label separately from existing item labels", () => {
  const yaml = ADVANCED.replace("slack.mention", "github.pull_request_label_added").replace(
    "channels: [engineering]",
    "label: ready\n      labels: [bug]",
  );
  const projection = projectTriggerForm(yaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error("not editable");
  expect(projection.value.qualifiers.label).toBe("ready");
  const patched = patchTriggerYaml(yaml, { ...projection.value, qualifiers: { label: "review" } });
  expect(
    TriggerDocumentSchema.parse(parseDocument(patched).toJS()).on["github.pull_request_label_added"]
      ?.filters,
  ).toEqual({
    from_users: ["*"],
    label: "review",
    labels: ["bug"],
  });
  expect(() => patchTriggerYaml(patched, { ...projection.value, qualifiers: {} })).toThrow(
    "Added label is required",
  );
});

test("offers every supported GitHub semantic event and webhook source", () => {
  for (const event of [...GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES, ...GITHUB_TRIGGER_SOURCE_NAMES]) {
    expect(EDITOR_EVENTS).toContain(event);
  }
});

test("creates a qualified event and removes the qualifier when changing event kind", () => {
  const initial = projectTriggerForm(ADVANCED);
  if (initial.status !== "editable") throw new Error(initial.reason);
  const yaml = createTriggerYaml({
    ...initial.value,
    event: "github.issue_label_added",
    qualifiers: { label: "ready" },
  });
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.qualifiers.label).toBe("ready");
  const changed = patchTriggerYaml(yaml, {
    ...projection.value,
    event: "github.pull_request_created",
  });
  expect(
    TriggerDocumentSchema.parse(parseDocument(changed).toJS()).on["github.pull_request_created"]
      ?.filters,
  ).toEqual({ from_users: ["*"] });
});

test("event changes carry compatible qualifiers and reset provider-bound values", () => {
  const projection = projectTriggerForm(
    ADVANCED.replace("slack.mention", "github.issue_label_added").replace(
      "channels: [engineering]",
      "label: ready",
    ),
  );
  if (projection.status !== "editable") throw new Error(projection.reason);
  const initial = { ...projection.value, qualifiers: { label: "ready" } };
  const pr = changeTriggerEvent(initial, "github.pull_request_label_added");
  expect(pr.qualifiers).toEqual({ label: "ready" });
  expect(pr.connection).toBe(initial.connection);
  const created = changeTriggerEvent(pr, "github.issue_created");
  expect(created.qualifiers).toEqual({});
  const slack = changeTriggerEvent(pr, "slack.mention");
  expect(slack.qualifiers).toEqual({});
  expect(slack.connection).toBe("");
});

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "requires an added label for %s",
  (event) => {
    const projection = projectTriggerForm(
      ADVANCED.replace("slack.mention", event).replace("channels: [engineering]", "label: ready"),
    );
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(triggerFormErrors({ ...projection.value, qualifiers: { label: "  " } })).toEqual({
      "qualifiers.label": "Added label is required",
    });
    expect(triggerFormErrors({ ...projection.value, qualifiers: {} })).toEqual({
      "qualifiers.label": "Added label is required",
    });
  },
);

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "rejects YAML without an added label for %s",
  (event) => {
    const missing = ADVANCED.replace("slack.mention", event);
    expect(TriggerDocumentSchema.safeParse(parseDocument(missing).toJS()).success).toBe(false);
    const blank = missing.replace("channels: [engineering]", 'label: "   "');
    expect(TriggerDocumentSchema.safeParse(parseDocument(blank).toJS()).success).toBe(false);
  },
);

test("continuation policies round-trip through the form and YAML", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.continuationMode).toBe("conversation");
  for (const mode of ["key", "new", "conversation"]) {
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      continuationMode: mode,
      continuationKey: "${{ paseo.inputs.ticket }}",
    });
    const next = projectTriggerForm(yaml);
    expect(next).toMatchObject({ status: "editable", value: { continuationMode: mode } });
    expect(yaml).toContain("# keep this heading");
  }
});

test("a trigger row names the event kind before what narrows it", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const slack = projection.value;
  expect(describeTriggerEvent(slack, "slack.mention")).toEqual({
    kind: "Slack mention",
    detail: "company",
  });
  // The recurrence used to stand in for the kind, so a schedule's row never said "Schedule".
  const schedule = {
    ...slack,
    event: "schedule.tick" as const,
    connection: "",
    recurrence: { start: "2026-01-01T08:15:00", rule: "FREQ=DAILY", timezone: "UTC" },
  };
  expect(describeTriggerEvent(schedule, "schedule.tick")).toEqual({
    kind: "Schedule",
    detail: "Every day at 08:15 (UTC)",
  });
  expect(
    describeTriggerEvent({ ...slack, event: "manual.run", connection: "" }, "manual.run"),
  ).toEqual({
    kind: "Manual run",
  });
  expect(describeTriggerEvent(null, "github.push")).toEqual({ kind: "GitHub push" });
});

test("a provider with zero modes saves without a mode in the form and YAML", () => {
  const projected = projectTriggerForm(ADVANCED);
  if (projected.status !== "editable") throw new Error("expected editable form");
  const value = { ...projected.value, agent: "pi/test-model", mode: "" };
  expect(triggerFormErrors(value, []).mode).toBeUndefined();
  const patched = patchTriggerYaml(ADVANCED, value);
  expect(TriggerDocumentSchema.parse(parseDocument(patched).toJS()).run.agent).not.toHaveProperty(
    "mode",
  );
  const yaml = createTriggerYaml(value);
  expect(TriggerDocumentSchema.parse(parseDocument(yaml).toJS()).run.agent).not.toHaveProperty(
    "mode",
  );
});

test("form submission requires concrete model and mode selections without rejecting YAML omissions", () => {
  const projected = projectTriggerForm(ADVANCED);
  if (projected.status !== "editable") throw new Error("expected editable form");
  expect(triggerFormErrors({ ...projected.value, agent: "codex" }).agent).toBe(
    "Choose a provider and model",
  );
  expect(triggerFormErrors({ ...projected.value, mode: "" }, [{ id: "full-access" }]).mode).toBe(
    "Execution mode is required",
  );
  const yaml = ADVANCED.replace("    model: gpt-5.4\n", "").replace("    mode: full-access\n", "");
  const existing = projectTriggerForm(yaml);
  expect(existing.status).toBe("editable");
  if (existing.status !== "editable") throw new Error("expected editable YAML");
  expect(patchTriggerYaml(yaml, { ...existing.value, prompt: "Updated YAML content" })).toContain(
    "Updated YAML content",
  );
});

test("the form waits to learn that a provider has no modes", () => {
  const projected = projectTriggerForm(ADVANCED);
  if (projected.status !== "editable") throw new Error("expected editable form");
  const value = { ...projected.value, mode: "" };
  expect(triggerFormErrors(value).mode).toBe(
    "Load execution modes from the selected daemon or save as YAML",
  );
  expect(triggerFormErrors(value, []).mode).toBeUndefined();
});

describe("who can invoke a trigger", () => {
  const GITHUB = ADVANCED.replace("slack.mention", "github.issue_comment_created").replace(
    "channels: [engineering]",
    'contains: "@paseo"',
  );

  function filtersOf(yaml: string, event: string) {
    return TriggerDocumentSchema.parse(parseDocument(yaml).toJS()).on[event]?.filters;
  }

  function editable(yaml: string) {
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    return projection.value;
  }

  test("GitHub creation events start at members; events where another actor can act start at everyone", () => {
    for (const event of [
      "github.issue_created",
      "github.pull_request_created",
      "github.issue_comment_created",
      "github.pull_request_comment_created",
    ] as const) {
      expect(defaultAudience(event)).toBe("members");
      expect(eventDefinition(event).audiences).toEqual([
        "members",
        "contributors",
        "everyone",
        "specific",
      ]);
    }
    for (const event of [
      "slack.mention",
      "discord.mention",
      "linear.comment_created",
      // GitHub reports only the original author's association when another user acts on an item.
      "github.pull_request_ready_for_review",
      "github.pull_request_synchronized",
      "github.issue_label_added",
      "github.pull_request_label_added",
      "github.issue_comment",
      "github.issues",
      "github.pull_request",
      "github.pull_request_review",
      "github.pull_request_review_comment",
      "github.push",
    ] as const) {
      expect(defaultAudience(event)).toBe("everyone");
      expect(eventDefinition(event).audiences).toEqual(["everyone", "specific"]);
    }
    expect(eventDefinition("manual.run").audiences).toEqual([]);
  });

  test("reads an existing allowlist exactly as it was written", () => {
    expect(editable(GITHUB)).toMatchObject({ audience: "everyone", allowedUsers: "" });
    const named = GITHUB.replace('from_users: ["*"]', "from_users: [boudra, octocat]");
    expect(editable(named)).toMatchObject({
      audience: "specific",
      allowedUsers: "boudra, octocat",
    });
    expect(patchTriggerYaml(named, editable(named))).toBe(named);
  });

  test.each([
    ["members", ["OWNER", "MEMBER", "COLLABORATOR"]],
    ["contributors", ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]],
  ] as const)("writes %s as GitHub repository associations", (audience, associations) => {
    const yaml = patchTriggerYaml(GITHUB, { ...editable(GITHUB), audience });
    expect(filtersOf(yaml, "github.issue_comment_created")).toEqual({
      author_associations: associations,
      contains: "@paseo",
    });
    expect(yaml).toContain("# keep this heading");
    expect(editable(yaml)).toMatchObject({ audience, allowedUsers: "" });

    const created = createTriggerYaml({ ...editable(GITHUB), audience });
    expect(filtersOf(created, "github.issue_comment_created")).toEqual({
      author_associations: associations,
    });
  });

  test("moves between everyone, named people, and members without leaving the old list behind", () => {
    const members = patchTriggerYaml(GITHUB, { ...editable(GITHUB), audience: "members" });
    const named = patchTriggerYaml(members, {
      ...editable(members),
      audience: "specific",
      allowedUsers: "boudra, octocat",
    });
    expect(filtersOf(named, "github.issue_comment_created")).toEqual({
      from_users: ["boudra", "octocat"],
      contains: "@paseo",
    });
    const everyone = patchTriggerYaml(named, { ...editable(named), audience: "everyone" });
    expect(filtersOf(everyone, "github.issue_comment_created")).toEqual({
      from_users: ["*"],
      contains: "@paseo",
    });
  });

  test("asks for a name only when specific people are chosen", () => {
    expect(
      triggerFormErrors({ ...editable(GITHUB), audience: "specific", allowedUsers: " " })
        .allowedUsers,
    ).toBe("Name at least one person");
    expect(
      triggerFormErrors({ ...editable(GITHUB), audience: "members", allowedUsers: "" }),
    ).toEqual({});
  });

  test("leaves an audience the form cannot express to YAML", () => {
    const custom = GITHUB.replace('from_users: ["*"]', "author_associations: [OWNER]");
    expect(projectTriggerForm(custom)).toEqual({
      status: "yaml_only",
      reason: "Edit this trigger in YAML because its author associations are a custom list",
    });
    const both = GITHUB.replace(
      'from_users: ["*"]',
      "from_users: [boudra]\n      author_associations: [OWNER, MEMBER, COLLABORATOR]",
    );
    expect(projectTriggerForm(both)).toEqual({
      status: "yaml_only",
      reason: "Edit this trigger in YAML because it combines named users with author associations",
    });
  });

  test("an untouched audience follows the event, and a chosen one is kept where it is offered", () => {
    const slack = editable(ADVANCED);
    const comment = changeTriggerEvent(slack, "github.issue_comment_created");
    expect(comment).toMatchObject({ audience: "members", allowedUsers: "" });
    expect(changeTriggerEvent(comment, "github.push").audience).toBe("everyone");
    expect(
      changeTriggerEvent(changeTriggerEvent(comment, "github.push"), "github.pull_request_created")
        .audience,
    ).toBe("members");

    const contributors = { ...comment, audience: "contributors" as const };
    expect(changeTriggerEvent(contributors, "github.pull_request_created").audience).toBe(
      "contributors",
    );
    expect(changeTriggerEvent(contributors, "github.push").audience).toBe("everyone");

    const named = { ...comment, audience: "specific" as const, allowedUsers: "boudra" };
    expect(changeTriggerEvent(named, "github.push")).toMatchObject({
      audience: "specific",
      allowedUsers: "boudra",
    });
    // A GitHub login means nothing to Slack.
    expect(changeTriggerEvent(named, "slack.mention")).toMatchObject({
      audience: "everyone",
      allowedUsers: "",
    });
  });
});
