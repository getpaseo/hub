import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type {
  DaemonExecutionControlOptions,
  DaemonEventHandler,
  DaemonEvent,
  DaemonConnection,
} from "./protocol.js";
import { createDaemonDispatchLifecycle, type DaemonDispatchLifecycle } from "./lifecycle.js";

const DAEMON_ID = "daemon-ack-test";
const AGENT_ID = "agent-ack-test";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const ACKNOWLEDGED_AT = new Date("2026-01-01T00:00:01.000Z");

describe("durable Hub action acknowledgement state", () => {
  it("ignores unrelated failed or canceled tools when finish_execution completes", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

    await fixture.connection.emit(toolCall("shell-call", "shell", "failed"));
    await fixture.connection.emit(toolCall("other-call", "other", "canceled"));
    await fixture.connection.emit(
      toolCall("finish-call", "mcp__hub__finish_execution", "completed"),
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.connection.emit(agentIdle());

    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.callId, "finish-call");
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.status, "completed");
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });

  it.each(["running", "canceled"] as const)(
    "does not archive while finish_execution is %s",
    async (status) => {
      const fixture = await acknowledgementFixture();
      await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

      await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", status));
      await fixture.connection.emit(turnCompleted());
      await fixture.connection.emit(agentIdle());

      const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
      assert.deepEqual(fixture.connection.actions, []);
      assert.equal(execution?.hubActionReadyAt, null);
      assert.equal(execution?.hubActionCompletedAt, null);
      await fixture.lifecycle.stop();
    },
  );

  it("resumes durable partial signals across restart and archives exactly once", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", "completed"));
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.equal(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionReadyAt,
      null,
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.notEqual(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionAcknowledgements
        .terminalAt,
      null,
    );
    await fixture.connection.emit(agentIdle());

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });
});

async function acknowledgementFixture() {
  const database = createMemoryDatabase({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision-ack-test",
  });
  await database.attachAgentToExecution(EXECUTION_ID, DAEMON_ID, AGENT_ID);
  await database.transitionAgentExecution(EXECUTION_ID, "succeeded", {
    completedByAgent: true,
    hubAction: "archive",
  });
  const connection = new AcknowledgementConnection();
  return {
    database,
    connection,
    lifecycle: createLifecycle(database, connection),
  };
}

function createLifecycle(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  connection: AcknowledgementConnection,
): DaemonDispatchLifecycle {
  return createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: (daemonId) => (daemonId === DAEMON_ID ? connection : undefined),
  });
}

class AcknowledgementConnection implements DaemonConnection {
  readonly actions: DaemonExecutionControlOptions["action"][] = [];
  private readonly handlers = new Set<DaemonEventHandler>();

  on(handler: DaemonEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }

  async createAgent(): Promise<never> {
    throw new Error("not used");
  }

  async controlExecution(options: DaemonExecutionControlOptions): Promise<void> {
    this.actions.push(options.action);
  }
}

function toolCall(
  callId: string,
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: {
      type: "timeline",
      provider: "test",
      item: { type: "tool_call", callId, name, status },
    },
  } as DaemonEvent;
}

function turnCompleted(): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: { type: "turn_completed", provider: "test" },
  };
}

function agentIdle(): DaemonEvent {
  return {
    type: "agent_update",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    agent: { id: AGENT_ID, status: "idle" },
  };
}
