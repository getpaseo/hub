import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { GetProvidersSnapshotResponseSchema, isHubFinishExecutionToolName } from "./protocol.js";

describe("isHubFinishExecutionToolName", () => {
  it("accepts all known Hub finish-execution tool name forms", () => {
    assert.equal(isHubFinishExecutionToolName("hub.finish_execution"), true);
    assert.equal(isHubFinishExecutionToolName("mcp__hub__finish_execution"), true);
    assert.equal(isHubFinishExecutionToolName("hub_finish_execution"), true);
  });

  it("rejects unrelated or partially matching tool names", () => {
    assert.equal(isHubFinishExecutionToolName("hub_finish_execution_extra"), false);
    assert.equal(isHubFinishExecutionToolName("finish_execution"), false);
    assert.equal(isHubFinishExecutionToolName("hub.finish_execution "), false);
    assert.equal(isHubFinishExecutionToolName("mcp__other__finish_execution"), false);
    assert.equal(isHubFinishExecutionToolName(""), false);
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
