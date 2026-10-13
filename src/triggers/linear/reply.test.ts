import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { compileJsonSchema } from "../../workflows/json-schema.js";
import { createLinearReplyExecutor, linearReplyOutputTool } from "./reply.js";

describe("Linear reply output", () => {
  it("posts the workflow outcome onto its triggering issue", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Draft PR: https://github.com/acme/repo/pull/42" },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: null,
      },
    });
    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Draft PR: https://github.com/acme/repo/pull/42",
      },
    ]);
  });

  it("threads an issue comment under the root of the triggering comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: {
        ...sessionContext(),
        agentSessionId: null,
        threadRootCommentId: "root-comment",
      },
    });

    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Done.",
        parentId: "root-comment",
      },
    ]);
  });

  it("posts a top-level comment when the trigger was not a comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: { ...sessionContext(), agentSessionId: null, threadRootCommentId: null },
    });

    assert.deepEqual(client.comments, [
      { linearOrganizationId: "linear-org", issueId: "issue-1", body: "Done." },
    ]);
    assert.equal("parentId" in (client.comments[0] ?? {}), false);
  });

  it("posts a top-level comment for a context recorded before threading existed", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: { ...sessionContext(), agentSessionId: null },
    });

    assert.deepEqual(client.comments, [
      { linearOrganizationId: "linear-org", issueId: "issue-1", body: "Done." },
    ]);
    assert.equal("parentId" in (client.comments[0] ?? {}), false);
  });

  it("responds through a native Linear agent session", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Draft PR: https://github.com/acme/repo/pull/42" },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "response",
          body: "Draft PR: https://github.com/acme/repo/pull/42",
        },
      },
    ]);
    assert.deepEqual(client.comments, []);
  });

  it("asks a question as an elicitation so the session awaits input", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch should the fix target?", kind: "question" },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "elicitation", body: "Which branch should the fix target?" },
      },
    ]);
  });

  it("offers fixed choices through a select signal", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "release/1.2"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "elicitation", body: "Which branch?" },
        signal: "select",
        signalMetadata: {
          options: [
            { label: "main", value: "main" },
            { label: "release/1.2", value: "release/1.2" },
          ],
        },
      },
    ]);
  });

  it("ignores options on a final response", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done.", kind: "response", options: ["main"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "response", body: "Done." },
      },
    ]);
  });

  it("lists the choices of a question in an issue comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "release/1.2"] },
      outputContext: { ...sessionContext(), agentSessionId: null },
    });

    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Which branch?\n\n- main\n- release/1.2",
      },
    ]);
    assert.deepEqual(client.activities, []);
  });

  it("rejects an unknown kind", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content: "Done", kind: "thought" },
        outputContext: sessionContext(),
      }),
    );
    assert.deepEqual(client.activities, []);
  });

  it("exposes kind and options on the reply tool schema", () => {
    assert.equal(linearReplyOutputTool.name, "reply");
    assert.deepEqual(Object.keys(linearReplyOutputTool.inputSchema.properties ?? {}), [
      "content",
      "kind",
      "options",
    ]);
    assert.deepEqual(linearReplyOutputTool.inputSchema.required, ["content"]);
  });

  it("validates reply arguments against the tool schema", () => {
    const { validate } = compileJsonSchema(linearReplyOutputTool.inputSchema);
    assert.equal(linearReplyOutputTool.inputSchema["additionalProperties"], false);
    assert.equal(validate({ content: "Which branch?", kind: "question", options: ["a"] }), true);
    assert.equal(validate({ content: "Done", kind: "thought" }), false);
    assert.equal(validate({ content: "Which branch?", options: [] }), false);
    assert.equal(validate({ content: "Done", extra: 1 }), false);
  });

  it("drops duplicated choices before offering them", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "main", "dev"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities[0]?.signalMetadata, {
      options: [
        { label: "main", value: "main" },
        { label: "dev", value: "dev" },
      ],
    });
  });

  it("fails closed for an output context from another provider", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content: "Done" },
        outputContext: { provider: "slack", issueId: "issue-1" },
      }),
    );
    assert.deepEqual(client.comments, []);
  });
});

function sessionContext() {
  return {
    provider: "linear",
    linearOrganizationId: "linear-org",
    issueId: "issue-1",
    agentSessionId: "session-1",
  };
}

class RecordingLinearClient implements LinearApiClient {
  comments: Array<{
    linearOrganizationId: string;
    issueId: string;
    body: string;
    parentId?: string;
  }> = [];
  activities: Parameters<LinearApiClient["createAgentActivity"]>[0][] = [];

  async readIssue(): Promise<undefined> {
    return undefined;
  }

  async readIssueComments() {
    return { comments: [], complete: true };
  }

  async readAgentSessionActivities() {
    return { activities: [], complete: true };
  }

  async readCommentThread(): Promise<undefined> {
    return undefined;
  }

  async createComment(input: (typeof this.comments)[number]): Promise<void> {
    this.comments.push(input);
  }

  async createAgentActivity(
    input: Parameters<LinearApiClient["createAgentActivity"]>[0],
  ): Promise<void> {
    this.activities.push(input);
  }
}
