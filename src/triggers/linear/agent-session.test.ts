import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearAgentActivityContent } from "../../providers/linear/client.js";
import {
  createLinearAgentSessionHooks,
  LinearAgentSessionTracker,
  agentSessionOutputContext,
} from "./agent-session.js";
import {
  conversationKeyFromOutputContext,
  isLinearAgentSessionPrompted,
  linearAgentSessionConversationKey,
  linearAgentSessionFollowUpPrompt,
} from "./conversation.js";
import { normalizeLinearEvent } from "./events.js";
import { matchLinearTriggers } from "./match.js";

describe("Linear agent session events", () => {
  it("normalizes a created session into the mention text and its session identity", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");

    assert.equal(event?.type, "agent_session");
    if (event?.type !== "agent_session") return;
    assert.equal(event.action, "created");
    assert.equal(event.agentSession.id, "session-1");
    assert.equal(event.agentSession.commentId, "comment-1");
    assert.equal(event.prompt, "@Paseo agent=fast fix the failing build");
    assert.equal(event.promptContext, "Issue LEX-1\n\nThe build fails on main.");
    assert.deepEqual(event.actor, { id: "user-1", name: "Vince" });
    assert.equal(event.issue?.id, "issue-1");
    assert.equal(event.issue?.projectId, "project-1");
  });

  it("reads a follow-up prompt from the agent activity rather than the original comment", () => {
    const event = normalizeLinearEvent(
      {
        ...createdPayload(),
        action: "prompted",
        agentActivity: { content: { type: "prompt", body: "also update the changelog" } },
      },
      "AgentSessionEvent",
    );

    assert.equal(event?.type, "agent_session");
    if (event?.type !== "agent_session") return;
    assert.equal(event.action, "prompted");
    assert.equal(event.prompt, "also update the changelog");
  });

  it("ignores a session delivery that carries no session", () => {
    assert.equal(
      normalizeLinearEvent({ action: "created", organizationId: "org" }, "AgentSessionEvent"),
      undefined,
    );
  });

  it("runs an unfiltered session trigger without an actor allowlist", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    const matched = matchLinearTriggers(
      { triggers: [{ name: "mention", on: "linear.agent_session" }] },
      event,
    );

    assert.deepEqual(
      matched.map((match) => match.trigger.name),
      ["mention"],
    );
  });

  it("still honors project and text filters on a session trigger", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    const triggers = (filters: Record<string, unknown>) => [
      { name: "mention", on: "linear.agent_session", filters },
    ];

    assert.equal(
      matchLinearTriggers({ triggers: triggers({ project: "project-1" }) }, event).length,
      1,
    );
    assert.equal(
      matchLinearTriggers({ triggers: triggers({ project: "other" }) }, event).length,
      0,
    );
    assert.equal(
      matchLinearTriggers({ triggers: triggers({ contains: "build" }) }, event).length,
      1,
    );
    assert.equal(
      matchLinearTriggers({ triggers: triggers({ contains: "deploy" }) }, event).length,
      0,
    );
  });

  it("keeps a connection-scoped session trigger matching alongside issue filters", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    const config = {
      triggers: [
        {
          name: "mention",
          on: "linear.agent_session",
          filters: { connectionId: "connection-1", project: "project-1" },
        },
      ],
    };

    assert.equal(matchLinearTriggers(config, event, "connection-1").length, 1);
    assert.equal(matchLinearTriggers(config, event, "connection-2").length, 0);
  });

  it("does not route a session delivery to a comment trigger", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    assert.equal(
      matchLinearTriggers({ triggers: [{ name: "comment", on: "linear.comment_created" }] }, event)
        .length,
      0,
    );
  });
});

describe("Linear agent session activities", () => {
  it("acknowledges the session immediately so Linear does not mark it unresponsive", async () => {
    const { hooks, activities, externalUrls } = harness();

    await hooks.onDispatchAccepted(context());

    assert.equal(activities[0]?.content.type, "thought");
    assert.deepEqual(externalUrls, [[{ label: "Paseo Hub", url: "https://hub.example" }]]);
  });

  it("leaves the closing word to the agent when it already replied", async () => {
    const { hooks, activities, tracker } = harness();
    tracker.markResponded("session-1");

    await hooks.onAgentExecutionCompleted(context(), { status: "succeeded" });

    assert.deepEqual(activities, []);
  });

  it("closes a silent session so it does not hang in a working state", async () => {
    const { hooks, activities } = harness();

    await hooks.onAgentExecutionCompleted(context(), { status: "succeeded" });

    assert.equal(activities[0]?.content.type, "response");
  });

  it("reports a failed run as an error activity", async () => {
    const { hooks, activities } = harness();

    await hooks.onAgentExecutionFailed(context(), "daemon_unreachable");

    assert.deepEqual(activities[0]?.content, { type: "error", body: "daemon_unreachable" });
  });

  it("ignores output contexts that are not agent sessions", async () => {
    const { hooks, activities } = harness();

    await hooks.onDispatchAccepted({
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
    });

    assert.deepEqual(activities, []);
  });

  it("keeps a run alive when Linear rejects an activity", async () => {
    const tracker = new LinearAgentSessionTracker();
    const hooks = createLinearAgentSessionHooks({
      tracker,
      publicBaseUrl: "https://hub.example",
      client: {
        createAgentActivity: async () => {
          throw new Error("Linear is down");
        },
        updateAgentSession: async () => {},
      },
    });

    await hooks.onAgentExecutionStarted(context());
  });
});

describe("agentSessionOutputContext", () => {
  it("carries the session identity and tolerates a session with no issue", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    if (event.type !== "agent_session") return;

    assert.deepEqual(agentSessionOutputContext(event), {
      provider: "linear",
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      agentSessionId: "session-1",
    });
    assert.equal(agentSessionOutputContext({ ...event, issue: null }).issueId, null);
  });
});

describe("linear agent session continuation", () => {
  it("keys a live conversation by agent session id", () => {
    assert.equal(
      conversationKeyFromOutputContext(context()),
      linearAgentSessionConversationKey("session-1"),
    );
    assert.equal(conversationKeyFromOutputContext({ provider: "github" }), undefined);
  });

  it("treats only prompted session events as follow-ups", () => {
    const event = normalizeLinearEvent(createdPayload(), "AgentSessionEvent");
    assert.ok(event);
    if (event.type !== "agent_session") return;
    const created = {
      provider: "linear",
      target: context(),
      event: { linear: { event_type: "agent_session", action: event.action } },
    };
    const prompted = {
      ...created,
      event: { linear: { event_type: "agent_session", action: "prompted" } },
    };
    assert.equal(isLinearAgentSessionPrompted(created), false);
    assert.equal(isLinearAgentSessionPrompted(prompted), true);
  });

  it("wraps the follow-up mention as a continuation prompt", () => {
    const prompt = linearAgentSessionFollowUpPrompt({
      triggerName: "linear-mention",
      hubConfig: {},
      triggerContext: {
        provider: "linear",
        event: { linear: { prompt_context: "Issue LEX-1" } },
      },
      outputContext: context(),
      invocation: {
        status: "accepted",
        prompt: "also update the changelog",
        inputs: {},
      },
    });
    assert.match(prompt, /Follow-up in the same Linear agent session/u);
    assert.match(prompt, /also update the changelog/u);
    assert.match(prompt, /Issue LEX-1/u);
    assert.match(prompt, /Do not call hub.finish_execution/u);
  });
});

function harness() {
  const activities: { agentSessionId: string; content: LinearAgentActivityContent }[] = [];
  const externalUrls: { label: string; url: string }[][] = [];
  const tracker = new LinearAgentSessionTracker();
  const hooks = createLinearAgentSessionHooks({
    tracker,
    publicBaseUrl: "https://hub.example",
    client: {
      createAgentActivity: async (input) => {
        activities.push({ agentSessionId: input.agentSessionId, content: input.content });
      },
      updateAgentSession: async (input) => {
        externalUrls.push([...input.externalUrls]);
      },
    },
  });
  return { hooks, activities, externalUrls, tracker };
}

function context() {
  return {
    provider: "linear" as const,
    linearOrganizationId: "linear-org",
    issueId: "issue-1",
    agentSessionId: "session-1",
  };
}

function createdPayload() {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "linear-org",
    createdAt: "2026-09-06T12:00:00.000Z",
    webhookTimestamp: Date.parse("2026-09-06T12:00:00.000Z"),
    promptContext: "Issue LEX-1\n\nThe build fails on main.",
    agentSession: {
      id: "session-1",
      status: "pending",
      creator: { id: "user-1", name: "Vince" },
      comment: { id: "comment-1", body: "@Paseo agent=fast fix the failing build" },
      issue: {
        id: "issue-1",
        identifier: "LEX-1",
        title: "Build fails on main",
        description: "It broke after the last merge.",
        projectId: "project-1",
        stateId: "todo",
        assigneeId: null,
        labelIds: [],
      },
    },
  };
}
