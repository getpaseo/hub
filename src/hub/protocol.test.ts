import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  GetProvidersSnapshotResponseSchema,
  HubExecutionAgentCreateRequestSchema,
} from "./protocol.js";

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
    const affinityRequest = HubExecutionAgentCreateRequestSchema.safeParse({
      ...request,
      workspaceAffinity: {
        key: " slack:thread:1700000000.000001 ",
        retainUntil: "2026-08-06T12:02:00.000Z",
        autoArchive: true,
      },
    });
    assert.equal(affinityRequest.success, true);
    assert.equal(
      affinityRequest.success ? affinityRequest.data.workspaceAffinity?.key : undefined,
      " slack:thread:1700000000.000001 ",
    );
    assert.equal(
      HubExecutionAgentCreateRequestSchema.safeParse({
        ...request,
        workspaceAffinity: {
          key: "   ",
          retainUntil: "2026-08-06T12:02:00.000Z",
          autoArchive: true,
        },
      }).success,
      false,
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

describe("Hub provider snapshot protocol", () => {
  it("keeps model thinking options and provider modes", () => {
    const result = GetProvidersSnapshotResponseSchema.parse({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: "providers-1",
        entries: [
          {
            provider: "codex",
            status: "ready",
            models: [
              {
                provider: "codex",
                id: "gpt-5.4",
                label: "GPT-5.4",
                thinkingOptions: [{ id: "xhigh", label: "Extra high", isDefault: true }],
              },
            ],
            modes: [{ id: "full-access", label: "Full access" }],
          },
        ],
        generatedAt: "2026-09-02T12:00:00.000Z",
      },
    });

    assert.equal(result.payload.entries[0]?.models?.[0]?.thinkingOptions?.[0]?.id, "xhigh");
    assert.equal(result.payload.entries[0]?.modes?.[0]?.id, "full-access");
  });
});
