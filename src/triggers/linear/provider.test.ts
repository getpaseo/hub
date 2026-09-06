import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearApiClient, LinearIssueCommentHistory } from "../../providers/linear/client.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import type { NormalizedLinearCommentEvent } from "./events.js";
import { createLinearTriggerProvider } from "./provider.js";

describe("Linear trigger provider", () => {
  it.each([
    ["pattern", { pattern: "/run" }, "/run priority=high investigate"],
    ["contains", { contains: "/run" }, "please /run priority=high investigate"],
  ] as const)(
    "parses inputs after a matched Linear %s marker while preserving the original comment prompt",
    async (_filterName, marker, body) => {
      const { project, revision, store } = await activeConfiguration(commandConfiguration(marker));
      const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });

      const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
      if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

      assert.deepEqual(match.invocation, {
        status: "accepted",
        prompt: body,
        inputs: { priority: "high" },
      });
    },
  );

  it("keeps an input-shaped contains marker available to parsing and input filters", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration(),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("parses after a contains command marker following a matched pattern", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ pattern: "@paseo", contains: "/run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo please /run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { priority: "high" },
    });
  });

  it("keeps an input-shaped contains marker after a matched pattern", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "@paseo" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo please repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("keeps an input-shaped suffix of an overlapping contains marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "@paseo", contains: "@paseo repo=hub" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("retains a leading input-shaped pattern when stripping a later command marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "repo=hub", contains: "/run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "repo=hub /run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("does not treat an inside-word contains match as a command marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ contains: "run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please prerun priority=high investigate";

    const matches = await provider.match(external(project.id, revision.id, undefined, body));
    if (typeof matches === "string") throw new Error("expected invocation rejection");
    const match = matches[0];
    if (match === undefined || match.invocation.status !== "rejected") {
      throw new Error("expected rejected match");
    }

    assert.equal(match.invocation.prompt, body);
    assert.deepEqual(match.invocation.inputs, {});
    assert.deepEqual(match.invocation.rejection, {
      code: "missing_required",
      inputName: "priority",
    });
  });

  it("uses the first boundary-delimited contains marker after prose", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ contains: "run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please prerun run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { priority: "high" },
    });
  });

  it("takes the session prompt from the mention and parses its typed inputs", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });

    const match = (await provider.match(agentSessionExternal(project.id, revision.id)))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.invocation.prompt, "@Paseo agent=fast ship it");
    assert.equal(match.invocation.inputs["agent"], "fast");
    assert.deepEqual(match.outputContext, {
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      agentSessionId: "session-1",
    });
  });

  it("uses Linear's rendered session context instead of reading the comment history", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (await provider.match(agentSessionExternal(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const materialized = await provider.materializeContext!({
      executionId: "execution-1",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111120",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.historyReads, []);
    assert.equal(materialized.linear.thread.status, "available");
    assert.deepEqual(materialized.linear.thread.messages, [
      { id: "session-1", content: "Issue ENG-1\n\nShip it", author: null, created_at: null },
    ]);
  });

  it("defers a bounded, causal issue history until context materialization", async () => {
    const { project, revision, store } = await activeConfiguration();
    const triggerAt = "2026-01-02T00:00:00.000Z";
    const beforeTrigger = Array.from({ length: 55 }, (_, index) => ({
      id: `comment-${index + 1}`,
      body: `earlier-${index + 1}`,
      createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      author: { id: `user-${index + 1}` },
    }));
    const client = new RecordingHistoryClient({
      complete: true,
      comments: [
        { id: "later-comment", body: "later", createdAt: "2026-01-03T00:00:00.000Z", author: null },
        { id: "trigger-comment", body: "trigger", createdAt: triggerAt, author: null },
        ...beforeTrigger.toReversed(),
      ],
    });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });

    const match = (await provider.match(external(project.id, revision.id, triggerAt)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(client.historyReads, []);
    const linearContext = match.triggerContext.event.linear;
    if (linearContext.event_type === "agent_session") throw new Error("expected entity context");
    assert.deepEqual(linearContext.trigger_thread_context, {
      status: "deferred",
      issue: { id: "issue-1" },
      before: { created_at: triggerAt },
    });

    const context = await provider.materializeContext!({
      executionId: "execution-linear-history",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.historyReads, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        beforeCreatedAt: triggerAt,
      },
    ]);
    assert.equal(context.linear.thread.status, "incomplete");
    assert.equal(context.linear.thread.messages.length, 50);
    assert.deepEqual(context.linear.thread.messages[0], {
      id: "issue-1",
      content: "Ship the feature\n\nUseful context",
      author: null,
      created_at: null,
    });
    assert.equal(context.linear.thread.messages[1]?.id, "comment-7");
    assert.equal(context.linear.thread.messages.at(-1)?.id, "comment-55");
    assert.equal(
      context.linear.thread.messages.some(
        (message) => message.id === "trigger-comment" || message.id === "later-comment",
      ),
      false,
    );
  });

  it("keeps a valid Linear run usable when optional history retrieval fails", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient(undefined, new Error("Linear history unavailable")),
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-unavailable",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111120",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(context.linear.thread, {
      status: "unavailable",
      messages: [
        {
          id: "issue-1",
          content: "Ship the feature\n\nUseful context",
          author: null,
          created_at: null,
        },
      ],
    });
  });

  it("does not fetch history without a causal event timestamp", async () => {
    const { project, revision, store } = await activeConfiguration();
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const { occurredAt: _occurredAt, ...payload } = event("2026-01-02T00:00:00.000Z");
    const match = (
      await provider.match({
        ...external(project.id, revision.id),
        payload,
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-no-anchor",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111121",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.historyReads, []);
    assert.equal(context.linear.thread.status, "unavailable");
    assert.equal(context.linear.thread.messages.length, 1);
  });
});

class RecordingHistoryClient implements Pick<LinearApiClient, "readIssueComments"> {
  historyReads: Array<{
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }> = [];

  constructor(
    private readonly history: LinearIssueCommentHistory | undefined,
    private readonly error?: Error,
  ) {}

  readIssueComments(input: (typeof this.historyReads)[number]): Promise<LinearIssueCommentHistory> {
    this.historyReads.push(input);
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.history === undefined) return Promise.reject(new Error("history was not configured"));
    return Promise.resolve(this.history);
  }
}

function activeConfiguration(configuration: unknown = linearCommentConfiguration()) {
  return createActiveProjectConfiguration(createMemoryDatabase(), configuration, {
    organizationId: "hub-org",
  });
}

function linearCommentConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "comment",
        on: "linear.comment_created",
        max_runtime: "1h",
        filters: { project: "project-1", from_users: ["operator"] },
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work from ${{ paseo.context }}" }],
          },
        ],
      },
    ],
  };
}

function agentSessionConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "mention",
        on: "linear.agent_session",
        max_runtime: "1h",
        inputs: { agent: { type: "string", default: "opus" } },
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work from ${{ paseo.context }}" }],
          },
        ],
      },
    ],
  };
}

function agentSessionExternal(projectId: string, configurationRevisionId: string): ExternalTrigger {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111120",
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    source: "linear.agent_session",
    deliveryId: "delivery-2",
    receivedAt: new Date("2026-01-02T00:00:00.000Z"),
    connectionId: "linear-connection",
    payload: {
      type: "agent_session",
      action: "created",
      id: "session-1",
      organizationId: "linear-org",
      actor: { id: "operator" },
      agentSession: { id: "session-1", status: "pending", commentId: "comment-1" },
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Ship it",
        description: null,
        projectId: "project-1",
        stateId: "todo",
        assigneeId: null,
        labelIds: [],
      },
      prompt: "@Paseo agent=fast ship it",
      promptContext: "Issue ENG-1\n\nShip it",
      occurredAt: "2026-01-02T00:00:00.000Z",
    },
  };
}

function commandConfiguration(marker: { pattern?: string; contains?: string }) {
  const configuration = linearCommentConfiguration();
  const trigger = configuration.triggers[0]!;
  return {
    ...configuration,
    triggers: [
      {
        ...trigger,
        inputs: {
          priority: { type: "string", required: true, choices: ["high", "low"] },
        },
        filters: {
          ...trigger.filters,
          ...marker,
          inputs: { priority: "high" },
        },
      },
    ],
  };
}

function inputShapedMarkerConfiguration(marker: { pattern?: string; contains?: string } = {}) {
  const configuration = linearCommentConfiguration();
  const trigger = configuration.triggers[0]!;
  return {
    ...configuration,
    triggers: [
      {
        ...trigger,
        inputs: {
          repo: { type: "string", required: true, choices: ["hub", "paseo"] },
          priority: { type: "string", required: true, choices: ["high", "low"] },
        },
        filters: {
          ...trigger.filters,
          contains: "repo=hub",
          ...marker,
          inputs: { repo: "hub" },
        },
      },
    ],
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  occurredAt = "2026-01-02T00:00:00.000Z",
  commentBody = "@paseo please investigate",
): ExternalTrigger {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    source: "linear.comment",
    deliveryId: "delivery-1",
    receivedAt: new Date(occurredAt),
    connectionId: "linear-connection",
    payload: event(occurredAt, commentBody),
  };
}

function event(
  occurredAt: string,
  commentBody = "@paseo please investigate",
): NormalizedLinearCommentEvent {
  return {
    type: "comment",
    action: "create",
    id: "trigger-comment",
    organizationId: "linear-org",
    actor: { id: "operator" },
    comment: { id: "trigger-comment", issueId: "issue-1", body: commentBody },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: null,
      labelIds: [],
    },
    occurredAt,
  };
}
