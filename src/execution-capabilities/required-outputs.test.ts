import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { completesAtIdleDeadline } from "../db/idle-completion.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { AgentExecutionOutputAttempt } from "../db/types.js";
import {
  describeRequiredOutputDeliveryFailures,
  failedRequiredOutputDeliveries,
  missingRequiredOutputs,
} from "./required-outputs.js";

const REQUIRED_REPLY = { allowOutputs: [{ type: "linear.reply", required: true }] };
const STARTED_AT = new Date("2026-08-05T12:00:00.000Z");

describe("required output delivery", () => {
  it("counts only a succeeded attempt as delivery", async () => {
    const database = createMemoryDatabase();
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000d1",
      organizationId: "org-delivery",
      projectId: "project-delivery",
      machineId: null,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-delivery",
    });
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      const began = await database.beginAgentExecutionOutput(
        execution.id,
        "linear.reply",
        undefined,
        STARTED_AT,
      );
      assert.ok(began !== undefined);
      assert.equal(
        await database.failAgentExecutionOutput(execution.id, began.id, STARTED_AT),
        true,
      );
    }

    const failedOnly = await deliveryState(database, execution.id);
    assert.deepEqual(
      missingRequiredOutputs(failedOnly).map((output) => output.type),
      ["linear.reply"],
      "failed attempts alone are not delivery",
    );
    assert.deepEqual(failedRequiredOutputDeliveries(failedOnly), [
      { type: "linear.reply", failedAttempts: 3 },
    ]);
    assert.equal(completesAtIdleDeadline(failedOnly), false);

    const began = await database.beginAgentExecutionOutput(
      execution.id,
      "linear.reply",
      undefined,
      STARTED_AT,
    );
    assert.ok(began !== undefined);
    await database.completeAgentExecutionOutput(execution.id, began.id, STARTED_AT);

    const delivered = await deliveryState(database, execution.id);
    assert.deepEqual(missingRequiredOutputs(delivered), []);
    assert.deepEqual(failedRequiredOutputDeliveries(delivered), []);
    assert.equal(completesAtIdleDeadline(delivered), true);
  });

  it("reports only required outputs whose attempts all failed", () => {
    const execution = {
      outputEmissions: {},
      outputDeliveryAttempts: {
        a: attempt("a", "linear.reply", "failed"),
        b: attempt("b", "linear.reply", "pending"),
        c: attempt("c", "github.comment", "failed"),
        d: attempt("d", "slack.message", "failed"),
      },
      launchIntent: {
        allowOutputs: [
          { type: "linear.reply", required: true },
          { type: "github.comment", required: true },
          { type: "slack.message" },
        ],
      },
    };

    assert.deepEqual(
      missingRequiredOutputs(execution).map((output) => output.type),
      ["linear.reply", "github.comment"],
    );
    assert.deepEqual(failedRequiredOutputDeliveries(execution), [
      { type: "linear.reply", failedAttempts: 1 },
      { type: "github.comment", failedAttempts: 1 },
    ]);
  });

  it("keeps a never-attempted required output recoverable", () => {
    const execution = {
      outputEmissions: {},
      outputDeliveryAttempts: {},
      launchIntent: REQUIRED_REPLY,
    };

    assert.equal(missingRequiredOutputs(execution).length, 1);
    assert.deepEqual(failedRequiredOutputDeliveries(execution), []);
  });

  it("describes failures with their attempt counts", () => {
    assert.equal(
      describeRequiredOutputDeliveryFailures([{ type: "linear.reply", failedAttempts: 1 }]),
      "linear.reply after 1 failed attempt",
    );
    assert.equal(
      describeRequiredOutputDeliveryFailures([
        { type: "linear.reply", failedAttempts: 3 },
        { type: "github.comment", failedAttempts: 2 },
      ]),
      "linear.reply after 3 failed attempts, github.comment after 2 failed attempts",
    );
  });
});

async function deliveryState(
  database: ReturnType<typeof createMemoryDatabase>,
  executionId: string,
) {
  const execution = await database.findAgentExecutionById(executionId);
  assert.ok(execution !== undefined);
  return {
    outputEmissions: execution.outputEmissions,
    outputDeliveryAttempts: execution.outputDeliveryAttempts,
    launchIntent: REQUIRED_REPLY,
  };
}

function attempt(
  id: string,
  outputType: string,
  status: AgentExecutionOutputAttempt["status"],
): AgentExecutionOutputAttempt {
  return {
    id,
    outputType,
    status,
    startedAt: STARTED_AT,
    leaseExpiresAt: STARTED_AT,
    completedAt: status === "pending" ? null : STARTED_AT,
  };
}
