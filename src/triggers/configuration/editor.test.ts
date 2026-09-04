import { EDITOR_EVENTS } from "./events.js";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { TriggerDocumentSchema } from "./schema.js";
import {
  changeTriggerEvent,
  createTriggerYaml,
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
      reason: "The form does not support the custom.event event.",
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
      allowedUsers: "*",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "codex/gpt-5.4",
      mode: "full-access",
      thinkingOptionId: "",
      providerOptions: "",
      maxRuntime: "2h",
      idleTimeout: "10m",
      githubConnection: "",
      githubRepositories: "",
      githubPermissions: "",
      githubDuration: "1h",
      prompt: "Handle it.",
    });
    expect(parseDocument(yaml).toJS()).toEqual({
      name: "answer",
      enabled: true,
      on: { "manual.run": {} },
      run: {
        target: { daemon: "office", cwd: "/workspace" },
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
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
      allowedUsers: "*",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "opencode",
      mode: "full-access",
      thinkingOptionId: "",
      providerOptions: "",
      maxRuntime: "2h",
      idleTimeout: "10m",
      githubConnection: "",
      githubRepositories: "",
      githubPermissions: "",
      githubDuration: "1h",
      prompt: "${{ paseo.prompt }}",
    });
    const projection = projectTriggerForm(initial);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm(initial, { ...projection.value, name: "release" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("name: release");
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
      reason: "Daemon is required.",
    });
    expect(mergeTriggerForm("", { ...projection.value, agent: "" })).toEqual({
      status: "incomplete",
      reason: "Agent is required.",
    });
    expect(mergeTriggerForm("", { ...projection.value, providerOptions: "{" })).toEqual({
      status: "incomplete",
      reason: "Provider options must be valid JSON.",
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
      daemon: "Daemon is required.",
    });
    expect(triggerFormErrors({ ...editable(), cwd: "workspace" })).toEqual({
      cwd: "Working directory must be an absolute path.",
    });
    expect(triggerFormErrors({ ...editable(), agent: "" })).toEqual({
      agent: "Agent is required.",
    });
    expect(triggerFormErrors({ ...editable(), providerOptions: "{" })).toEqual({
      providerOptions: "Provider options must be valid JSON.",
    });
    expect(triggerFormErrors({ ...editable(), prompt: "  " })).toEqual({
      prompt: "Instructions are required.",
    });
  });

  test("holds the name to the document's own alphabet", () => {
    expect(triggerFormErrors({ ...editable(), name: "" }).name).toBe("Trigger name is required.");
    expect(triggerFormErrors({ ...editable(), name: "Slack Triage" }).name).toBe(
      "Use lowercase letters, digits, and hyphens, starting with a letter.",
    );
    expect(triggerFormErrors({ ...editable(), name: "slack-triage" }).name).toBeUndefined();
  });

  test("asks for a connection only when an event arrives on one", () => {
    expect(triggerFormErrors({ ...editable(), connection: "" }).connection).toBe(
      "Connection is required.",
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
    ).toBe("GitHub permissions must be valid JSON.");
    expect(
      triggerFormErrors({
        ...editable(),
        githubConnection: "company",
        githubPermissions: '{"a":1}',
      }).githubPermissions,
    ).toBe('GitHub permissions map a scope to "read", "write", or "admin".');
  });

  test("reports the topmost problem when the document cannot be written at all", () => {
    expect(mergeTriggerForm("", { ...editable(), name: "", daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Trigger name is required.",
    });
  });
});

test.each([
  "github.pull_request_created",
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
    "Added label is required.",
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
      "qualifiers.label": "Added label is required.",
    });
    expect(triggerFormErrors({ ...projection.value, qualifiers: {} })).toEqual({
      "qualifiers.label": "Added label is required.",
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
