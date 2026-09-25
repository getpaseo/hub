import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { createForgejoTriggerProvider } from "./provider.js";
import type { ForgejoReactionClient } from "./provider.js";
import type { NormalizedForgejoEvent } from "./events.js";

describe("Forgejo trigger provider conversation identity", () => {
  it("keys the issue conversation on repositoryId, not the renameable repo name", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const first = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    const next = (
      await provider.match(
        external(
          project.id,
          revision.id,
          createEvent({ body: "another @paseo request", commentId: 456 }),
        ),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(first) || !isAcceptedTriggerProviderMatch(next)) {
      throw new Error("expected accepted matches");
    }
    assert.equal(first.conversation?.key, JSON.stringify(["forgejo", "connection-1", 9001, 42]));
    assert.equal(next.conversation?.key, first.conversation?.key);
  });

  // A push has no issue or pull request to thread replies onto, matching what the
  // GitHub provider does for the same shape of event.
  it("returns no conversation for an item-less event", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const match = (await provider.match(external(project.id, revision.id, createPushEvent())))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected an accepted match");
    assert.equal(match.conversation, null);
  });
});

describe("Forgejo trigger provider reaction lifecycle", () => {
  it("derives a comment reaction target for an issue_comment event", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(external(project.id, revision.id, createEvent()));
    if (typeof matches === "string") throw new Error("expected an issue_comment match");

    assert.deepEqual(matches[0]?.triggerContext.reactionSubject, {
      kind: "issue_comment",
      commentId: 123,
    });
  });

  it.each([
    ["issues", 42],
    ["pull_request", 43],
  ] as const)("derives an item reaction target for a %s event", async (type, number) => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, createItemEvent(type, number)),
    );
    if (typeof matches === "string") throw new Error(`expected a ${type} match`);

    assert.deepEqual(matches[0]?.triggerContext.reactionSubject, {
      kind: "item",
      issueNumber: number,
    });
  });

  it("derives an item reaction target for a push event's item-less trigger as null", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(external(project.id, revision.id, createPushEvent()));
    if (typeof matches === "string") throw new Error("expected a push match");

    assert.equal(matches[0]?.triggerContext.reactionSubject, null);
  });

  it("reacts with eyes on dispatch and never calls the reaction client for a push event", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestForgejoReactions();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions,
    });

    const matches = await provider.match(external(project.id, revision.id, createPushEvent()));
    if (typeof matches === "string") throw new Error("expected a push match");
    const match = matches[0]!;

    const reactionState = await provider.onDispatchAccepted?.(
      match.triggerContext,
      match.outputContext,
    );

    assert.equal(reactionState, null);
    assert.equal(reactions.created.length, 0);
  });

  it.each([
    ["completed", "+1"],
    ["failed", "-1"],
  ] as const)(
    "replaces the eyes acceptance reaction with %s on the terminal reaction",
    async (terminal, content) => {
      const { project, revision, store } = await activeConfiguration();
      const reactions = new TestForgejoReactions();
      const provider = createForgejoTriggerProvider({
        configurationStoreForProject: () => store,
        reactions,
      });

      const matches = await provider.match(external(project.id, revision.id, createEvent()));
      if (typeof matches === "string") throw new Error("expected an issue_comment match");
      const match = matches[0]!;

      const reactionState =
        (await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext)) ?? null;

      if (terminal === "completed") {
        await provider.onAgentExecutionCompleted?.(
          match.triggerContext,
          match.outputContext,
          { status: "succeeded" },
          reactionState,
        );
      } else {
        await provider.onAgentExecutionFailed?.(
          match.triggerContext,
          match.outputContext,
          "boom",
          reactionState,
        );
      }

      assert.deepEqual(
        reactions.created.map((call) => call.content),
        ["eyes", content],
      );
      assert.deepEqual(reactions.deleted, [
        {
          connectionId: "connection-1",
          repo: "acme/widgets",
          subject: { kind: "issue_comment", commentId: 123 },
          content: "eyes",
        },
      ]);
    },
  );

  it("swallows a reaction cleanup failure instead of failing the run", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestForgejoReactions();
    reactions.failNextDelete = true;
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions,
    });

    const matches = await provider.match(external(project.id, revision.id, createEvent()));
    if (typeof matches === "string") throw new Error("expected an issue_comment match");
    const match = matches[0]!;
    const reactionState =
      (await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext)) ?? null;

    const finalState = await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded" },
      reactionState,
    );

    assert.deepEqual(finalState, { content: "+1" });
    assert.deepEqual(
      reactions.created.map((call) => call.content),
      ["eyes", "+1"],
    );
  });
});

describe("Forgejo trigger provider agent context", () => {
  it("includes the push ref and head commit for a push event", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(external(project.id, revision.id, createPushEvent()));
    if (typeof matches === "string") throw new Error("expected a push match");

    assert.deepEqual(matches[0]?.triggerContext.event.forgejo.push, {
      ref: "refs/heads/main",
      head_commit: { id: "c0ffee0000000000000000000000000000000001", message: "direct push" },
    });
  });

  it("includes the added labels and assignees for a label/assign delivery", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, createLabelAddedEvent()),
    );
    if (typeof matches === "string") throw new Error("expected an issues match");

    assert.deepEqual(matches[0]?.triggerContext.event.forgejo.added_labels, ["bug"]);
    assert.deepEqual(matches[0]?.triggerContext.event.forgejo.added_assignees, ["zaphod"]);
  });

  it("includes the review verdict and content for an approved review", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, createReviewEvent("approved")),
    );
    if (typeof matches === "string") throw new Error("expected a review match");

    assert.deepEqual(matches[0]?.triggerContext.event.forgejo.review, {
      verdict: "approved",
      content: "ship it",
    });
  });

  it("includes the requested reviewer's login for a review request", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, createReviewRequestedEvent()),
    );
    if (typeof matches === "string") throw new Error("expected a pull_request match");

    assert.equal(matches[0]?.triggerContext.event.forgejo.requested_reviewer, "trillian");
  });

  it("omits every optional context field for a plain comment", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestForgejoReactions(),
    });

    const matches = await provider.match(external(project.id, revision.id, createEvent()));
    if (typeof matches === "string") throw new Error("expected an issue_comment match");

    const forgejo = matches[0]?.triggerContext.event.forgejo;
    assert.equal(forgejo?.added_labels, undefined);
    assert.equal(forgejo?.added_assignees, undefined);
    assert.equal(forgejo?.review, undefined);
    assert.equal(forgejo?.requested_reviewer, undefined);
    assert.equal(forgejo?.push, undefined);
  });
});

async function activeConfiguration() {
  return createActiveProjectConfiguration(createMemoryDatabase(), forgejoConfiguration());
}

function forgejoConfiguration() {
  return {
    environments: [{ name: "forgejo-runner", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
    triggers: [
      {
        name: "forgejo-mention",
        on: "forgejo.issue_comment",
        max_runtime: "2h",
        filters: { from_users: ["zaphod"] },
        steps: [
          {
            id: "forgejo-step",
            environment: "forgejo-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the Forgejo issue comment." }],
            allow_outputs: [{ type: "forgejo.reply" }],
            auto_archive: true,
          },
        ],
      },
      {
        name: "forgejo-push",
        on: "forgejo.push",
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "forgejo-push-step",
            environment: "forgejo-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the push." }],
            auto_archive: true,
          },
        ],
      },
      {
        name: "forgejo-issues",
        on: "forgejo.issues",
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "forgejo-issues-step",
            environment: "forgejo-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the issue." }],
            auto_archive: true,
          },
        ],
      },
      {
        name: "forgejo-pull-request",
        on: "forgejo.pull_request",
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "forgejo-pull-request-step",
            environment: "forgejo-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the pull request." }],
            auto_archive: true,
          },
        ],
      },
      {
        name: "forgejo-pull-request-review",
        on: "forgejo.pull_request_review",
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "forgejo-pull-request-review-step",
            environment: "forgejo-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the review." }],
            auto_archive: true,
          },
        ],
      },
    ],
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  payload: NormalizedForgejoEvent,
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org_1",
    projectId,
    configurationRevisionId,
    source: `forgejo.${payload.type}`,
    deliveryId: payload.id,
    receivedAt: new Date(),
    payload,
    connectionId: payload.connectionId,
  };
}

function createEvent(
  overrides: { body?: string; commentId?: number } = {},
): NormalizedForgejoEvent {
  return {
    id: `forgejo-delivery-${overrides.commentId ?? 123}`,
    type: "issue_comment",
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload: {
      action: "created",
      issue: {
        number: 42,
        title: "Improbability drive stalls",
        body: "on cold mornings",
        html_url: "https://git.example.test/acme/widgets/issues/42",
        user: { login: "trillian" },
      },
      comment: {
        id: overrides.commentId ?? 123,
        body: overrides.body ?? "@paseo have a look",
        html_url: "https://git.example.test/acme/widgets/issues/42#issuecomment-123",
        user: { login: "zaphod" },
      },
      sender: { login: "zaphod" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

function createItemEvent(type: "issues" | "pull_request", number: number): NormalizedForgejoEvent {
  return {
    id: `forgejo-${type}-${number}`,
    type,
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload:
      type === "issues"
        ? {
            action: "opened",
            issue: { number, title: "smoke", body: "issue body", user: { login: "zaphod" } },
            sender: { login: "zaphod" },
          }
        : {
            action: "opened",
            pull_request: {
              number,
              title: "smoke",
              body: "pull request body",
              user: { login: "zaphod" },
            },
            sender: { login: "zaphod" },
          },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

function createPushEvent(): NormalizedForgejoEvent {
  return {
    id: "forgejo-push-1",
    type: "push",
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload: {
      ref: "refs/heads/main",
      head_commit: { id: "c0ffee0000000000000000000000000000000001", message: "direct push" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

function createLabelAddedEvent(): NormalizedForgejoEvent {
  return {
    id: "forgejo-label-added-1",
    type: "issues",
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload: {
      action: "label_updated",
      issue: { number: 42, title: "smoke", body: "", user: { login: "zaphod" } },
      sender: { login: "zaphod" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
    addedLabels: ["bug"],
    addedAssignees: ["zaphod"],
  };
}

function createReviewEvent(verdict: "approved" | "rejected"): NormalizedForgejoEvent {
  return {
    id: "forgejo-review-1",
    type: "pull_request_review",
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload: {
      action: "reviewed",
      review: {
        type: `pull_request_review_${verdict}`,
        content: verdict === "approved" ? "ship it" : "needs work",
      },
      pull_request: { number: 2, title: "Add the widget", body: "", user: { login: "zaphod" } },
      sender: { login: "trillian" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

function createReviewRequestedEvent(): NormalizedForgejoEvent {
  return {
    id: "forgejo-review-requested-1",
    type: "pull_request",
    repo: "acme/widgets",
    repositoryId: 9001,
    connectionId: "connection-1",
    payload: {
      action: "review_requested",
      pull_request: { number: 2, title: "Add the widget", body: "", user: { login: "zaphod" } },
      requested_reviewer: { login: "trillian" },
      sender: { login: "zaphod" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

class TestForgejoReactions implements ForgejoReactionClient {
  failNextDelete = false;
  readonly created: Array<Parameters<ForgejoReactionClient["createReaction"]>[0]> = [];
  readonly deleted: Array<Parameters<ForgejoReactionClient["deleteReaction"]>[0]> = [];

  async createReaction(input: Parameters<ForgejoReactionClient["createReaction"]>[0]) {
    this.created.push(input);
  }

  async deleteReaction(input: Parameters<ForgejoReactionClient["deleteReaction"]>[0]) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("instance refused the delete");
    }
    this.deleted.push(input);
  }
}
