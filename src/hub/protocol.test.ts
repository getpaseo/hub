import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HubExecutionAgentCreateRequestSchema } from "./protocol.js";

describe("Hub execution create protocol", () => {
  it("accepts only structured refs for the injected Hub MCP server", () => {
    const request = {
      type: "hub.execution.agent.create.request",
      requestId: "request-1",
      executionId: "execution-1",
      provider: "codex",
      cwd: "/repo",
      prompt: "run",
      providerOptions: { sandbox_mode: "read-only" },
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
      },
    };

    assert.equal(HubExecutionAgentCreateRequestSchema.safeParse(request).success, true);
    assert.equal(
      HubExecutionAgentCreateRequestSchema.safeParse({
        ...request,
        workspaceAffinity: {
          key: "slack:thread:1700000000.000001",
          retainUntil: "2026-08-06T12:02:00.000Z",
          autoArchive: true,
        },
      }).success,
      true,
    );
    assert.equal(
      HubExecutionAgentCreateRequestSchema.safeParse({
        ...request,
        toolPolicy: { preapproved: [{ kind: "native", tool: "Bash" }] },
      }).success,
      false,
    );
    assert.equal(
      HubExecutionAgentCreateRequestSchema.safeParse({
        ...request,
        toolPolicy: {
          preapproved: [{ kind: "mcp", server: "unrelated", tool: "finish_execution" }],
        },
      }).success,
      false,
    );
  });
});
