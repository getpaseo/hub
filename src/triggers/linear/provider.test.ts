import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  LinearAgentActivityHistory,
  LinearApiClient,
  LinearIssueCommentHistory,
} from "../../providers/linear/client.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import type { NormalizedLinearAgentSessionEvent, NormalizedLinearCommentEvent } from "./events.js";
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
    assert.deepEqual(match.triggerContext.event.linear.trigger_thread_context, {
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

  it("uses promptContext for a new native agent session and acknowledges it promptly", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (
      await provider.match(
        externalAgentSession(project.id, revision.id, agentSessionEvent({ action: "created" })),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.equal(match.invocation.prompt, "<issue>Canonical Linear context</issue>");
    assert.deepEqual(match.outputContext, {
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      agentSessionId: "session-1",
    });
    assert.deepEqual(client.activityReads, []);

    const context = await provider.materializeContext!({
      executionId: "execution-linear-agent-created",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111122",
      triggerContext: match.triggerContext,
    });
    assert.equal(context.linear.thread.status, "available");
    assert.deepEqual(client.activityReads, []);

    const acceptedState = await provider.onDispatchAccepted?.(
      match.triggerContext,
      match.outputContext,
    );
    await provider.onDispatchAccepted?.(
      match.triggerContext,
      match.outputContext,
      acceptedState ?? undefined,
    );
    const failedState = await provider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "runner unavailable",
      acceptedState ?? undefined,
    );
    await provider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "runner unavailable",
      failedState ?? undefined,
    );
    assert.deepEqual(client.createdActivities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "thought",
          body: "Paseo accepted this task and is starting the workflow.",
        },
        ephemeral: true,
      },
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "error",
          body: "Paseo could not complete this workflow: runner unavailable",
        },
      },
    ]);

    const terminationClient = new RecordingHistoryClient({ complete: true, comments: [] });
    const terminationProvider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: terminationClient,
    });
    const terminationAcceptedState = await terminationProvider.onDispatchAccepted?.(
      match.triggerContext,
      match.outputContext,
    );
    const terminationFailedState = await terminationProvider.onMachineTerminated?.(
      match.triggerContext,
      "daemon disconnected",
      terminationAcceptedState ?? undefined,
    );
    await terminationProvider.onMachineTerminated?.(
      match.triggerContext,
      "daemon disconnected",
      terminationFailedState ?? undefined,
    );
    assert.deepEqual(terminationClient.createdActivities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "thought",
          body: "Paseo accepted this task and is starting the workflow.",
        },
        ephemeral: true,
      },
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "error",
          body: "Paseo could not complete this workflow: daemon disconnected",
        },
      },
    ]);
  });

  it("materializes only bounded causal activity for prompted agent-session turns", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const triggerAt = "2026-01-02T00:01:00.000Z";
    const beforeTrigger = Array.from({ length: 55 }, (_, index) => ({
      id: `activity-${index + 1}`,
      type: index % 2 === 0 ? ("prompt" as const) : ("response" as const),
      body: `earlier-${index + 1}`,
      createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      author: { id: index % 2 === 0 ? "operator" : "app-user" },
    }));
    const client = new RecordingHistoryClient({ complete: true, comments: [] }, undefined, {
      complete: true,
      activities: [
        {
          id: "later-activity",
          type: "prompt",
          body: "later",
          createdAt: "2026-01-03T00:00:00.000Z",
          author: { id: "operator" },
        },
        {
          id: "trigger-activity",
          type: "prompt",
          body: "trigger",
          createdAt: triggerAt,
          author: { id: "operator" },
        },
        ...beforeTrigger.toReversed(),
      ],
    });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (
      await provider.match(
        externalAgentSession(project.id, revision.id, agentSessionEvent({ occurredAt: triggerAt })),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.equal(match.invocation.prompt, "Please also add tests");
    assert.deepEqual(client.activityReads, []);
    const context = await provider.materializeContext!({
      executionId: "execution-linear-agent-prompted",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111123",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.activityReads, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        beforeCreatedAt: triggerAt,
      },
    ]);
    assert.equal(context.linear.thread.status, "incomplete");
    assert.equal(context.linear.thread.messages.length, 50);
    assert.equal(context.linear.thread.messages[1]?.id, "activity-7");
    assert.equal(context.linear.thread.messages.at(-1)?.id, "activity-55");
    assert.equal(
      context.linear.thread.messages.some(
        (message) => message.id === "trigger-activity" || message.id === "later-activity",
      ),
      false,
    );
  });

  it("fails open when optional agent-session activity history is unavailable", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient(
      { complete: true, comments: [] },
      undefined,
      undefined,
      new Error("Linear activity history unavailable"),
    );
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (
      await provider.match(externalAgentSession(project.id, revision.id, agentSessionEvent()))
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-agent-history-unavailable",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111124",
      triggerContext: match.triggerContext,
    });
    assert.equal(context.linear.thread.status, "unavailable");
    assert.equal(context.linear.thread.messages.length, 1);
  });
});

class RecordingHistoryClient implements Pick<
  LinearApiClient,
  "readIssueComments" | "readAgentSessionActivities" | "createAgentActivity"
> {
  historyReads: Array<{
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }> = [];
  activityReads: Array<{
    linearOrganizationId: string;
    agentSessionId: string;
    beforeCreatedAt: string;
  }> = [];
  createdActivities: Parameters<LinearApiClient["createAgentActivity"]>[0][] = [];

  constructor(
    private readonly history: LinearIssueCommentHistory | undefined,
    private readonly error?: Error,
    private readonly activityHistory: LinearAgentActivityHistory | undefined = {
      complete: true,
      activities: [],
    },
    private readonly activityError?: Error,
  ) {}

  readIssueComments(input: (typeof this.historyReads)[number]): Promise<LinearIssueCommentHistory> {
    this.historyReads.push(input);
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.history === undefined) return Promise.reject(new Error("history was not configured"));
    return Promise.resolve(this.history);
  }

  readAgentSessionActivities(
    input: (typeof this.activityReads)[number],
  ): Promise<LinearAgentActivityHistory> {
    this.activityReads.push(input);
    if (this.activityError !== undefined) return Promise.reject(this.activityError);
    if (this.activityHistory === undefined) {
      return Promise.reject(new Error("activity history was not configured"));
    }
    return Promise.resolve(this.activityHistory);
  }

  createAgentActivity(input: Parameters<LinearApiClient["createAgentActivity"]>[0]): Promise<void> {
    this.createdActivities.push(input);
    return Promise.resolve();
  }
}

function activeConfiguration(configuration = linearCommentConfiguration()) {
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

function agentSessionConfiguration() {
  const configuration = linearCommentConfiguration();
  return {
    ...configuration,
    triggers: [
      {
        ...configuration.triggers[0]!,
        name: "agent-session",
        on: "linear.agent_session",
        steps: [
          {
            ...configuration.triggers[0]!.steps[0]!,
            allow_outputs: [{ type: "linear.reply", max: 1, required: true }],
          },
        ],
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

function externalAgentSession(
  projectId: string,
  configurationRevisionId: string,
  payload: NormalizedLinearAgentSessionEvent,
): ExternalTrigger {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111122",
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    source: "linear.agent_session",
    deliveryId: "delivery-agent-session-1",
    receivedAt: new Date(payload.occurredAt),
    connectionId: "linear-connection",
    payload,
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

function agentSessionEvent(
  overrides: Partial<NormalizedLinearAgentSessionEvent> = {},
): NormalizedLinearAgentSessionEvent {
  return {
    type: "agent_session",
    action: "prompted",
    id: "trigger-activity",
    organizationId: "linear-org",
    actor: { id: "operator", name: "Operator" },
    agentSession: {
      id: "session-1",
      appUserId: "app-user",
      issueId: "issue-1",
      status: "active",
      url: "https://linear.app/acme/issue/ENG-42#agent-session-session-1",
    },
    agentActivity: {
      id: "trigger-activity",
      type: "prompt",
      body: "Please also add tests",
      createdAt: "2026-01-02T00:01:00.000Z",
    },
    prompt: "Please also add tests",
    parserMessage: "Please also add tests",
    promptContext: null,
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: "app-user",
      labelIds: [],
    },
    occurredAt: "2026-01-02T00:01:00.000Z",
    ...overrides,
    ...(overrides.action === "created"
      ? {
          id: "session-1",
          agentActivity: null,
          prompt: "<issue>Canonical Linear context</issue>",
          parserMessage: "@Paseo please draft a fix",
          promptContext: "<issue>Canonical Linear context</issue>",
          occurredAt: "2026-01-02T00:00:00.000Z",
        }
      : {}),
  };
}
