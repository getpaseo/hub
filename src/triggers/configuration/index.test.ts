import assert from "node:assert/strict";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describe, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";

function reportsMissingEvent(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "on" && /at least one event/u.test(message),
    )
  );
}

const trigger = `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`;

describe("self-contained trigger documents", () => {
  it("compiles and preserves a configurable startup timeout", () => {
    const yaml = trigger.replace("  max_runtime: 90m", "  max_runtime: 90m\n  startup_timeout: 3m");
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.events[0]?.steps[0]?.startupTimeoutMs, 180_000);
    assert.equal(
      parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run.startup_timeout,
      "3m",
    );
  });

  it.each(["0s", "25h", "invalid"])("rejects invalid startup timeout %s", (duration) => {
    assert.throws(
      () =>
        compileTriggerDocument(
          trigger.replace(
            "  max_runtime: 90m",
            `  max_runtime: 90m\n  startup_timeout: ${duration}`,
          ),
        ),
      /startup_timeout/,
    );
  });

  it("compiles every input event to one launch against the inline target and agent choices", () => {
    const compiled = compileTriggerDocument(trigger);

    assert.equal(compiled.authored.name, "engineering-requests");
    assert.equal(compiled.environment.kind, "daemon");
    assert.equal(compiled.events.length, 2);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["slack.mention", "github.issue_comment"],
    );
    assert.deepEqual(compiled.events[0]?.steps[0]?.agent, {
      selector: "${{ paseo.inputs.model }}",
      choices: {
        codex: { provider: "codex", model: "gpt-5.6-sol" },
        claude: { provider: "claude", model: "claude-opus-5" },
      },
    });
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
    ]);
    assert.deepEqual(compiled.events[1]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "github.reply", required: false },
    ]);
  });

  it("round-trips the semantic document through canonical YAML", () => {
    const parsed = parseTriggerDocument(trigger);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(parsed)), parsed);
  });

  it.each([
    "  shared-review  ",
    "review:${{ paseo.trigger.conversation_key }}",
    "review:${{ paseo.inputs.model }}",
  ])(
    "preserves affinity %s for every event and keeps workspace retention separate from idle timeout",
    (key) => {
      const document = parseTriggerDocument(trigger);
      document.max_runtime = "4h";
      document.run.continuation = { mode: "new" };
      document.run.workspace_affinity = { key };
      document.run.auto_archive = false;
      const yaml = serializeTriggerDocument(document);
      const compiled = compileTriggerDocument(yaml);
      assert.deepEqual(parseTriggerDocument(yaml).run.workspace_affinity, { key });
      for (const event of compiled.events) {
        assert.equal(event.maxRuntimeMs, 4 * 60 * 60_000);
        assert.deepEqual(event.steps[0]?.workspaceAffinity, { key });
        assert.equal(event.steps[0]?.maxRuntimeMs, 90 * 60_000);
        assert.equal(event.steps[0]?.idleTimeoutMs, 10 * 60_000);
        assert.equal(event.steps[0]?.autoArchive, false);
      }
    },
  );

  it.each([
    "${{ paseo.prompt }}",
    "${{ paseo.context.linear.issue.id }}",
    "${{ paseo.execution.id }}",
  ])("rejects untrusted workspace selection %s through the single-run compiler", (key) => {
    const document = parseTriggerDocument(trigger);
    document.run.continuation = { mode: "new" };
    document.run.workspace_affinity = { key };
    assert.throws(
      () => compileTriggerDocument(serializeTriggerDocument(document)),
      TriggerDocumentError,
    );
  });

  it("validates the conversation key against every subscribed event", () => {
    const document = parseTriggerDocument(trigger);
    document.on["manual.run"] = {};
    document.run.continuation = { mode: "new" };
    document.run.workspace_affinity = { key: "${{ paseo.trigger.conversation_key }}" };
    assert.throws(
      () => compileTriggerDocument(serializeTriggerDocument(document)),
      /manual\.run does not provide a conversation key/u,
    );
  });

  it("rejects an execution-scoped worktree for a single-run affinity key", () => {
    const document = parseTriggerDocument(trigger);
    document.run.continuation = { mode: "new" };
    document.run.workspace_affinity = { key: "shared-review" };
    document.run.target.worktree = {
      mode: "branch-off",
      newBranch: "run-${{ paseo.execution.id }}",
    };
    assert.throws(() => compileTriggerDocument(serializeTriggerDocument(document)), /execution/u);
  });

  it("allows authenticated manual dispatches when no actor filter is authored", () => {
    const compiled = compileTriggerDocument(`
name: deploy
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.filters?.from_users, ["*"]);
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, []);
  });

  it("automatically grants an unlimited event-native reply for a new conversational trigger", () => {
    const compiled = compileTriggerDocument(`
name: answer
on:
  slack.mention:
    connection: acme-slack
    filters: { from_users: ["*"] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", required: false },
    ]);
  });

  it("rejects a trigger without events at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: empty
on: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`),
      reportsMissingEvent,
    );
  });
});

it("applies the continuation default when reading old trigger revisions without rewriting their evidence", () => {
  const compiled = compileTriggerDocument(trigger);
  const stored = structuredClone({
    environments: [{ ...compiled.environment, daemonId: "daemon" }],
    triggers: compiled.events,
  });
  for (const event of stored.triggers) for (const step of event.steps) delete step.continuation;
  const revision: ProjectConfigurationRevisionRecord = {
    id: "revision",
    projectId: "project",
    organizationId: "org",
    version: 1,
    sourceKind: "manual",
    sourceEvidence: { kind: "organization_trigger_adapter" },
    rawYaml: trigger,
    normalizedConfiguration: stored,
    validationErrors: null,
    contentHash: "original",
    createdByUserId: "user",
    receivedAt: null,
    createdAt: new Date(),
    validatedAt: new Date(),
  };
  const loaded = parseProjectConfiguration(revision);
  assert.deepEqual(loaded.triggers[0]?.steps[0]?.continuation, { mode: "conversation" });
  assert.equal(stored.triggers[0]?.steps[0]?.continuation, undefined);
  const legacy = parseProjectConfiguration({ ...revision, sourceEvidence: { kind: "manual" } });
  assert.equal(legacy.triggers[0]?.steps[0]?.continuation, undefined);
  const migratedLegacy = parseProjectConfiguration({
    ...revision,
    rawYaml: JSON.stringify({
      name: "preserved-workflow",
      legacy_multistep: { trigger: stored.triggers[0], environments: stored.environments },
    }),
  });
  assert.deepEqual(migratedLegacy, legacy);
});
