import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { durableExecutionId } from "../daemons/lifecycle.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { ManualTriggerInput } from "../triggers/manual/schema.js";
import type { ExternalTrigger, TriggerProvider } from "../triggers/index.js";
import { createManualTriggerSource, dispatchManualTrigger } from "../triggers/manual/source.js";
import { createDispatcherWithEngine } from "./index.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

describe("manual trigger durable workflow boundary", () => {
  it("records a manual delivery as dropped when no provider matches", async () => {
    const database = createMemoryDatabase();
    const source = createManualTriggerSource(database);
    const { handler } = createDispatcherWithEngine({
      database,
      providers: [noMatchingProvider()],
      configurationRevisionId: "config-1",
    });
    await source.start(handler);

    await dispatchManualTrigger(source, manualTrigger("manual-no-match"));

    assert.equal(
      (await database.findTriggerByDeliveryId("manual-no-match", "org_1"))?.droppedReason,
      "no_matching_trigger",
    );
  });

  it("persists one manual run and lets the workflow worker own the step dispatch", async () => {
    const database = createMemoryDatabase();
    const source = createManualTriggerSource(database);
    const dispatches: string[] = [];
    const { handler, engine } = createDispatcherWithEngine({
      database,
      providers: [matchingProvider()],
      configurationRevisionId: "config-1",
      dispatchLaunchMachineIntent: async (intent) => {
        dispatches.push(intent.workflowStepRunId ?? "");
        const execution = await database.insertAgentExecution({
          id: durableExecutionId(intent),
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          machineId: null,
          triggerId: intent.triggerId,
          triggerContext: intent.triggerContext,
          outputContext: intent.outputContext,
          configurationRevisionId: intent.configurationRevisionId,
          workflowStepRunId: intent.workflowStepRunId!,
          launchIntent: intent,
        });
        return { execution };
      },
    });
    await source.start(handler);

    const outcome = await dispatchManualTrigger(source, manualTrigger("manual-durable"));
    await engine.processAvailable();

    assert.equal(outcome?.triggerId !== undefined, true);
    const triggerId = outcome?.triggerId;
    assert.ok(triggerId);
    const run = (await database.findTriggerRunsByTriggerId(triggerId))[0];
    assert.ok(run);
    const step = await database.findWorkflowStepRunByTriggerRun(run.id);
    assert.ok(step);
    assert.deepEqual(dispatches, [step.id]);
    assert.equal(
      (await database.findAgentExecutionByWorkflowStepRunId(step.id))?.workflowStepRunId,
      step.id,
    );
  });
});

function manualTrigger(deliveryId: string): ManualTriggerInput {
  const trigger: ExternalTrigger = {
    organizationId: "org_1",
    projectId: PROJECT_ID,
    source: "manual.run",
    deliveryId,
    receivedAt: new Date("2026-08-05T12:00:00.000Z"),
    payload: { trigger: "deploy", actor: "operator", input: "run" },
  };
  return trigger;
}

function noMatchingProvider(): TriggerProvider {
  return {
    name: "manual",
    eventNames: ["manual.run"],
    async match() {
      return [];
    },
  };
}

function matchingProvider(): TriggerProvider {
  return {
    name: "manual",
    eventNames: ["manual.run"],
    async match(trigger) {
      return [
        {
          triggerName: "deploy",
          stepId: "deploy-agent",
          environmentName: "runner",
          environment: {
            kind: "daemon",
            daemonId: "daemon-1",
            authoredSlug: "runner",
            cwd: "/repo",
          },
          prompt: `Run ${JSON.stringify(trigger.payload)}`,
          agent: { provider: "opencode", mode: "default" },
          allowOutputs: [],
          runTimeoutMs: 60_000,
          timeoutMs: 30_000,
          idleTimeoutMs: 5_000,
          autoArchive: false,
          triggerContext: trigger.payload,
          outputContext: { provider: "manual" },
          hubConfig: { environments: [], triggers: [] },
        },
      ];
    },
  };
}
