import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  LinearAgentActivityHistory,
  LinearApiClient,
  LinearCommentThread,
  LinearIssueCommentHistory,
} from "../../providers/linear/client.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { Database, ProviderEventReceiptRecord } from "../../db/types.js";
import type { TriggerProviderExecutionControl } from "../../providers/registration.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { DurableWorkflowEngine } from "../../workflows/engine.js";
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
    assert.deepEqual(match.triggerContext.event.linear.issue.team, { id: "team-1" });
    assert.deepEqual(match.triggerContext.event.linear.comment, {
      id: "trigger-comment",
      body: "@paseo please investigate",
      parent_id: "root-comment",
    });
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

  it("targets the thread root so a reply nests where Linear allows", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const trigger = external(project.id, revision.id);

    const nested = (await provider.match(trigger))[0];
    if (!isAcceptedTriggerProviderMatch(nested)) throw new Error("expected accepted match");
    assert.deepEqual(nested.outputContext, {
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      agentSessionId: null,
      threadRootCommentId: "root-comment",
    });

    const comment = event("2026-01-02T00:00:00.000Z");
    const topLevel = (
      await provider.match({
        ...trigger,
        payload: { ...comment, comment: { ...comment.comment, parentId: null } },
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(topLevel)) throw new Error("expected accepted match");
    assert.equal(topLevel.outputContext.threadRootCommentId, "trigger-comment");
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
      threadRootCommentId: null,
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

  it("closes an agent session explicitly when the workflow ends without a reply", async () => {
    const { match, acceptedState, provider, client } = await acceptedAgentSession();

    const completedState = await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded", outputEmissions: {} },
      acceptedState ?? undefined,
    );
    assert.deepEqual(completedState, { phase: "completed" });
    // Redelivered completion notifications must not post twice.
    await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded", outputEmissions: {} },
      completedState ?? undefined,
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
          type: "response",
          body: "Paseo finished this workflow without posting a reply.",
        },
      },
    ]);
  });

  it("does not close an agent session that a delivered reply already closed", async () => {
    const { match, acceptedState, provider, client } = await acceptedAgentSession();
    client.createdActivities.length = 0;

    const repliedState = await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded", outputEmissions: { "linear.reply": 1 } },
      acceptedState ?? undefined,
    );
    assert.deepEqual(repliedState, { phase: "completed" });
    // Unknown emissions are left alone.
    await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded" },
      acceptedState ?? undefined,
    );
    assert.deepEqual(client.createdActivities, []);
  });

  it("posts a short error when the reply to an agent session could not be delivered", async () => {
    const { match, acceptedState, provider, client } = await acceptedAgentSession();

    const failedState = await provider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "output_delivery_failed",
      acceptedState ?? undefined,
    );

    assert.deepEqual(failedState, { phase: "failed" });
    assert.deepEqual(client.createdActivities.at(-1), {
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      content: { type: "error", body: "Paseo could not deliver its reply to this session." },
    });
  });

  it("stays silent when an issue-comment run could not deliver its reply", async () => {
    const { project, revision, store } = await activeConfiguration();
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const failedState = await provider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "output_delivery_failed",
    );

    assert.equal(failedState, undefined);
    assert.deepEqual(client.createdActivities, []);
  });

  it("has no agent session to close for issue-comment triggers", async () => {
    const { project, revision, store } = await activeConfiguration();
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const completedState = await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded", outputEmissions: {} },
    );
    assert.equal(completedState, undefined);
    assert.deepEqual(client.createdActivities, []);
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

  it("reads the thread's authors for thread_with_app and fires only when the app wrote in it", async () => {
    const { project, revision, store } = await activeConfiguration(threadWithAppConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    client.thread = { rootId: "root-comment", authorIds: ["operator", "app-user"] };
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      connectionForLinearOrganization: async () => ({ appUserId: "app-user" }),
    });

    assert.deepEqual(await matchedTriggerNames(provider, external(project.id, revision.id)), [
      "in-app-thread",
      "plain",
    ]);
    assert.deepEqual(client.threadReads, [
      { linearOrganizationId: "linear-org", commentId: "trigger-comment" },
    ]);

    client.thread = { rootId: "root-comment", authorIds: ["operator", "reviewer"] };
    assert.deepEqual(await matchedTriggerNames(provider, external(project.id, revision.id)), [
      "plain",
    ]);
  });

  it("does not read the thread unless a trigger asks for the app in it", async () => {
    const { project, revision, store } = await activeConfiguration();
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      connectionForLinearOrganization: () => Promise.reject(new Error("must not be consulted")),
    });

    assert.deepEqual(await matchedTriggerNames(provider, external(project.id, revision.id)), [
      "comment",
    ]);
    assert.deepEqual(client.threadReads, []);
  });

  it("does not read the thread when only a non-comment trigger asks for the app in it", async () => {
    const configuration = linearCommentConfiguration();
    const sessionTrigger = agentSessionConfiguration().triggers[0]!;
    const sessionTriggerWithThreadFilter = {
      ...sessionTrigger,
      filters: { ...sessionTrigger.filters, thread_with_app: true },
    };
    const { project, revision, store } = await activeConfiguration({
      ...configuration,
      triggers: [...configuration.triggers, sessionTriggerWithThreadFilter],
    });
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      connectionForLinearOrganization: () => Promise.reject(new Error("must not be consulted")),
    });

    assert.deepEqual(await matchedTriggerNames(provider, external(project.id, revision.id)), [
      "comment",
    ]);
    assert.deepEqual(client.threadReads, []);
  });

  it("fails thread_with_app closed without holding back other triggers when reads fail", async () => {
    const { project, revision, store } = await activeConfiguration(threadWithAppConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    client.threadError = new Error("Linear unavailable");
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      connectionForLinearOrganization: async () => ({ appUserId: "app-user" }),
    });

    assert.deepEqual(await matchedTriggerNames(provider, external(project.id, revision.id)), [
      "plain",
    ]);

    // Without a connection there is no app user to look for, so the thread is not even read.
    const unconnected = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      connectionForLinearOrganization: async () => undefined,
    });
    assert.deepEqual(await matchedTriggerNames(unconnected, external(project.id, revision.id)), [
      "plain",
    ]);
    assert.equal(client.threadReads.length, 1);
  });

  it("stops the run a comment trigger started from the comment that opened an agent session", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      agentSessionConfiguration(),
      { organizationId: "hub-org" },
    );
    const commentRun = (
      await database.createAcceptedTriggerRun(
        linearCommentRun(project.id, revision.id, "comment-1", "receipt-comment-run"),
      )
    ).run;
    const otherCommentRun = (
      await database.createAcceptedTriggerRun(
        linearCommentRun(project.id, revision.id, "comment-2", "receipt-other-comment-run"),
      )
    ).run;
    const stops: Parameters<TriggerProviderExecutionControl["stopActive"]>[0][] = [];
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient({ complete: true, comments: [] }),
      database: linearRunLookupDatabase(database),
      executions: {
        stopActive: async (input) => {
          stops.push(input);
          return { stopped: 1 };
        },
      },
    });

    const created = agentSessionEvent({ action: "created" });
    const matches = await provider.match(
      externalAgentSession(project.id, revision.id, {
        ...created,
        agentSession: { ...created.agentSession, rootCommentId: "comment-1" },
      }),
    );

    if (typeof matches === "string") throw new Error(`expected a match, got ${matches}`);
    assert.equal(matches.length, 1);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.projectId, project.id);
    assert.equal(stops[0]?.reason, "superseded_by_agent_session");
    const supersedes = (triggerRunId: string | null) =>
      stops[0]!.matches({ outputContext: commentRun.outputContext, triggerRunId });
    assert.equal(supersedes(commentRun.id), true);
    assert.equal(supersedes(otherCommentRun.id), false);
    assert.equal(supersedes(null), false);
  });

  it("stops the run started from the reply that opened an agent session as well as the root's", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      agentSessionConfiguration(),
      { organizationId: "hub-org" },
    );
    const rootRun = (
      await database.createAcceptedTriggerRun(
        linearCommentRun(project.id, revision.id, "comment-1", "receipt-root-run"),
      )
    ).run;
    const replyRun = (
      await database.createAcceptedTriggerRun(
        linearCommentRun(project.id, revision.id, "reply-1", "receipt-reply-run"),
      )
    ).run;
    const otherRun = (
      await database.createAcceptedTriggerRun(
        linearCommentRun(project.id, revision.id, "comment-2", "receipt-other-run"),
      )
    ).run;
    const lookups: (readonly string[])[] = [];
    const stops: Parameters<TriggerProviderExecutionControl["stopActive"]>[0][] = [];
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient({ complete: true, comments: [] }),
      database: {
        listTriggerRunsForLinearComments: (projectId, commentIds) => {
          lookups.push(commentIds);
          return database.listTriggerRunsForLinearComments(projectId, commentIds);
        },
        findProviderEventReceiptById: (id) => database.findProviderEventReceiptById(id),
      },
      executions: {
        stopActive: async (input) => {
          stops.push(input);
          return { stopped: 2 };
        },
      },
    });
    const created = agentSessionEvent({ action: "created" });
    const session = (comments: { rootCommentId?: string; sourceCommentId?: string }) =>
      externalAgentSession(project.id, revision.id, {
        ...created,
        agentSession: { ...created.agentSession, ...comments },
      });

    const matches = await provider.match(
      session({ rootCommentId: "comment-1", sourceCommentId: "reply-1" }),
    );
    if (typeof matches === "string") throw new Error(`expected a match, got ${matches}`);
    assert.deepEqual(lookups, [["comment-1", "reply-1"]]);
    assert.equal(stops.length, 1);
    const supersedes = (triggerRunId: string) =>
      stops[0]!.matches({ outputContext: rootRun.outputContext, triggerRunId });
    assert.equal(supersedes(rootRun.id), true);
    assert.equal(supersedes(replyRun.id), true);
    assert.equal(supersedes(otherRun.id), false);

    // A mention in the root names the same comment twice; a session may also name only its source.
    for (const [comments, expected] of [
      [{ rootCommentId: "comment-1", sourceCommentId: "comment-1" }, ["comment-1"]],
      [{ sourceCommentId: "reply-1" }, ["reply-1"]],
    ] as const) {
      lookups.length = 0;
      await provider.match(session(comments));
      assert.deepEqual(lookups, [expected]);
    }
  });

  it("stops nothing when no comment run preceded the agent session", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      agentSessionConfiguration(),
      { organizationId: "hub-org" },
    );
    await database.createAcceptedTriggerRun(
      linearCommentRun(project.id, revision.id, "comment-2", "receipt-unrelated-comment-run"),
    );
    let stops = 0;
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient({ complete: true, comments: [] }),
      database: linearRunLookupDatabase(database),
      executions: {
        stopActive: async () => {
          stops += 1;
          return { stopped: 0 };
        },
      },
    });

    const created = agentSessionEvent({ action: "created" });
    for (const session of [
      { ...created, agentSession: { ...created.agentSession, rootCommentId: "comment-1" } },
      created,
      agentSessionEvent(),
    ]) {
      const matches = await provider.match(externalAgentSession(project.id, revision.id, session));
      if (typeof matches === "string") throw new Error(`expected a match, got ${matches}`);
    }
    assert.equal(stops, 0);
  });

  it("suppresses a delayed comment run after its Agent Session was accepted", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(
      database,
      linearCommentAndSessionConfiguration(),
      { organizationId: "hub-org" },
    );
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient({ complete: true, comments: [] }),
      database,
      executions: { stopActive: async () => ({ stopped: 0 }) },
    });
    const engine = new DurableWorkflowEngine({
      database,
      entitlements: null,
      providers: [provider],
    });
    const comment = await persistLinearEvent(
      database,
      project.id,
      "linear.comment",
      "delayed-comment",
      { ...event("2026-01-02T00:00:00.000Z"), occurredAt: undefined },
    );
    const created = agentSessionEvent({ action: "created" });
    const session = await persistLinearEvent(
      database,
      project.id,
      "linear.agent_session",
      "session-before-comment-handler",
      {
        ...created,
        agentSession: { ...created.agentSession, sourceCommentId: "trigger-comment" },
      },
    );

    await engine.enqueue(session);
    await engine.enqueue(comment);

    assert.equal(
      (await database.findTriggerRunsByProviderEventReceiptId(session.providerEventReceiptId))
        .length,
      1,
    );
    assert.deepEqual(
      await database.findTriggerRunsByProviderEventReceiptId(comment.providerEventReceiptId),
      [],
    );
  });

  it("keeps the comment fallback when the Agent Session invocation is rejected", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(
      database,
      rejectedAgentSessionAndCommentConfiguration(),
      { organizationId: "hub-org" },
    );
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient({ complete: true, comments: [] }),
      database,
      executions: { stopActive: async () => ({ stopped: 0 }) },
    });
    const engine = new DurableWorkflowEngine({
      database,
      entitlements: null,
      providers: [provider],
    });
    const comment = await persistLinearEvent(
      database,
      project.id,
      "linear.comment",
      "fallback-comment",
      event("2026-01-02T00:00:00.000Z"),
    );
    const created = agentSessionEvent({ action: "created" });
    const session = await persistLinearEvent(
      database,
      project.id,
      "linear.agent_session",
      "rejected-agent-session",
      {
        ...created,
        agentSession: { ...created.agentSession, sourceCommentId: "trigger-comment" },
      },
    );

    await engine.enqueue(session);
    await engine.enqueue(comment);

    const sessionRuns = await database.findTriggerRunsByProviderEventReceiptId(
      session.providerEventReceiptId,
    );
    assert.equal(sessionRuns.length, 1);
    assert.equal(sessionRuns[0]?.outcome, "rejected");
    const commentRuns = await database.findTriggerRunsByProviderEventReceiptId(
      comment.providerEventReceiptId,
    );
    assert.equal(commentRuns.length, 1);
    assert.equal(commentRuns[0]?.outcome, "accepted");
  });

  it("stops the session's executions instead of starting a run on Linear's stop signal", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const stops: Parameters<TriggerProviderExecutionControl["stopActive"]>[0][] = [];
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      executions: {
        stopActive: async (input) => {
          stops.push(input);
          return { stopped: 1 };
        },
      },
    });
    const stopEvent = agentSessionEvent({
      agentActivity: {
        id: "trigger-activity",
        type: "prompt",
        body: "Stop",
        createdAt: "2026-01-02T00:01:00.000Z",
        signal: "stop",
      },
      prompt: "Stop",
      parserMessage: "Stop",
    });

    const result = await provider.match(externalAgentSession(project.id, revision.id, stopEvent));

    assert.equal(result, "agent_session_stopped");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.projectId, project.id);
    assert.equal(stops[0]?.reason, "stopped_by_user");
    const matches = (outputContext: unknown) =>
      stops[0]!.matches({ outputContext, triggerRunId: null });
    assert.equal(
      matches({
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      }),
      true,
    );
    assert.equal(
      matches({
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-2",
      }),
      false,
    );
    assert.equal(matches({ provider: "slack", agentSessionId: "session-1" }), false);
    assert.equal(matches(null), false);
    assert.deepEqual(client.createdActivities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "response", body: "Stopped at your request." },
      },
    ]);
  });

  it("confirms a stop even when nothing is running so Linear can settle the session", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    let stops = 0;
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      executions: {
        stopActive: async () => {
          stops += 1;
          return { stopped: 0 };
        },
      },
    });

    const result = await provider.match(
      externalAgentSession(project.id, revision.id, stopSignalEvent()),
    );

    assert.equal(result, "agent_session_stopped");
    assert.equal(stops, 1);
    assert.equal(client.createdActivities.length, 1);
    assert.equal(client.createdActivities[0]?.content.type, "response");
  });

  it("does not start an older Agent Session delivery after its stop was acknowledged", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(
      database,
      agentSessionConfiguration(),
      { organizationId: "hub-org" },
    );
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      database,
      executions: { stopActive: async () => ({ stopped: 0 }) },
    });
    const engine = new DurableWorkflowEngine({
      database,
      entitlements: null,
      providers: [provider],
    });
    const prompted = agentSessionEvent({
      occurredAt: "2026-01-02T00:00:00.000Z",
      agentActivity: {
        id: "original-activity",
        type: "prompt",
        body: "Please investigate",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      prompt: "Please investigate",
      parserMessage: "Please investigate",
    });
    const original = await persistLinearEvent(
      database,
      project.id,
      "linear.agent_session",
      "delayed-agent-session",
      prompted,
    );
    const stop = await persistLinearEvent(
      database,
      project.id,
      "linear.agent_session",
      "stop-before-original-handler",
      stopSignalEvent(),
    );

    await engine.enqueue(stop);
    await engine.enqueue(original);

    assert.equal(client.createdActivities.length, 1);
    assert.equal(client.createdActivities[0]?.content.type, "response");
    assert.deepEqual(
      await database.findTriggerRunsByProviderEventReceiptId(original.providerEventReceiptId),
      [],
    );

    const laterPrompt = agentSessionEvent({
      occurredAt: "2026-01-02T00:02:00.000Z",
      agentActivity: {
        id: "later-activity",
        type: "prompt",
        body: "Please start again",
        createdAt: "2026-01-02T00:02:00.000Z",
      },
      prompt: "Please start again",
      parserMessage: "Please start again",
    });
    const later = await persistLinearEvent(
      database,
      project.id,
      "linear.agent_session",
      "prompt-after-stop",
      laterPrompt,
    );
    await engine.enqueue(later);
    assert.equal(
      (await database.findTriggerRunsByProviderEventReceiptId(later.providerEventReceiptId)).length,
      1,
    );
  });

  it("stops an active session after the current revision removes its session trigger", async () => {
    const { project, revision, store } = await activeConfiguration(linearCommentConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    let stops = 0;
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      executions: {
        stopActive: async () => {
          stops += 1;
          return { stopped: 1 };
        },
      },
    });

    const result = await provider.match(
      externalAgentSession(project.id, revision.id, stopSignalEvent()),
    );

    assert.equal(result, "agent_session_stopped");
    assert.equal(stops, 1);
    assert.equal(client.createdActivities.length, 1);
  });

  it("posts one stop confirmation when a receipt routes to multiple projects", async () => {
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const receipt = linearStopReceipt(["project-first", "project-second"]);
    const stoppedProjects: string[] = [];
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("stop handling must not read the current trigger revision");
      },
      client,
      database: {
        findProviderEventReceiptById: async (id) => (id === receipt.id ? receipt : undefined),
        listTriggerRunsForLinearComments: async () => [],
      },
      executions: {
        stopActive: async (input) => {
          stoppedProjects.push(input.projectId);
          return { stopped: 1 };
        },
      },
    });

    const results = await Promise.all(
      receipt.acceptedRoutes!.map((route) =>
        provider.match(
          externalAgentSession(route.projectId, route.configurationRevisionId, stopSignalEvent()),
        ),
      ),
    );

    assert.deepEqual(results, ["agent_session_stopped", "agent_session_stopped"]);
    assert.deepEqual(stoppedProjects.sort(), ["project-first", "project-second"]);
    assert.equal(client.createdActivities.length, 1);
  });

  it("does not confirm a stop it could not apply", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
      executions: {
        stopActive: () => Promise.reject(new Error("execution control unavailable")),
      },
    });

    await assert.rejects(
      provider.match(externalAgentSession(project.id, revision.id, stopSignalEvent())),
      /execution control unavailable/,
    );
    // No "Stopped" response: the work may still be running and Linear must not be told otherwise.
    assert.deepEqual(client.createdActivities, []);
  });

  it("does not post an error for an execution the user stopped", async () => {
    const { project, revision, store } = await activeConfiguration(agentSessionConfiguration());
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (
      await provider.match(externalAgentSession(project.id, revision.id, agentSessionEvent()))
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const acceptedState = await provider.onDispatchAccepted?.(
      match.triggerContext,
      match.outputContext,
    );

    const failedState = await provider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "stopped_by_user",
      acceptedState ?? undefined,
    );

    assert.deepEqual(failedState, { phase: "failed" });
    assert.deepEqual(
      client.createdActivities.map((activity) => activity.content.type),
      ["thought"],
    );
    // The reaction is settled: a later failure signal for the same run stays silent too.
    await provider.onMachineTerminated?.(
      match.triggerContext,
      "daemon disconnected",
      failedState ?? undefined,
    );
    assert.equal(client.createdActivities.length, 1);
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
  "readIssueComments" | "readAgentSessionActivities" | "readCommentThread" | "createAgentActivity"
> {
  historyReads: Array<{
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }> = [];
  threadReads: Array<{ linearOrganizationId: string; commentId: string }> = [];
  thread: LinearCommentThread | undefined = undefined;
  threadError: Error | undefined = undefined;
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

  readCommentThread(
    input: (typeof this.threadReads)[number],
  ): Promise<LinearCommentThread | undefined> {
    this.threadReads.push(input);
    if (this.threadError !== undefined) return Promise.reject(this.threadError);
    return Promise.resolve(this.thread);
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

function threadWithAppConfiguration() {
  const configuration = linearCommentConfiguration();
  const trigger = configuration.triggers[0]!;
  return {
    ...configuration,
    triggers: [
      {
        ...trigger,
        name: "in-app-thread",
        filters: { ...trigger.filters, thread_with_app: true },
      },
      { ...trigger, name: "plain" },
    ],
  };
}

async function matchedTriggerNames(
  provider: ReturnType<typeof createLinearTriggerProvider>,
  trigger: ExternalTrigger,
): Promise<string[]> {
  const matches = await provider.match(trigger);
  if (typeof matches === "string") throw new Error(`expected a match, got ${matches}`);
  return matches.map((match) => match.triggerName);
}

/** An accepted run as the comment trigger records it, keyed by the comment it started from. */
function linearCommentRun(
  projectId: string,
  configurationRevisionId: string,
  commentId: string,
  providerEventReceiptId: string,
) {
  return {
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    providerEventReceiptId,
    configuredTriggerName: "comment",
    prompt: "@paseo please draft a fix",
    inputs: {},
    triggerContext: {
      provider: "linear",
      event: {
        linear: { comment: { id: commentId, body: "@paseo please draft a fix", parent_id: null } },
      },
    },
    outputContext: {
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      agentSessionId: null,
    },
    deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
    stepIds: ["work"],
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

function linearCommentAndSessionConfiguration() {
  const comment = linearCommentConfiguration();
  const session = agentSessionConfiguration();
  return { ...comment, triggers: [comment.triggers[0]!, session.triggers[0]!] };
}

function rejectedAgentSessionAndCommentConfiguration() {
  const configuration = linearCommentAndSessionConfiguration();
  const session = configuration.triggers[1]!;
  return {
    ...configuration,
    triggers: [
      configuration.triggers[0]!,
      {
        ...session,
        inputs: {
          priority: { type: "string", required: true, choices: ["high", "low"] },
        },
      },
    ],
  };
}

function linearRunLookupDatabase(
  database: Database,
): Pick<Database, "findProviderEventReceiptById" | "listTriggerRunsForLinearComments"> {
  return {
    findProviderEventReceiptById: (id) => database.findProviderEventReceiptById(id),
    listTriggerRunsForLinearComments: (projectId, commentIds) =>
      database.listTriggerRunsForLinearComments(projectId, commentIds),
  };
}

async function persistLinearEvent(
  database: Database,
  projectId: string,
  source: "linear.comment" | "linear.agent_session",
  deliveryId: string,
  payload: NormalizedLinearCommentEvent | NormalizedLinearAgentSessionEvent,
) {
  const persisted = await database.persistManualEvent({
    organizationId: "hub-org",
    projectId,
    source,
    deliveryId,
    payload,
    receivedAt: new Date(payload.occurredAt ?? "2026-01-02T00:00:00.000Z"),
  });
  if (persisted.status !== "accepted") throw new Error("expected accepted Linear test event");
  return persisted.event;
}

/** Accepts a freshly created native agent session so completion hooks can be exercised. */
async function acceptedAgentSession() {
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
  const acceptedState = await provider.onDispatchAccepted?.(
    match.triggerContext,
    match.outputContext,
  );
  return { match, acceptedState, provider, client };
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
    comment: {
      id: "trigger-comment",
      issueId: "issue-1",
      body: commentBody,
      parentId: "root-comment",
    },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      teamId: "team-1",
      stateId: "ready",
      assigneeId: null,
      labelIds: [],
    },
    occurredAt,
  };
}

function stopSignalEvent(): NormalizedLinearAgentSessionEvent {
  return agentSessionEvent({
    agentActivity: {
      id: "trigger-activity",
      type: "prompt",
      body: "Stop",
      createdAt: "2026-01-02T00:01:00.000Z",
      signal: "stop",
    },
  });
}

function linearStopReceipt(projectIds: readonly string[]): ProviderEventReceiptRecord {
  return {
    id: "11111111-1111-4111-8111-111111111122",
    organizationId: "hub-org",
    provider: "linear",
    connectionId: "linear-connection",
    resourceId: "project-1",
    deliveryId: "delivery-agent-session-1",
    signatureHash: null,
    providerApplicationId: null,
    providerConfigurationVersion: null,
    source: "linear.agent_session",
    repo: null,
    payload: stopSignalEvent(),
    receivedAt: new Date("2026-01-02T00:01:00.000Z"),
    droppedReason: null,
    acceptedRoutes: projectIds.map((projectId, index) => ({
      projectId,
      configurationRevisionId: `revision-${index + 1}`,
      connectionId: "linear-connection",
      resourceId: "project-1",
    })),
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
      teamId: "team-1",
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
