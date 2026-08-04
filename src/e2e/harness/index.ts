import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { chromium } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";
import { runCommand } from "./command.js";
import { HubFaultProxy } from "./fault-proxy.js";
import { SourcePaseo } from "./source-paseo.js";

const exec = promisify(execFile);
const HUB_ROOT = process.cwd();
let MACHINE_KEY = "";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_SLUG = "default";
const PersistedDaemonAgentSchema = z.object({
  id: z.string(),
  lastStatus: z.enum(["error", "initializing", "idle", "running", "closed"]),
  owner: z.object({
    kind: z.literal("daemon"),
    daemonId: z.string(),
    executionId: z.string(),
  }),
});
const CanonicalToolCallSchema = z
  .object({
    type: z.literal("tool_call"),
    name: z.string(),
    status: z.enum(["running", "completed", "failed", "canceled"]),
  })
  .passthrough();

interface Enrollment {
  token: string;
  daemonId: string;
}

interface ManualRun {
  executionId: string;
  agentId: string;
}

interface AmbiguousRunEvidence {
  executionId: string;
  beforeRestart: {
    triggers: number;
    executions: number;
    status: string;
    daemonId: string | null;
    agentId: string | null;
  };
}

interface ManagedChild {
  name: string;
  process: ChildProcess;
  logFile: string;
  output: string[];
}

interface HubE2EOptions {
  realAgent?: boolean;
}

export interface ShutdownEvidence {
  durationMs: number;
  hubMs: number;
  daemonMs: number;
  ownedProcesses: string[];
  leakedProcesses: number[];
}

export class HubE2E {
  private root = "";
  private source: SourcePaseo | undefined;
  private workspace = "";
  private hubOrigin = "";
  private proxy: HubFaultProxy | undefined;
  private postgres: StartedPostgreSqlContainer | undefined;
  private pool: Pool | undefined;
  private hub: ManagedChild | undefined;
  private completionRunner: ManagedChild | undefined;
  private daemonHost = "";
  private acpRecordFile = "";
  private outputFile = "";
  private machineKeyFile = "";
  private completionGate = "";
  private completionJobs = "";
  private hubPort = 0;
  private stopped = false;

  private constructor(private readonly options: HubE2EOptions = {}) {}

  static async start(options: HubE2EOptions = {}): Promise<HubE2E> {
    const hub = new HubE2E(options);
    try {
      await hub.startResources();
      return hub;
    } catch (error) {
      await hub.stop();
      throw error;
    }
  }

  async issueEnrollment(): Promise<Enrollment> {
    const response = await fetch(`${this.requireProxy().origin}/api/daemons/enrollment-tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${MACHINE_KEY}` },
    });
    assertStatus(response, 201, "issue enrollment");
    const body = asRecord(await response.json());
    return { token: requiredString(body, "token"), daemonId: "" };
  }

  async connect(enrollment: Enrollment): Promise<void> {
    let status: Record<string, unknown>;
    try {
      status = await this.cli([
        "hub",
        "connect",
        this.requireProxy().origin,
        "--token",
        enrollment.token,
        "--host",
        this.daemonHost,
        "--json",
      ]);
    } catch (error) {
      const enrollmentState = await this.requirePool().query<{
        enrollment_tokens: string;
        daemons: string;
      }>(
        `select
           (select count(*)::text from daemon_enrollment_tokens) as enrollment_tokens,
           (select count(*)::text from daemons) as daemons`,
      );
      throw new Error(
        `Hub connection failed ${JSON.stringify(enrollmentState.rows[0])}\n${this.failureArtifacts()}`,
        { cause: error },
      );
    }
    enrollment.daemonId = requiredString(status, "daemonId");
  }

  async connectWithDeviceAuthorization(displayName: string): Promise<{ daemonId: string }> {
    try {
      const registration = await this.requireSource().beginRegistration(this.requireProxy().origin);
      const userCode = new URL(registration.verificationUrl).searchParams.get("code");
      if (userCode === null) throw new Error("Source registration did not contain a user code");
      await this.approveDeviceAuthorization(userCode, displayName);
      return { daemonId: requiredString(await registration.complete(), "daemonId") };
    } catch (error) {
      throw new Error("Browser-approved Hub connection failed; sensitive CLI output discarded", {
        cause: error,
      });
    }
  }

  async daemonIsConnected(): Promise<void> {
    await this.observe(async () => {
      const result = await this.requirePool().query<{ presence: string }>(
        "select presence from daemons limit 1",
      );
      return result.rows[0]?.presence === "connected" && this.requireProxy().hubConnectionIsOpen();
    }, "daemon to become connected");
  }

  async status(): Promise<{ state: string }> {
    const status = await this.requireSource().status();
    return { state: requiredString(status, "state") };
  }

  async createUnrelatedLocalAgent(): Promise<string> {
    const result = await this.cli([
      "run",
      "local unrelated activity",
      "--provider",
      "hub-e2e",
      "--detach",
      "--cwd",
      this.workspace,
      "--host",
      this.daemonHost,
      "--json",
    ]).catch((error: unknown) => {
      throw new Error(`Local agent creation failed\n${this.failureArtifacts()}`, { cause: error });
    });
    return requiredString(result, "agentId");
  }

  async installProductionConfiguration(): Promise<void> {
    const daemon = await this.requirePool().query<{ slug: string }>(
      "select slug from daemons limit 1",
    );
    const slug = daemon.rows[0]?.slug;
    if (!slug) throw new Error("Connected daemon has no daemon slug");
    const yaml = [
      "environments:",
      "  - name: phase-five",
      "    kind: daemon",
      `    daemon: ${slug}`,
      `    cwd: ${JSON.stringify(this.workspace)}`,
      "triggers:",
      "  - name: deploy",
      "    on: manual.run",
      "    environment: phase-five",
      "    filters:",
      "      from_users: [phase-five-operator]",
      "    agent:",
      "      provider: hub-e2e",
      "      mode: default",
      '    prompt: "Deploy ${{ paseo.event.manual.input.service }} for ${{ paseo.event.manual.actor }}"',
      "    allow_outputs:",
      "      - type: hub.e2e.result",
    ].join("\n");
    const response = await fetch(`${this.requireProxy().origin}/api/configurations/install`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MACHINE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectSlug: PROJECT_SLUG, yaml }),
    });
    assertStatus(response, 201, "install production configuration");
  }

  async installRealAgentConfiguration(): Promise<void> {
    const daemon = await this.requirePool().query<{ slug: string }>(
      "select slug from daemons limit 1",
    );
    const slug = daemon.rows[0]?.slug;
    if (!slug) throw new Error("Connected daemon has no daemon slug");
    const yaml = [
      "environments:",
      "  - name: real-agent",
      "    kind: daemon",
      `    daemon: ${slug}`,
      `    cwd: ${JSON.stringify(this.workspace)}`,
      "triggers:",
      "  - name: finalize",
      "    on: manual.run",
      "    environment: real-agent",
      "    filters:",
      "      from_users: [real-agent-operator]",
      "    agent:",
      "      provider: codex",
      "      mode: full-access",
      '    prompt: "Call the hub.finish_execution MCP tool exactly once. Do not use curl, shell, or direct HTTP."',
    ].join("\n");
    const response = await fetch(`${this.requireProxy().origin}/api/configurations/install`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MACHINE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectSlug: PROJECT_SLUG, yaml }),
    });
    assertStatus(response, 201, "install real-agent configuration");
  }

  async runManual(deliveryKey: string, service: string): Promise<ManualRun> {
    const response = await fetch(`${this.requireProxy().origin}/api/manual-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MACHINE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectSlug: PROJECT_SLUG,
        trigger: "deploy",
        actor: "phase-five-operator",
        deliveryKey,
        input: { service },
      }),
    });
    if (response.status !== 200) {
      const daemon = await this.requirePool().query<{
        id: string;
        slug: string;
        presence: string;
      }>("select id, slug, presence from daemons limit 1");
      throw new Error(
        `run manual trigger returned HTTP ${
          response.status
        }: ${await response.text()} daemon=${JSON.stringify(
          daemon.rows[0],
        )}\n${this.failureArtifacts()}`,
      );
    }
    const body = asRecord(await response.json());
    return {
      executionId: requiredString(body, "executionId"),
      agentId: requiredString(body, "agentId"),
    };
  }

  async runRealAgentManual(deliveryKey: string): Promise<ManualRun> {
    const response = await fetch(`${this.requireProxy().origin}/api/manual-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MACHINE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectSlug: PROJECT_SLUG,
        trigger: "finalize",
        actor: "real-agent-operator",
        deliveryKey,
        input: {},
      }),
    });
    if (response.status !== 200) {
      throw new Error(
        `run real-agent manual trigger returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const body = asRecord(await response.json());
    return {
      executionId: requiredString(body, "executionId"),
      agentId: requiredString(body, "agentId"),
    };
  }

  async realAgentCompletionEvidence(run: ManualRun): Promise<{
    status: string;
    completedByAgent: boolean;
    completedToolCall: boolean;
    completionHelperLaunched: boolean;
  }> {
    let completedToolCall = false;
    await this.observe(
      async () => {
        const result = await this.requirePool().query<{
          status: string;
          completed_by_agent_at: Date | null;
        }>("select status, completed_by_agent_at from agent_executions where id = $1", [
          run.executionId,
        ]);
        if (result.rows[0]?.status !== "succeeded" || result.rows[0].completed_by_agent_at === null)
          return false;
        const rawTimeline = await this.requireSource().canonicalAgentTimeline(run.agentId);
        const timeline = rawTimeline.flatMap((item) => {
          const parsed = CanonicalToolCallSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        });
        completedToolCall = timeline.some(
          (item) => item.name === "hub.finish_execution" && item.status === "completed",
        );
        return completedToolCall;
      },
      "real Codex agent to finish through Hub MCP",
      240_000,
    );
    const result = await this.requirePool().query<{
      status: string;
      completed_by_agent_at: Date | null;
    }>("select status, completed_by_agent_at from agent_executions where id = $1", [
      run.executionId,
    ]);
    const row = result.rows[0] ?? {};
    return {
      status: requiredString(row, "status"),
      completedByAgent: result.rows[0]?.completed_by_agent_at instanceof Date,
      completedToolCall,
      completionHelperLaunched: this.completionRunner !== undefined,
    };
  }

  async runCapabilityTrigger(deliveryKey: string): Promise<ManualRun> {
    const response = await fetch(`${this.requireProxy().origin}/test/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: "hub-e2e",
        projectId: PROJECT_ID,
        source: "e2e.discord",
        deliveryId: deliveryKey,
        payload: {},
      }),
    });
    if (response.status !== 200) {
      throw new Error(
        `run capability trigger returned HTTP ${response.status}: ${await response.text()}\n${this.failureArtifacts()}`,
      );
    }
    const executionId = await this.executionForDelivery(deliveryKey);
    await this.observe(async () => {
      const execution = await this.requirePool().query<{ daemon_agent_id: string | null }>(
        "select daemon_agent_id from agent_executions where id = $1",
        [executionId],
      );
      return execution.rows[0]?.daemon_agent_id !== null;
    }, "capability execution association");
    const execution = await this.requirePool().query<{ daemon_agent_id: string }>(
      "select daemon_agent_id from agent_executions where id = $1",
      [executionId],
    );
    return {
      executionId,
      agentId: requiredString({ agentId: execution.rows[0]?.daemon_agent_id }, "agentId"),
    };
  }

  async completedRun(executionId: string) {
    await this.observe(() => this.outputIsPersisted(executionId), "manual run output");
    const launchRecord = (await readJsonLines(this.acpRecordFile)).find(
      (record) => record["executionId"] === executionId,
    );
    if (launchRecord?.["completionUrl"] === null) {
      throw new Error(
        `Manual run did not receive its execution capability: ${JSON.stringify(launchRecord)}`,
      );
    }
    await this.observe(async () => {
      const result = await this.requirePool().query<{ status: string }>(
        "select status from agent_executions where id = $1",
        [executionId],
      );
      return result.rows[0]?.status === "succeeded";
    }, "manual run completion");
    const [execution, acpRecords] = await Promise.all([
      this.requirePool().query<{
        status: string;
        daemon_id: string;
        daemon_agent_id: string;
      }>("select status, daemon_id, daemon_agent_id from agent_executions where id = $1", [
        executionId,
      ]),
      readJsonLines(this.acpRecordFile),
    ]);
    const row = execution.rows[0];
    const record = acpRecords.find((value) => value["executionId"] === executionId);
    if (!row || !record) {
      throw new Error(
        `Completed run evidence is incomplete: ${JSON.stringify({
          row,
          record,
        })}\n${this.failureArtifacts()}`,
      );
    }
    return {
      prompt: requiredString(record, "prompt").split("\nStructured output:")[0],
      output: requiredString(record, "output"),
      status: row.status,
      daemonId: requiredString({ daemonId: row.daemon_id }, "daemonId"),
      agentId: requiredString({ agentId: row.daemon_agent_id }, "agentId"),
    };
  }

  async completedCapabilityRun(executionId: string) {
    await this.observe(async () => {
      const [result, outputs] = await Promise.all([
        this.requirePool().query<{ status: string }>(
          "select status from agent_executions where id = $1",
          [executionId],
        ),
        readJsonLines(this.outputFile),
      ]);
      return (
        result.rows[0]?.status === "succeeded" &&
        outputs.some((value) => value["agentExecutionId"] === executionId)
      );
    }, "capability reply and completion");
    const [records, outputs] = await Promise.all([
      readJsonLines(this.acpRecordFile),
      readJsonLines(this.outputFile),
    ]);
    const record = records.find((value) => value["executionId"] === executionId);
    const output = outputs.find((value) => value["agentExecutionId"] === executionId);
    if (!record || !output) throw new Error("Capability evidence is incomplete");
    return {
      reply: requiredString(asRecord(output["args"]), "content"),
      outputContext: output["outputContext"],
      replySucceeded: record["replySucceeded"] === true,
      duplicateRejected: record["duplicateRejected"] === true,
      secretCompletionEnvPresent: record["secretCompletionEnvPresent"] === true,
    };
  }

  requestForbiddenOperation() {
    return this.requireProxy().requestForbiddenOperation();
  }

  requestForbiddenSteer(agentId: string) {
    return this.requireProxy().requestForbiddenSteer(agentId);
  }

  async isUnrelatedAgentVisible(agentId: string): Promise<boolean> {
    const result = await this.requirePool().query(
      "select 1 from agent_executions where daemon_agent_id = $1",
      [agentId],
    );
    return result.rowCount !== 0;
  }

  relayEvidence() {
    const source = this.requireSource();
    const config = this.paseoConfig(source.paths.packagesRoot, source.paths.daemonHost);
    const relayOptions = Object.keys(config.daemon.relay).filter((key) => key !== "enabled");
    return {
      enabled: config.daemon.relay.enabled,
      configuredOptions: relayOptions,
    };
  }

  daemonAttemptedRelayConnection(): boolean {
    return this.source?.attemptedRelayConnection() ?? false;
  }

  async disconnect(): Promise<void> {
    await this.requireSource().disconnect();
  }

  async beginAmbiguousManualRun(): Promise<AmbiguousRunEvidence> {
    await rm(this.completionGate, { force: true });
    this.requireProxy().loseNextCreateResponse();
    void this.runManual("replayed-delivery", "recovery").catch(() => undefined);
    await this.requireProxy().createResponseWasDropped();
    const executionId = await this.executionForDelivery("replayed-delivery");
    await this.observe(
      async () => this.outputIsPersisted(executionId),
      "ambiguous agent output to persist before Hub restart",
    );
    await this.observe(
      async () => (await this.deliveryEvidence("replayed-delivery")).status === "running",
      "ambiguous execution to enter running state before Hub restart",
    );
    return {
      executionId,
      beforeRestart: await this.deliveryEvidence("replayed-delivery"),
    };
  }

  async recoverAmbiguousManualRun(executionId: string): Promise<void> {
    await this.restartHub();
    await this.observe(
      async () => this.requireProxy().hasReplacementConnection(),
      "daemon to reconnect to restarted Hub",
    );
    await this.daemonIsConnected();
    await this.observe(async () => {
      const row = await this.requirePool().query<{
        daemon_agent_id: string | null;
      }>("select daemon_agent_id from agent_executions where id = $1", [executionId]);
      return row.rows[0]?.daemon_agent_id !== null;
    }, "recovered execution association");
    await this.observe(
      async () => (await this.persistedDaemonAgents(executionId)).length === 1,
      "one persisted daemon-owned daemon agent",
    );
    await this.observe(async () => {
      const creation = this.requireProxy().creation(executionId);
      return this.requireProxy().createAttempts(executionId) === 2 && creation.hasCurrentState;
    }, "idempotent create retry with current state");
  }

  async allowRecoveredCompletion(): Promise<void> {
    await writeFile(this.completionGate, "recovered\n");
  }

  async beginDaemonRestartRun(): Promise<ManualRun> {
    await rm(this.completionGate, { force: true });
    const run = await this.runManual("daemon-restart-delivery", "daemon-restart");
    await this.observe(
      async () =>
        (await readJsonLines(this.acpRecordFile)).some(
          (record) => record["executionId"] === run.executionId,
        ),
      "owned agent to begin its in-flight prompt",
    );
    return run;
  }

  async restartDaemonAndRecover(executionId: string) {
    const proxy = this.requireProxy();
    const connectionsBefore = proxy.connectionCount();
    const createsBefore = proxy.createAttempts(executionId);
    await this.observe(
      async () => (await this.persistedDaemonAgents(executionId))[0]?.lastStatus === "running",
      "owned daemon agent to persist running state",
    );
    const beforeRestart = (await this.persistedDaemonAgents(executionId))[0];
    if (beforeRestart?.lastStatus !== "running")
      throw new Error("Owned daemon agent was not running immediately before restart");
    await this.requireSource().restart();
    await this.observe(
      async () => proxy.connectionCount() > connectionsBefore,
      "restarted daemon daemon to reconnect",
    );
    await this.daemonIsConnected();
    await this.observe(async () => {
      const creation = proxy.creation(executionId);
      return proxy.createAttempts(executionId) > createsBefore && creation.status === "closed";
    }, "restarted daemon idempotent create with closed current state");
    await this.observe(async () => {
      const execution = await this.requirePool().query<{ status: string }>(
        "select status from agent_executions where id = $1",
        [executionId],
      );
      return execution.rows[0]?.status === "failed";
    }, "interrupted execution to fail");

    const [association, persistedAgents, prompts] = await Promise.all([
      this.requirePool().query<{
        daemon_id: string;
        daemon_agent_id: string;
        status: string;
        result: unknown;
      }>("select daemon_id, daemon_agent_id, status, result from agent_executions where id = $1", [
        executionId,
      ]),
      this.persistedDaemonAgents(executionId),
      readJsonLines(this.acpRecordFile),
    ]);
    const row = association.rows[0];
    const persistedAgent = persistedAgents[0];
    if (!row || !persistedAgent) throw new Error("Daemon restart association is missing");
    return {
      persistedDaemonAgents: persistedAgents.length,
      executionAgentId: row.daemon_agent_id,
      ownerAgentId: persistedAgent.id,
      ownerDaemonId: persistedAgent.owner.daemonId,
      associationDaemonId: row.daemon_id,
      createAttempts: proxy.createAttempts(executionId),
      promptAttempts: prompts.filter((prompt) => prompt["executionId"] === executionId).length,
      recoveryCreateAttempts: proxy.createAttempts(executionId) - createsBefore,
      statusImmediatelyBeforeRestart: beforeRestart.lastStatus,
      recoveredStatusAfterRestart: proxy.creation(executionId).status,
      executionStatus: row.status,
      executionResult: row.result,
    };
  }

  async replayEvidence(executionId: string) {
    const [result, delivery, persistedAgents] = await Promise.all([
      this.requirePool().query<{
        daemon_agent_id: string;
        daemon_id: string;
      }>("select daemon_agent_id, daemon_id from agent_executions where id = $1", [executionId]),
      this.deliveryEvidence("replayed-delivery"),
      this.persistedDaemonAgents(executionId),
    ]);
    const row = result.rows[0];
    const persistedAgent = persistedAgents[0];
    if (!row || !persistedAgent) throw new Error("Replayed execution association is missing");
    const creation = this.requireProxy().creation(executionId);
    const association = await this.requirePool().query<{ count: number }>(
      "select count(*)::int as count from agent_executions where id = $1 and daemon_id is not null and daemon_agent_id is not null",
      [executionId],
    );
    return {
      deliveryTriggers: delivery.triggers,
      executions: delivery.executions,
      persistedDaemonAgents: persistedAgents.length,
      ownerMatchingAgentId: persistedAgent.id,
      ownerDaemonId: persistedAgent.owner.daemonId,
      ownerMatchesAssociation: persistedAgent.owner.daemonId === row.daemon_id,
      executionAgentId: row.daemon_agent_id,
      persistedAssociations: association.rows[0]?.count ?? 0,
      createAttempts: this.requireProxy().createAttempts(executionId),
      recoveredAgentId: creation.agentId,
      recoveredCurrentState: creation.hasCurrentState,
    };
  }

  private async deliveryEvidence(deliveryId: string) {
    const [triggers, executions] = await Promise.all([
      this.requirePool().query<{ count: number }>(
        "select count(*)::int as count from triggers where delivery_id = $1",
        [deliveryId],
      ),
      this.requirePool().query<{
        status: string;
        daemon_id: string | null;
        daemon_agent_id: string | null;
      }>(
        "select ae.status, ae.daemon_id, ae.daemon_agent_id from agent_executions ae join triggers t on t.id = ae.trigger_id where t.delivery_id = $1",
        [deliveryId],
      ),
    ]);
    const execution = executions.rows[0];
    if (!execution) throw new Error(`Delivery ${deliveryId} has no execution`);
    return {
      triggers: triggers.rows[0]?.count ?? 0,
      executions: executions.rows.length,
      status: execution.status,
      daemonId: execution.daemon_id,
      agentId: execution.daemon_agent_id,
    };
  }

  private async persistedDaemonAgents(executionId: string) {
    const agentsRoot = join(this.requireSource().paths.paseoHome, "agents");
    const files = await readdir(agentsRoot, { recursive: true }).catch(() => []);
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const value: unknown = JSON.parse(await readFile(join(agentsRoot, file), "utf8"));
          return PersistedDaemonAgentSchema.safeParse(value).data;
        }),
    );
    return records.filter(
      (record) => record?.owner.executionId === executionId && record.owner.kind === "daemon",
    );
  }

  async stop(): Promise<ShutdownEvidence> {
    if (this.stopped)
      return {
        durationMs: 0,
        hubMs: 0,
        daemonMs: 0,
        ownedProcesses: [],
        leakedProcesses: [],
      };
    this.stopped = true;
    const startedAt = performance.now();
    const failures: unknown[] = [];
    const ownedProcesses = new Set<number>();
    const ownedProcessDescriptions: string[] = [];
    const hubMs = await this.stopOwnedChild(
      this.hub,
      ownedProcesses,
      ownedProcessDescriptions,
      failures,
    );
    const sourceStartedAt = performance.now();
    const sourceEvidence = await this.source?.stop().catch((error) => {
      failures.push(error);
      return undefined;
    });
    const daemonMs = Math.round(performance.now() - sourceStartedAt);
    for (const description of sourceEvidence?.ownedProcesses ?? []) {
      ownedProcessDescriptions.push(`daemon: ${description}`);
    }
    for (const pid of sourceEvidence?.leakedProcesses ?? []) ownedProcesses.add(pid);
    await this.stopOwnedChild(
      this.completionRunner,
      ownedProcesses,
      ownedProcessDescriptions,
      failures,
    );
    await this.attempt(() => this.proxy?.stop(), failures);
    await this.attempt(() => this.pool?.end(), failures);
    await this.attempt(() => this.postgres?.stop(), failures);
    if (this.root)
      await rm(this.root, { recursive: true, force: true }).catch((error) => failures.push(error));
    const leakedProcesses = [...ownedProcesses].filter(isProcessAlive);
    const evidence = {
      durationMs: Math.round(performance.now() - startedAt),
      hubMs,
      daemonMs,
      ownedProcesses: ownedProcessDescriptions,
      leakedProcesses,
    };
    process.stdout.write(`Hub E2E shutdown ${JSON.stringify(evidence)}\n`);
    if (leakedProcesses.length > 0)
      failures.push(new Error(`Hub E2E leaked owned processes: ${leakedProcesses.join(", ")}`));
    if (failures.length > 0) throw new AggregateError(failures, "Hub E2E cleanup failed");
    return evidence;
  }

  private async stopOwnedChild(
    child: ManagedChild | undefined,
    ownedProcesses: Set<number>,
    ownedProcessDescriptions: string[],
    failures: unknown[],
  ): Promise<number> {
    const startedAt = performance.now();
    try {
      const family = await processFamily(child?.process.pid);
      for (const pid of family) ownedProcesses.add(pid);
      ownedProcessDescriptions.push(
        ...(await describeProcesses(family)).map((description) => `${child?.name}: ${description}`),
      );
      await stopChild(child, family);
    } catch (error) {
      failures.push(error);
    }
    return Math.round(performance.now() - startedAt);
  }

  private async attempt(operation: () => Promise<unknown> | undefined, failures: unknown[]) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }

  private async startResources(): Promise<void> {
    this.root = await mkdtemp(join(process.env["TMPDIR"] ?? "/tmp", "paseo-hub-e2e-"));
    this.workspace = join(this.root, "workspace");
    this.acpRecordFile = join(this.root, "acp-records.jsonl");
    this.outputFile = join(this.root, "hub-outputs.jsonl");
    this.machineKeyFile = join(this.root, "machine-api-key");
    this.completionGate = join(this.root, "allow-acp-completion");
    this.completionJobs = join(this.root, "completion-jobs");
    await Promise.all([
      mkdir(this.workspace),
      mkdir(this.completionJobs),
      writeFile(this.completionGate, "ready\n"),
    ]);
    await initializeGitWorkspace(this.workspace);
    const [hubPort, proxyPort, daemonPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePort(),
    ]);
    this.hubPort = hubPort;
    this.hubOrigin = `http://127.0.0.1:${hubPort}`;
    this.daemonHost = `127.0.0.1:${daemonPort}`;
    this.postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    this.pool = new Pool({
      connectionString: this.postgres.getConnectionUri(),
    });
    this.proxy = await HubFaultProxy.start(this.hubOrigin, proxyPort);
    this.hub = await this.startHub();
    if (this.options.realAgent !== true) {
      this.completionRunner = await startChild({
        name: "completion-runner",
        command: process.execPath,
        args: [join(HUB_ROOT, "src/e2e/harness/completion-helper.mjs")],
        cwd: HUB_ROOT,
        root: this.root,
        env: {
          HUB_E2E_COMPLETION_JOBS: this.completionJobs,
          HUB_E2E_COMPLETE_GATE: this.completionGate,
        },
      });
    }
    await this.observe(
      async () => (await fetch(`${this.proxy!.origin}/health`).catch(() => undefined))?.ok === true,
      "Hub child to become healthy",
    );
    MACHINE_KEY = (await readFile(this.machineKeyFile, "utf8")).trim();
    this.source = await SourcePaseo.start({
      root: this.root,
      paseoHome: join(this.root, "paseo-home"),
      daemonHost: this.daemonHost,
      config: ({ packagesRoot, daemonHost }) => this.paseoConfig(packagesRoot, daemonHost),
    });
  }

  private async startHub(): Promise<ManagedChild> {
    return startChild({
      name: "hub",
      command: process.execPath,
      args: ["--import", "tsx", "src/e2e/harness/hub-child.ts"],
      cwd: HUB_ROOT,
      root: this.root,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: this.requirePostgres().getConnectionUri(),
        PORT: String(this.hubPort),
        HUB_E2E_MACHINE_KEY_FILE: this.machineKeyFile,
        PASEO_HUB_APP_URL: this.requireProxy().origin,
        PASEO_HUB_AUTH_SECRET: "hub-e2e-browser-auth-secret-at-least-32-characters",
        PASEO_REGISTRATION_MODE: "open",
        PASEO_ORGANIZATION_CREATION: "open",
        HUB_E2E_OUTPUT_FILE: this.outputFile,
      },
    });
  }

  private async approveDeviceAuthorization(userCode: string, displayName: string): Promise<void> {
    const origin = this.requireProxy().origin;
    const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
    const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Hub Browser Approver",
        email: `hub-browser-${randomUUID()}@example.test`,
        password: "hub-browser-password",
      }),
    });
    assertStatus(signUp, 200, "create browser approver");
    const cookie = signUp.headers.get("set-cookie")?.match(/^([^=]+)=([^;]+)/u);
    if (cookie?.[1] === undefined || cookie[2] === undefined) {
      throw new Error("Browser approver session cookie was not issued");
    }
    const organization = await fetch(`${origin}/api/auth/paseo/create-organization`, {
      method: "POST",
      headers: { ...headers, cookie: `${cookie[1]}=${cookie[2]}` },
      body: JSON.stringify({ name: "Device organization" }),
    });
    assertStatus(organization, 201, "create browser approver organization");
    const organizationId = z
      .object({ organizationId: z.string() })
      .parse(await organization.json()).organizationId;
    if (organizationId.length === 0)
      throw new Error("browser approver organization was not created");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: cookie[1], value: cookie[2], url: origin }]);
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/activate?code=${encodeURIComponent(userCode)}`);
        await page.getByLabel("Display name").fill(displayName);
        await page.getByRole("button", { name: "Approve daemon" }).click();
        await page.getByRole("heading", { name: "Registration approved" }).waitFor();
      } catch (error) {
        throw new Error(`Browser approval page did not render: ${await approvalPageState(page)}`, {
          cause: error,
        });
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }

  private async restartHub(): Promise<void> {
    await stopChild(this.hub);
    this.hub = await this.startHub();
    await this.observe(
      async () => (await fetch(`${this.proxy!.origin}/health`).catch(() => undefined))?.ok === true,
      "restarted Hub child to become healthy",
    );
    MACHINE_KEY = (await readFile(this.machineKeyFile, "utf8")).trim();
  }

  private paseoConfig(packagesRoot: string, daemonHost: string) {
    return {
      version: 1,
      daemon: {
        listen: daemonHost,
        relay: { enabled: false },
        mcp: { enabled: false, injectIntoAgents: false },
        browserTools: { enabled: false },
        cors: { allowedOrigins: [] },
      },
      ...(this.options.realAgent === true
        ? {}
        : {
            agents: {
              providers: {
                "hub-e2e": {
                  extends: "acp",
                  label: "Hub E2E",
                  command: [process.execPath, join(HUB_ROOT, "src/e2e/harness/acp-agent.mjs")],
                  env: {
                    NODE_OPTIONS: "",
                    HUB_E2E_ACP_SDK: join(
                      packagesRoot,
                      "node_modules/@agentclientprotocol/sdk/dist/acp.js",
                    ),
                    HUB_E2E_ACP_RECORD_FILE: this.acpRecordFile,
                    HUB_E2E_COMPLETE_GATE: this.completionGate,
                    HUB_E2E_COMPLETION_JOBS: this.completionJobs,
                  },
                },
              },
            },
          }),
      features: {
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    };
  }

  private async cli(args: string[]): Promise<Record<string, unknown>> {
    return this.requireSource().run(args);
  }

  private async executionForDelivery(deliveryId: string): Promise<string> {
    await this.observe(async () => {
      const row = await this.requirePool().query<{ id: string }>(
        "select ae.id from agent_executions ae join triggers t on t.id = ae.trigger_id where t.delivery_id = $1",
        [deliveryId],
      );
      return row.rows[0] !== undefined;
    }, "ambiguous execution to persist");
    const row = await this.requirePool().query<{ id: string }>(
      "select ae.id from agent_executions ae join triggers t on t.id = ae.trigger_id where t.delivery_id = $1",
      [deliveryId],
    );
    return row.rows[0]!.id;
  }

  private async outputIsPersisted(executionId: string): Promise<boolean> {
    return (await readJsonLines(this.acpRecordFile)).some(
      (record) => record["executionId"] === executionId,
    );
  }

  private async observe(
    check: () => Promise<boolean>,
    description: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Timed out waiting for ${description}\n${this.failureArtifacts()}`);
  }

  private failureArtifacts(): string {
    const processLogs = [this.hub, this.completionRunner]
      .filter((child): child is ManagedChild => child !== undefined)
      .map((child) => `${child.name} (${child.logFile}):\n${child.output.slice(-30).join("")}`)
      .join("\n");
    return `${processLogs}\nproxy:\n${this.proxy?.evidence() ?? "not started"}`;
  }

  private requireProxy(): HubFaultProxy {
    if (!this.proxy) throw new Error("Hub fault proxy is unavailable");
    return this.proxy;
  }

  private requireSource(): SourcePaseo {
    if (!this.source) throw new Error("Source-built Paseo is unavailable");
    return this.source;
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error("Postgres is unavailable");
    return this.pool;
  }

  private requirePostgres(): StartedPostgreSqlContainer {
    if (!this.postgres) throw new Error("Postgres is unavailable");
    return this.postgres;
  }
}

async function approvalPageState(page: import("@playwright/test").Page): Promise<string> {
  const url = new URL(page.url());
  const [headings, forms, alerts] = await Promise.all([
    page.getByRole("heading").allTextContents(),
    page.getByRole("form").count(),
    page.getByRole("alert").allTextContents(),
  ]);
  return JSON.stringify({ pathname: url.pathname, headings, forms, alerts });
}

async function initializeGitWorkspace(workspace: string): Promise<void> {
  await runCommand("git", ["init", "-q"], workspace, {});
  await writeFile(join(workspace, "README.md"), "phase five\n");
  await runCommand("git", ["add", "README.md"], workspace, {});
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Hub E2E",
      "-c",
      "user.email=hub-e2e@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    workspace,
    {},
  );
}

async function startChild(input: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  root: string;
  env: NodeJS.ProcessEnv;
}): Promise<ManagedChild> {
  const logFile = join(input.root, `${input.name}.log`);
  const output: string[] = [];
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk: Buffer) => {
    const text = chunk.toString();
    output.push(text);
    void writeFile(logFile, output.join(""));
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.once("error", (error) => output.push(`${error.stack ?? error.message}\n`));
  return { name: input.name, process: child, logFile, output };
}

async function stopChild(child: ManagedChild | undefined, knownFamily?: number[]): Promise<void> {
  if (!child || child.process.exitCode !== null) return;
  const pid = child.process.pid;
  if (pid === undefined) throw new Error(`${child.name} has no process id`);
  const family = knownFamily ?? (await processFamily(pid));
  child.process.kill("SIGTERM");
  await withDiagnosticTimeout(
    new Promise<void>((done) => child.process.once("exit", () => done())),
    10_000,
    async () =>
      new Error(`${child.name} did not exit after SIGTERM\n${await processDiagnostics(pid)}`),
  );
  await withDiagnosticTimeout(
    waitForProcessExit(family),
    10_000,
    async () =>
      new Error(
        `${child.name} descendants did not exit after their parent\n${(
          await describeProcesses(family)
        ).join("\n")}`,
      ),
  );
}

async function waitForProcessExit(pids: readonly number[]): Promise<void> {
  while (pids.some(isProcessAlive)) await new Promise((done) => setTimeout(done, 20));
}

async function withDiagnosticTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  failure: () => Promise<Error>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => void failure().then(reject), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processFamily(rootPid: number | undefined): Promise<number[]> {
  if (rootPid === undefined) return [];
  const { stdout } = await exec("ps", ["-ax", "-o", "pid=,ppid="]);
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const family: number[] = [];
  const visit = (pid: number) => {
    family.push(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  visit(rootPid);
  return family;
}

async function processDiagnostics(rootPid: number): Promise<string> {
  const family = new Set(await processFamily(rootPid));
  const { stdout } = await exec("ps", ["-ax", "-o", "pid=,ppid=,state=,etime=,command="]);
  return stdout
    .split("\n")
    .filter((line) => family.has(Number(line.trim().split(/\s+/u)[0])))
    .join("\n");
}

async function describeProcesses(pids: readonly number[]): Promise<string[]> {
  if (pids.length === 0) return [];
  const selected = new Set(pids);
  const { stdout } = await exec("ps", ["-ax", "-o", "pid=,ppid=,state=,etime=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => selected.has(Number(line.split(/\s+/u)[0])))
    .map(redactProcessDescription);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function redactProcessDescription(description: string): string {
  return description.replace(
    /(--(?:api-key|credential|password|secret|token))(=|\s+)\S+/giu,
    "$1$2<redacted>",
  );
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => asRecord(JSON.parse(line)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected ${key} in ${JSON.stringify(value)}`);
  return field;
}

function assertStatus(response: Response, expected: number, action: string): void {
  if (response.status !== expected) {
    throw new Error(`${action} returned HTTP ${response.status}`);
  }
}
