import { basename, join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResultRow } from "pg";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { logger } from "../logger.js";
import { DatabaseUnavailableError, toDatabaseError } from "./errors.js";
import { ConnectionRepository } from "./connections.js";
import { TriggerAcceptanceRepository } from "./trigger-acceptance.js";
import * as schema from "./schema.js";
import {
  toAgentExecutionRecord,
  toAttachmentRecord,
  toMachineRecord,
  toProjectConfigurationRevisionRecord,
  toProjectRecord,
  toTriggerRecord,
} from "./mappers.js";
import type { AgentExecutionStatus, MachineSource, MachineStatus } from "./schema.js";
import type {
  AgentExecutionRecord,
  AttachmentProvider,
  AttachmentRecord,
  ConfigurationSyncAttemptRecord,
  CreateProjectInput,
  Database,
  InsertProjectConfigurationRevisionInput,
  InsertAgentExecutionInput,
  InsertAttachmentInput,
  InsertMachineInput,
  InsertTriggerInput,
  InsertTriggerResult,
  MachineRecord,
  TerminateMachineFields,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  TriggerRecord,
  TriggerLifecycleState,
  EnrollDaemonInput,
  EnrollmentTokenRecord,
  DaemonRecord,
  DeviceAuthorizationRecord,
  DeviceAuthorizationDecisionInput,
  DevicePollResult,
  StartDeviceAuthorizationInput,
  SwitchProjectConfigurationToManualInput,
  SetProjectGitHubConfigurationSourceInput,
  RecordConfigurationSyncAttemptInput,
  AdvanceGitHubConnectionAttemptInput,
  BindDiscordConnectionInput,
  BindGitHubConnectionInput,
  BindSlackConnectionInput,
  ConnectionStartAuthority,
  ConnectionProvider,
  ReadConnectionAttemptInput,
  StartConnectionAttemptInput,
  AcceptDiscordTriggerInput,
  AcceptGitHubTriggerInput,
  AcceptSlackTriggerInput,
  GitHubLifecycleClaim,
  GitHubLifecycleClaimInput,
  GitHubLifecycleResult,
  PersistManualTriggerInput,
  ProjectConfigurationReadModel,
  ProjectConfigurationRevisionRecord,
  ProjectRecord,
  OrganizationConnectionUsage,
  GitHubRepositoryRecord,
  GitHubConfigurationTarget,
  ProjectTriggerRoute,
} from "./types.js";

const QUERY_DEADLINE_MS = 3_000;
const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle");
const DEFAULT_POSTGRES_DATABASE = "postgres";

export async function createDatabase(url: string): Promise<Database> {
  await ensureDatabaseExists(url);
  const pool = createPostgresPool(url);
  try {
    await runMigrations(pool);
    return new PgDatabase(pool);
  } catch (error) {
    await pool.end();
    throw toDatabaseError(error);
  }
}

class PgDatabase implements Database {
  private readonly connections;
  private readonly triggerAcceptance;

  constructor(private readonly pool: Pool) {
    const database = drizzle(pool, { schema });
    this.connections = new ConnectionRepository(database);
    this.triggerAcceptance = new TriggerAcceptanceRepository(database, this.connections);
  }

  acceptGitHubTrigger(input: AcceptGitHubTriggerInput) {
    return this.triggerAcceptance.acceptGitHub(input);
  }

  acceptDiscordTrigger(input: AcceptDiscordTriggerInput) {
    return this.triggerAcceptance.acceptDiscord(input);
  }

  acceptSlackTrigger(input: AcceptSlackTriggerInput) {
    return this.triggerAcceptance.acceptSlack(input);
  }

  persistManualTrigger(input: PersistManualTriggerInput) {
    return this.triggerAcceptance.persistManual(input);
  }

  claimGitHubLifecycle(input: GitHubLifecycleClaimInput) {
    return this.triggerAcceptance.claimGitHubLifecycle(input);
  }

  applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ) {
    return this.triggerAcceptance.applyGitHubLifecycle(claim, result);
  }

  releaseGitHubLifecycleClaim(triggerId: string) {
    return this.triggerAcceptance.releaseGitHubLifecycleClaim(triggerId);
  }

  async insertTrigger(input: InsertTriggerInput): Promise<InsertTriggerResult> {
    try {
      const receiptId = input.receiptId ?? (await ensureTriggerReceipt(this.pool, input));
      const insertedRows = await query<TriggerRow>(
        this.pool,
        `
          insert into triggers (
            organization_id,
            project_id,
            configuration_revision_id,
            receipt_id,
            connection_id,
            resource_id,
            delivery_id,
            signature_hash,
            source,
            repo,
            payload,
            received_at,
            matched_trigger_name,
            dropped_reason
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          on conflict do nothing
          returning *
        `,
        [
          input.organizationId,
          input.projectId,
          input.configurationRevisionId ?? null,
          receiptId,
          input.connectionId ?? null,
          input.resourceId ?? null,
          input.deliveryId,
          input.signatureHash ?? null,
          input.source,
          input.repo ?? null,
          input.payload,
          input.receivedAt,
          input.matchedTriggerName ?? null,
          input.droppedReason ?? null,
        ],
      );
      const inserted = insertedRows.rows[0];

      if (inserted !== undefined) {
        return {
          inserted: true,
          trigger: toTriggerRecord(inserted),
        };
      }

      const existing =
        input.signatureHash === null || input.signatureHash === undefined
          ? await this.findTriggerByDeliveryId(input.deliveryId, input.organizationId)
          : ((await this.findTriggerBySignatureHash(input.signatureHash)) ??
            (await this.findTriggerByDeliveryId(input.deliveryId, input.organizationId)));

      if (existing === undefined) {
        throw new Error(
          `trigger insert conflicted but no row was found for delivery ${input.deliveryId}`,
        );
      }

      return {
        inserted: false,
        trigger: existing,
      };
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async markTriggerDropped(id: string, reason: string): Promise<TriggerRecord> {
    try {
      const rows = await query<TriggerRow>(
        this.pool,
        `
          update triggers
          set dropped_reason = $2
          where id = $1 and dropped_reason is null
          returning *
        `,
        [id, reason],
      );
      const updated = rows.rows[0];

      if (updated !== undefined) {
        return toTriggerRecord(updated);
      }

      const existing = await this.findTriggerById(id);

      if (existing === undefined) {
        throw new Error(`trigger not found: ${id}`);
      }

      return existing;
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async claimTriggerDispatchPlan(
    id: string,
    plan: readonly LaunchMachineIntent[],
  ): Promise<{ plan: readonly LaunchMachineIntent[]; claimed: boolean }> {
    try {
      const rows = await query<TriggerRow>(
        this.pool,
        `update triggers
         set dispatch_plan = $2
         where id = $1 and dispatch_plan is null
         returning *`,
        [id, JSON.stringify(plan)],
      );
      const claimed = rows.rows[0];
      if (claimed !== undefined)
        return {
          plan: toTriggerRecord(claimed).dispatchPlan ?? [],
          claimed: true,
        };
      const existing = await this.findTriggerById(id);
      if (existing === undefined) throw new Error(`trigger not found: ${id}`);
      if (existing.dispatchPlan === null)
        throw new Error(`trigger dispatch plan unavailable: ${id}`);
      return { plan: existing.dispatchPlan, claimed: false };
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async transitionTriggerLifecycle(
    id: string,
    state: TriggerLifecycleState,
  ): Promise<{ trigger: TriggerRecord; transitioned: boolean }> {
    try {
      const rows = await query<TriggerRow>(
        this.pool,
        `update triggers
         set lifecycle_state = $2
         where id = $1
           and lifecycle_state is distinct from $2
           and (
             lifecycle_state is null
             or (lifecycle_state = 'accepted' and $2 in ('running', 'succeeded', 'failed'))
             or (lifecycle_state = 'running' and $2 in ('succeeded', 'failed'))
           )
         returning *`,
        [id, state],
      );
      const updated = rows.rows[0];
      if (updated !== undefined) return { trigger: toTriggerRecord(updated), transitioned: true };
      const existing = await this.findTriggerById(id);
      if (existing === undefined) throw new Error(`trigger not found: ${id}`);
      return { trigger: existing, transitioned: false };
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findTriggerByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<TriggerRecord | undefined> {
    try {
      const rows = await query<TriggerRow>(
        this.pool,
        organizationId === undefined
          ? "select * from triggers where delivery_id = $1 limit 1"
          : "select * from triggers where delivery_id = $1 and organization_id = $2 limit 1",
        organizationId === undefined ? [deliveryId] : [deliveryId, organizationId],
      );

      return rows.rows[0] === undefined ? undefined : toTriggerRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  private async findTriggerBySignatureHash(
    signatureHash: string,
  ): Promise<TriggerRecord | undefined> {
    try {
      const rows = await query<TriggerRow>(
        this.pool,
        "select * from triggers where signature_hash = $1 limit 1",
        [signatureHash],
      );

      return rows.rows[0] === undefined ? undefined : toTriggerRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async insertMachine(input: InsertMachineInput): Promise<MachineRecord> {
    try {
      const rows = await query<MachineRow>(
        this.pool,
        `
          insert into machines (
            org_id,
            source,
            status,
            trigger_name,
            trigger_context,
            specs
          )
          values ($1, $2, $3, $4, $5, $6)
          returning *
        `,
        [
          input.orgId,
          input.source,
          input.status ?? "spawning",
          input.triggerName ?? null,
          input.triggerContext ?? null,
          input.specs ?? null,
        ],
      );
      const machine = rows.rows[0];

      if (machine === undefined) {
        throw new Error("machine insert returned no row");
      }

      return toMachineRecord(machine);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findMachineById(id: string): Promise<MachineRecord | undefined> {
    try {
      const rows = await query<MachineRow>(
        this.pool,
        "select * from machines where id = $1 limit 1",
        [id],
      );

      return rows.rows[0] === undefined ? undefined : toMachineRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findMachineForOrganization(
    organizationId: string,
    id: string,
  ): Promise<MachineRecord | undefined> {
    try {
      const rows = await query<MachineRow>(
        this.pool,
        "select * from machines where id = $1 and org_id = $2 limit 1",
        [id, organizationId],
      );

      return rows.rows[0] === undefined ? undefined : toMachineRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async transitionMachine(
    id: string,
    toStatus: MachineStatus,
    fields?: TerminateMachineFields,
  ): Promise<MachineRecord> {
    try {
      const rows = await query<MachineRow>(
        this.pool,
        `
          update machines
          set
            status = $2::machine_status,
            terminated_at = case
              when $2::machine_status = 'terminated'::machine_status then now()
              else terminated_at
            end,
            shutdown_reason = case
              when $3::boolean then $4
              else shutdown_reason
            end
          where id = $1
          returning *
        `,
        [id, toStatus, fields !== undefined, fields?.reason ?? null],
      );
      const machine = rows.rows[0];

      if (machine === undefined) {
        throw new Error(`machine not found: ${id}`);
      }

      return toMachineRecord(machine);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async insertAgentExecution(input: InsertAgentExecutionInput): Promise<AgentExecutionRecord> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `
          insert into agent_executions (
            id,
            organization_id,
            project_id,
            machine_id,
            daemon_id,
            status,
            trigger_context,
            output_context,
            configuration_revision_id,
            completion_token_hash,
            deadline_at,
            idle_deadline_at,
            trigger_id,
            trigger_connection_id,
            trigger_resource_id,
            launch_intent,
            result,
            completed_at
          )
          select coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $16, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17,
                 case when $16 = 'failed'::agent_execution_status then now() else null end
          from projects
          where projects.id = $3 and projects.organization_id = $2 and projects.status = 'active'
            and exists (
              select 1 from project_configuration_revisions
              where id = $8 and project_id = $3 and organization_id = $2
            )
            and ($5::uuid is null or exists (
              select 1 from daemons daemon
              join machines daemon_machine on daemon_machine.id = daemon.machine_id
              where daemon.id = $5 and daemon_machine.org_id = $2
            ))
            and ($4::uuid is null or exists (
              select 1 from machines where id = $4 and org_id = $2
            ))
          returning *
        `,
        [
          input.id ?? null,
          input.organizationId,
          input.projectId,
          input.machineId,
          input.daemonId ?? null,
          input.triggerContext,
          input.outputContext,
          input.configurationRevisionId,
          input.completionTokenHash ?? null,
          input.deadlineAt ?? null,
          input.idleDeadlineAt ?? null,
          input.triggerId ?? null,
          input.triggerConnectionId ?? null,
          input.triggerResourceId ?? null,
          input.launchIntent ?? null,
          input.status ?? "spawning",
          input.result ?? null,
        ],
      );
      const execution = rows.rows[0];

      if (execution === undefined) {
        throw new Error("agent execution insert returned no row");
      }

      return toAgentExecutionRecord(execution);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async insertAgentExecutionIfAbsent(
    input: InsertAgentExecutionInput & { id: string },
  ): Promise<AgentExecutionRecord | undefined> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `
          insert into agent_executions (
            id,
            organization_id,
            project_id,
            machine_id,
            daemon_id,
            status,
            trigger_context,
            output_context,
            configuration_revision_id,
            completion_token_hash,
            deadline_at,
            idle_deadline_at,
            trigger_id,
            trigger_connection_id,
            trigger_resource_id,
            launch_intent,
            result,
            completed_at
          )
          select $1, $2, $3, $4, $5, $16, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17,
                 case when $16 = 'failed'::agent_execution_status then now() else null end
          from projects
          where projects.id = $3 and projects.organization_id = $2 and projects.status = 'active'
            and exists (
              select 1 from project_configuration_revisions
              where id = $8 and project_id = $3 and organization_id = $2
            )
            and ($5::uuid is null or exists (
              select 1 from daemons daemon
              join machines daemon_machine on daemon_machine.id = daemon.machine_id
              where daemon.id = $5 and daemon_machine.org_id = $2
            ))
            and ($4::uuid is null or exists (
              select 1 from machines where id = $4 and org_id = $2
            ))
          on conflict (id) do nothing
          returning *
        `,
        [
          input.id,
          input.organizationId,
          input.projectId,
          input.machineId,
          input.daemonId ?? null,
          input.triggerContext,
          input.outputContext,
          input.configurationRevisionId,
          input.completionTokenHash ?? null,
          input.deadlineAt ?? null,
          input.idleDeadlineAt ?? null,
          input.triggerId ?? null,
          input.triggerConnectionId ?? null,
          input.triggerResourceId ?? null,
          input.launchIntent ?? null,
          input.status ?? "spawning",
          input.result ?? null,
        ],
      );
      const execution = rows.rows[0];
      return execution === undefined ? undefined : toAgentExecutionRecord(execution);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async issueEnrollmentToken(input: EnrollmentTokenRecord): Promise<boolean> {
    if (input.issuedByApiKeyId === undefined || input.issuedByApiKeyId === null) {
      await query(
        this.pool,
        `insert into daemon_enrollment_tokens
           (id, verifier, organization_id, authorization_id, display_name,
            approved_by_user_id, issued_by_api_key_id, registration_method, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.id,
          input.verifier,
          input.organizationId,
          input.authorizationId ?? null,
          input.displayName ?? null,
          input.approvedByUserId ?? null,
          null,
          input.registrationMethod ?? "operator",
          input.expiresAt,
        ],
      );
      return true;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const key = await client.query(
        `select id
         from organization_api_keys
         where id = $1 and organization_id = $2 and revoked_at is null
         for update`,
        [input.issuedByApiKeyId, input.organizationId],
      );
      if (key.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `insert into daemon_enrollment_tokens
           (id, verifier, organization_id, authorization_id, display_name,
            approved_by_user_id, issued_by_api_key_id, registration_method, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.id,
          input.verifier,
          input.organizationId,
          input.authorizationId ?? null,
          input.displayName ?? null,
          input.approvedByUserId ?? null,
          input.issuedByApiKeyId,
          input.registrationMethod ?? "operator",
          input.expiresAt,
        ],
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async startDeviceAuthorization(
    input: StartDeviceAuthorizationInput,
  ): Promise<DeviceAuthorizationRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select pg_advisory_xact_lock(hashtext('paseo-device-authorization-issuance'))`,
      );
      const capacity = await client.query<{
        fingerprint_count: number;
        global_count: number;
      }>(
        `select
           count(*) filter (where fingerprint_verifier = $1)::integer as fingerprint_count,
           count(*)::integer as global_count
         from daemon_device_authorizations
         where status in ('pending', 'approved') and expires_at > now()`,
        [input.fingerprintVerifier],
      );
      const counts = capacity.rows[0]!;
      if (
        counts.fingerprint_count >= input.perFingerprintLimit ||
        counts.global_count >= input.globalLimit
      ) {
        await client.query("rollback");
        return undefined;
      }
      const inserted = await client.query<DeviceAuthorizationRow>(
        `insert into daemon_device_authorizations
           (id, device_verifier, user_code_verifier, fingerprint_verifier,
            suggested_display_name, status, poll_interval_seconds, next_poll_at, expires_at)
         values ($1, $2, $3, $4, $5, 'pending', $6, now(),
                 now() + ($7 * interval '1 second'))
         returning *`,
        [
          input.id,
          input.deviceVerifier,
          input.userCodeVerifier,
          input.fingerprintVerifier,
          input.suggestedDisplayName,
          input.pollIntervalSeconds,
          input.lifetimeSeconds,
        ],
      );
      await client.query("commit");
      return toDeviceAuthorization(inserted.rows[0]!);
    } catch (error) {
      await client.query("rollback");
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async inspectDeviceAuthorization(
    userCodeVerifier: string,
  ): Promise<DeviceAuthorizationRecord | undefined> {
    await query(
      this.pool,
      `update daemon_device_authorizations set status = 'expired'
       where user_code_verifier = $1 and status in ('pending', 'approved')
         and expires_at <= now()`,
      [userCodeVerifier],
    );
    const rows = await query<DeviceAuthorizationRow>(
      this.pool,
      `select * from daemon_device_authorizations
       where user_code_verifier = $1 and status = 'pending' and expires_at > now()`,
      [userCodeVerifier],
    );
    return rows.rows[0] === undefined ? undefined : toDeviceAuthorization(rows.rows[0]);
  }

  async decideDeviceAuthorization(
    input: DeviceAuthorizationDecisionInput,
  ): Promise<"approved" | "denied" | "unavailable" | "forbidden"> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update daemon_device_authorizations set status = 'expired'
         where user_code_verifier = $1 and status in ('pending', 'approved')
           and expires_at <= now()`,
        [input.userCodeVerifier],
      );
      const authorization = await client.query<DeviceAuthorizationRow>(
        `select * from daemon_device_authorizations
         where user_code_verifier = $1 and status = 'pending' and expires_at > now()
         for update`,
        [input.userCodeVerifier],
      );
      if (authorization.rows[0] === undefined) {
        await client.query("rollback");
        return "unavailable";
      }
      const authority = await client.query(
        `select 1
         from session
         join member on member.id = $3 and member.user_id = session.user_id
           and member.organization_id = session.active_organization_id
         where session.id = $1 and session.user_id = $2
           and session.active_organization_id = $4 and session.expires_at > now()
           and member.role in ('owner', 'admin')
         for update of session, member`,
        [
          input.access.sessionId,
          input.access.userId,
          input.access.membershipId,
          input.access.organizationId,
        ],
      );
      if (authority.rowCount !== 1) {
        await client.query("rollback");
        return "forbidden";
      }
      const status = input.decision === "approve" ? "approved" : "denied";
      await client.query(
        `update daemon_device_authorizations
         set status = $2, approved_organization_id = case when $2 = 'approved' then $3 end,
             approved_by_user_id = case when $2 = 'approved' then $4 end,
             approved_display_name = case when $2 = 'approved' then $5 end,
             decided_at = now()
         where id = $1`,
        [
          authorization.rows[0].id,
          status,
          input.access.organizationId,
          input.access.userId,
          input.decision === "approve" ? input.displayName : null,
        ],
      );
      await client.query("commit");
      return status;
    } catch (error) {
      await client.query("rollback");
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async pollDeviceAuthorization(input: {
    deviceVerifier: string;
    enrollmentTokenVerifier: string;
  }): Promise<DevicePollResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<DeviceAuthorizationRow>(
        `select *, now() as database_now
         from daemon_device_authorizations where device_verifier = $1 for update`,
        [input.deviceVerifier],
      );
      const authorization = selected.rows[0];
      if (authorization !== undefined && authorization.expires_at <= authorization.database_now) {
        await client.query(
          `update daemon_device_authorizations set status = 'expired' where id = $1`,
          [authorization.id],
        );
        await client.query("commit");
        return {
          status: "expired",
          intervalSeconds: authorization.poll_interval_seconds,
        };
      }
      if (authorization === undefined) {
        await client.query("rollback");
        return { status: "expired", intervalSeconds: 5 };
      }
      if (
        authorization.status === "denied" ||
        authorization.status === "expired" ||
        authorization.status === "enrolled"
      ) {
        await client.query("commit");
        return {
          status: authorization.status,
          intervalSeconds: authorization.poll_interval_seconds,
        };
      }
      if (authorization.next_poll_at > authorization.database_now) {
        const intervalSeconds = authorization.poll_interval_seconds + 5;
        await client.query(
          `update daemon_device_authorizations
           set poll_interval_seconds = $2, next_poll_at = now() + ($2 * interval '1 second')
           where id = $1`,
          [authorization.id, intervalSeconds],
        );
        await client.query("commit");
        return { status: "slow_down", intervalSeconds };
      }
      await client.query(
        `update daemon_device_authorizations
         set next_poll_at = now() + (poll_interval_seconds * interval '1 second')
         where id = $1`,
        [authorization.id],
      );
      if (authorization.status === "approved") {
        const token = await client.query<{ id: string }>(
          `insert into daemon_enrollment_tokens
             (id, verifier, organization_id, authorization_id, display_name,
              approved_by_user_id, registration_method, expires_at)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, 'device', $6)
           on conflict (authorization_id) do update set verifier = excluded.verifier
           returning id`,
          [
            input.enrollmentTokenVerifier,
            authorization.approved_organization_id,
            authorization.id,
            authorization.approved_display_name,
            authorization.approved_by_user_id,
            authorization.expires_at,
          ],
        );
        await client.query(
          `update daemon_device_authorizations set enrollment_token_id = $2 where id = $1`,
          [authorization.id, token.rows[0]!.id],
        );
      }
      await client.query("commit");
      return {
        status: authorization.status,
        intervalSeconds: authorization.poll_interval_seconds,
      };
    } catch (error) {
      await client.query("rollback");
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async enrollDaemon(input: EnrollDaemonInput): Promise<DaemonRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<DaemonRow>(
        `select * from daemons where idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (
        existing.rows[0] &&
        existing.rows[0].id === input.daemonId &&
        existing.rows[0].enrollment_verifier === input.tokenVerifier
      ) {
        await client.query("commit");
        return toDaemon(existing.rows[0]);
      }
      const token = await client.query<{
        id: string;
        organization_id: string | null;
        authorization_id: string | null;
        display_name: string | null;
        approved_by_user_id: string | null;
        issued_by_api_key_id: string | null;
        registration_method: "operator" | "device";
      }>(
        `update daemon_enrollment_tokens
         set consumed_at = case when registration_method = 'device' then now() else $2 end
         where verifier = $1 and organization_id is not null and consumed_at is null
           and expires_at > case when registration_method = 'device' then now() else $2 end
         returning id, organization_id, authorization_id, display_name,
                   approved_by_user_id, issued_by_api_key_id, registration_method`,
        [input.tokenVerifier, input.now],
      );
      const consumedToken = token.rows[0];
      if (consumedToken?.organization_id === null || consumedToken === undefined) {
        await client.query("rollback");
        return undefined;
      }
      const machine = await client.query<MachineRow>(
        `insert into machines (org_id, source, status) values ($1, $2, 'alive') returning *`,
        [consumedToken.organization_id, { kind: "daemon", daemonId: input.daemonId }],
      );
      const slug = `daemon-${input.daemonId.slice(0, 8)}`;
      const daemon = await client.query<DaemonRow>(
        `insert into daemons
           (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id, server_id,
            daemon_public_key, credential_verifier, scopes, display_name,
            approved_by_user_id, registered_by_api_key_id, registration_method, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active') returning *`,
        [
          input.daemonId,
          input.idempotencyKey,
          input.tokenVerifier,
          slug,
          machine.rows[0]!.id,
          consumedToken.organization_id,
          input.serverId,
          input.daemonPublicKey,
          input.credentialVerifier,
          JSON.stringify(input.scopes),
          consumedToken.display_name,
          consumedToken.approved_by_user_id,
          consumedToken.issued_by_api_key_id,
          consumedToken.registration_method,
        ],
      );
      if (consumedToken.authorization_id !== null) {
        await client.query(
          `update daemon_device_authorizations
           set status = 'enrolled', enrolled_daemon_id = $2
           where id = $1 and status = 'approved'`,
          [consumedToken.authorization_id, input.daemonId],
        );
      }
      await client.query("commit");
      return toDaemon(daemon.rows[0]!);
    } catch (error) {
      await client.query("rollback");
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async findDaemonBySlugForOrganization(
    organizationId: string,
    slug: string,
  ): Promise<DaemonRecord | undefined> {
    const rows = await query<DaemonRow>(
      this.pool,
      `select daemons.* from daemons
       join machines on machines.id = daemons.machine_id
       where machines.org_id = $1 and daemons.slug = $2
       limit 2`,
      [organizationId, slug],
    );
    if (rows.rows.length > 1) {
      throw new Error("daemon organization slug invariant violated");
    }
    return rows.rows[0] ? toDaemon(rows.rows[0]) : undefined;
  }

  async findDaemonById(id: string): Promise<DaemonRecord | undefined> {
    const rows = await query<DaemonRow>(this.pool, `select * from daemons where id = $1`, [id]);
    return rows.rows[0] ? toDaemon(rows.rows[0]) : undefined;
  }

  async findDaemonForOrganization(
    organizationId: string,
    id: string,
  ): Promise<DaemonRecord | undefined> {
    const rows = await query<DaemonRow>(
      this.pool,
      `select daemons.*
       from daemons
       inner join machines on machines.id = daemons.machine_id
       where daemons.id = $1 and machines.org_id = $2
       limit 1`,
      [id, organizationId],
    );
    return rows.rows[0] ? toDaemon(rows.rows[0]) : undefined;
  }

  async listDaemonsForOrganization(organizationId: string): Promise<DaemonRecord[]> {
    const rows = await query<DaemonRow>(
      this.pool,
      `select daemons.* from daemons
       join machines on machines.id = daemons.machine_id
       where machines.org_id = $1
       order by lower(coalesce(daemons.display_name, daemons.slug)), daemons.id`,
      [organizationId],
    );
    return rows.rows.map(toDaemon);
  }

  async renameDaemonForOrganization(
    organizationId: string,
    id: string,
    displayName: string,
  ): Promise<DaemonRecord | undefined> {
    const rows = await query<DaemonRow>(
      this.pool,
      `update daemons set display_name = $3
       from machines
       where daemons.id = $2 and machines.id = daemons.machine_id and machines.org_id = $1
       returning daemons.*`,
      [organizationId, id, displayName],
    );
    return rows.rows[0] === undefined ? undefined : toDaemon(rows.rows[0]);
  }

  async touchDaemon(id: string): Promise<void> {
    await query(this.pool, `update daemons set last_seen_at = now() where id = $1`, [id]);
  }

  async setDaemonPresence(id: string, presence: "offline" | "connected"): Promise<void> {
    await query(
      this.pool,
      `update daemons set presence = $2, connected_at = case when $2 = 'connected' then now() else connected_at end, disconnected_at = case when $2 = 'offline' then now() else disconnected_at end where id = $1`,
      [id, presence],
    );
  }

  async revokeDaemon(id: string): Promise<boolean> {
    const rows = await query(
      this.pool,
      `update daemons set status = 'revoked', presence = 'offline', disconnected_at = now() where id = $1 and status = 'active' returning id`,
      [id],
    );
    return rows.rowCount === 1;
  }

  async attachAgentToExecution(
    executionId: string,
    daemonId: string,
    agentId: string,
  ): Promise<AgentExecutionRecord> {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      `update agent_executions set daemon_id = $2, daemon_agent_id = $3 where id = $1 returning *`,
      [executionId, daemonId, agentId],
    );
    if (!rows.rows[0]) throw new Error(`agent execution not found: ${executionId}`);
    return toAgentExecutionRecord(rows.rows[0]);
  }

  async setAgentExecutionIdleDeadline(
    executionId: string,
    idleDeadlineAt: Date | null,
  ): Promise<AgentExecutionRecord> {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      `update agent_executions
       set idle_deadline_at = $2
       where id = $1 and status in ('spawning', 'running')
       returning *`,
      [executionId, idleDeadlineAt],
    );
    const row = rows.rows[0];
    if (row !== undefined) return toAgentExecutionRecord(row);
    const execution = await this.findAgentExecutionById(executionId);
    if (execution === undefined) throw new Error(`agent execution not found: ${executionId}`);
    return execution;
  }

  async findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        "select * from agent_executions where id = $1 limit 1",
        [id],
      );

      return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findAgentExecutionForOrganization(
    organizationId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `select * from agent_executions
         where id = $1 and organization_id = $2 limit 1`,
        [id, organizationId],
      );

      return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findAgentExecutionForProject(projectId: string, id: string) {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      `select * from agent_executions where id = $1 and project_id = $2 limit 1`,
      [id, projectId],
    );
    return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
  }

  async findAgentExecutionByTriggerId(
    triggerId: string,
  ): Promise<AgentExecutionRecord | undefined> {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      "select * from agent_executions where trigger_id = $1 limit 1",
      [triggerId],
    );
    return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
  }

  async findAgentExecutionsByTriggerId(triggerId: string): Promise<AgentExecutionRecord[]> {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      "select * from agent_executions where trigger_id = $1 order by started_at, id",
      [triggerId],
    );
    return rows.rows.map(toAgentExecutionRecord);
  }

  async listAgentExecutionsForProject(projectId: string, limit: number) {
    const rows = await query<AgentExecutionRow>(
      this.pool,
      `select * from agent_executions where project_id = $1
       order by started_at desc, id desc limit $2`,
      [projectId, limit],
    );
    return rows.rows.map(toAgentExecutionRecord);
  }

  async listTriggersForProject(projectId: string, limit: number) {
    const rows = await query<TriggerRow>(
      this.pool,
      `select * from triggers where project_id = $1
       order by received_at desc, id desc limit $2`,
      [projectId, limit],
    );
    return rows.rows.map(toTriggerRecord);
  }

  async claimAgentExecutionReply(
    executionId: string,
    maxReplies: number,
    claimedAt: Date,
  ): Promise<boolean> {
    const rows = await query(
      this.pool,
      `update agent_executions
       set reply_claimed_at = coalesce(reply_claimed_at, $3),
           reply_claim_count = reply_claim_count + 1
       where id = $1
         and reply_claim_count < $2
         and status in ('spawning', 'running')
       returning id`,
      [executionId, maxReplies, claimedAt],
    );
    return rows.rowCount === 1;
  }

  async transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields: TransitionAgentExecutionFields = {},
  ): Promise<TransitionAgentExecutionResult> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `
          update agent_executions
          set
            status = $2,
            completed_at = case
              when $2 = any($3::agent_execution_status[]) then now()
              else completed_at
            end,
            result = case when $4::boolean then $5 else result end,
            completed_by_agent_at = case
              when $6::boolean and $2 = 'succeeded'::agent_execution_status then now()
              else completed_by_agent_at
            end,
            idle_deadline_at = case
              when $2 = any($3::agent_execution_status[]) then null
              else idle_deadline_at
            end,
            hub_action = case when $10::boolean then $11 else hub_action end,
            hub_action_completed_at = case
              when $10::boolean and $11::text is null then now()
              when $10::boolean then null
              else hub_action_completed_at
            end
          where id = $1
            and status in ('spawning', 'running')
            and (
              $7::text is null
              or ($7 = 'hard' and deadline_at = $8 and deadline_at <= $9)
              or ($7 = 'idle' and idle_deadline_at = $8 and idle_deadline_at <= $9)
            )
          returning *
        `,
        [
          id,
          toStatus,
          TERMINAL_AGENT_EXECUTION_STATUSES,
          fields.result !== undefined,
          fields.result ?? null,
          fields.completedByAgent === true,
          fields.deadlineCondition?.kind ?? null,
          fields.deadlineCondition?.deadlineAt ?? null,
          fields.deadlineCondition?.observedAt ?? null,
          fields.hubAction !== undefined,
          fields.hubAction ?? null,
        ],
      );
      const execution = rows.rows[0];

      if (execution === undefined) {
        const existing = await this.findAgentExecutionById(id);
        if (existing === undefined) {
          throw new Error(`agent execution not found: ${id}`);
        }

        return { execution: existing, transitioned: false };
      }

      return {
        execution: toAgentExecutionRecord(execution),
        transitioned: true,
      };
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `
          select *
          from agent_executions
          where machine_id = $1
            and status in ('spawning', 'running')
          order by started_at asc
        `,
        [machineId],
      );

      return rows.rows.map(toAgentExecutionRecord);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findPendingAgentExecutions(): Promise<AgentExecutionRecord[]> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        "select * from agent_executions where status in ('spawning', 'running') order by started_at asc",
      );
      return rows.rows.map(toAgentExecutionRecord);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findPendingHubActions(daemonId?: string): Promise<AgentExecutionRecord[]> {
    try {
      const rows = await query<AgentExecutionRow>(
        this.pool,
        `select * from agent_executions
         where hub_action is not null
           and hub_action_completed_at is null
           and ($1::uuid is null or daemon_id = $1)
         order by completed_at asc`,
        [daemonId ?? null],
      );
      return rows.rows.map(toAgentExecutionRecord);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async completeHubAction(executionId: string, action: "interrupt" | "archive"): Promise<boolean> {
    try {
      const rows = await query(
        this.pool,
        `update agent_executions
         set hub_action_completed_at = now()
         where id = $1 and hub_action = $2 and hub_action_completed_at is null
         returning id`,
        [executionId, action],
      );
      return rows.rowCount === 1;
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const rows = await query<ProjectRow>(
      this.pool,
      `insert into projects (organization_id, name, slug, created_by_user_id)
       select $1, $2, $3, $4
       where exists (
         select 1 from member where organization_id = $1 and user_id = $4
       )
       returning *`,
      [input.organizationId, input.name, input.slug, input.createdByUserId],
    );
    const project = rows.rows[0];
    if (project === undefined) throw new Error("project access denied");
    await query(
      this.pool,
      `insert into project_configuration_sources
         (project_id, organization_id, kind, automatic_deployment_enabled, selected_by_user_id)
       values ($1, $2, 'manual', false, $3)`,
      [project.id, input.organizationId, input.createdByUserId],
    );
    return toProjectRecord(project);
  }

  async listProjectsForOrganization(organizationId: string): Promise<ProjectRecord[]> {
    const rows = await query<ProjectRow>(
      this.pool,
      `select * from projects where organization_id = $1 order by name, id`,
      [organizationId],
    );
    return rows.rows.map(toProjectRecord);
  }

  async findProjectForOrganization(organizationId: string, projectId: string) {
    const rows = await query<ProjectRow>(
      this.pool,
      `select * from projects where organization_id = $1 and id = $2 limit 1`,
      [organizationId, projectId],
    );
    return rows.rows[0] === undefined ? undefined : toProjectRecord(rows.rows[0]);
  }

  async findProjectById(projectId: string) {
    const rows = await query<ProjectRow>(this.pool, `select * from projects where id = $1`, [
      projectId,
    ]);
    return rows.rows[0] === undefined ? undefined : toProjectRecord(rows.rows[0]);
  }

  async findProjectBySlugForOrganization(organizationId: string, slug: string) {
    const rows = await query<ProjectRow>(
      this.pool,
      `select * from projects where organization_id = $1 and slug = $2 limit 1`,
      [organizationId, slug],
    );
    return rows.rows[0] === undefined ? undefined : toProjectRecord(rows.rows[0]);
  }

  async resolveTenantRouteAccess(userId: string, organizationSlug: string, projectSlug?: string) {
    const rows = await query<TenantRouteAccessRow>(
      this.pool,
      `select organization.id as organization_id,
              organization.name as organization_name,
              organization.slug as organization_slug,
              member.id as membership_id,
              member.role as membership_role,
              projects.id as project_id,
              projects.organization_id as project_organization_id,
              projects.name as project_name,
              projects.slug as project_slug,
              projects.status as project_status,
              projects.created_by_user_id as project_created_by_user_id,
              projects.created_at as project_created_at,
              projects.updated_at as project_updated_at,
              projects.archived_at as project_archived_at,
              projects.active_configuration_revision_id as project_active_configuration_revision_id
       from organization
       join member on member.organization_id = organization.id and member.user_id = $1
       left join projects on projects.organization_id = organization.id
         and projects.slug = $3 and projects.status = 'active'
       where organization.slug = $2
         and ($3::text is null or projects.id is not null)
       limit 1`,
      [userId, organizationSlug, projectSlug ?? null],
    );
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return {
      organization: {
        id: row.organization_id,
        name: row.organization_name,
        slug: row.organization_slug,
      },
      membership: { id: row.membership_id, role: row.membership_role },
      ...(row.project_id === null
        ? {}
        : {
            project: toProjectRecord({
              id: row.project_id,
              organization_id: row.project_organization_id!,
              name: row.project_name!,
              slug: row.project_slug!,
              status: row.project_status!,
              created_by_user_id: row.project_created_by_user_id,
              created_at: row.project_created_at!,
              updated_at: row.project_updated_at!,
              archived_at: row.project_archived_at,
              active_configuration_revision_id: row.project_active_configuration_revision_id,
            }),
          }),
    };
  }

  async archiveProject(organizationId: string, projectId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const access = await client.query<ProjectRow>(
        `select projects.*
         from projects
         join member on member.organization_id = projects.organization_id
         where projects.id = $1 and projects.organization_id = $2
           and member.user_id = $3 and member.role in ('owner', 'admin')
         for update of projects`,
        [projectId, organizationId, userId],
      );
      if (access.rows[0] === undefined) throw new Error("project access denied");
      await client.query(
        `update project_configuration_sources
         set kind = 'manual', github_connection_id = null, github_repository_id = null,
             github_repository_full_name = null, github_default_branch = null,
             automatic_deployment_enabled = false, updated_at = clock_timestamp()
         where project_id = $1`,
        [projectId],
      );
      await client.query(`delete from project_trigger_routes where project_id = $1`, [projectId]);
      const archived = await client.query<ProjectRow>(
        `update projects
         set status = 'archived', active_configuration_revision_id = null,
             archived_at = clock_timestamp(), updated_at = clock_timestamp()
         where id = $1 returning *`,
        [projectId],
      );
      await client.query(
        `insert into audit_events
           (organization_id, project_id, actor_kind, actor_identity, action,
            subject_type, subject_id, evidence)
         values ($1, $2, 'user', $3, 'project.archived', 'project', $4,
                 '{"releasedRoutes":true}')`,
        [organizationId, projectId, userId, projectId],
      );
      await client.query("commit");
      return toProjectRecord(archived.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async updateProjectSlug(organizationId: string, projectId: string, slug: string, userId: string) {
    const rows = await query<ProjectRow>(
      this.pool,
      `update projects
       set slug = $3, updated_at = clock_timestamp()
       where id = $2 and organization_id = $1
         and exists (
           select 1 from member
           where organization_id = $1 and user_id = $4 and role in ('owner', 'admin')
         )
       returning *`,
      [organizationId, projectId, slug, userId],
    );
    if (rows.rows[0] === undefined) throw new Error("project access denied");
    return toProjectRecord(rows.rows[0]);
  }

  async insertProjectConfigurationRevision(
    input: InsertProjectConfigurationRevisionInput,
  ): Promise<ProjectConfigurationRevisionRecord> {
    const rows = await query<ProjectConfigurationRevisionRow>(
      this.pool,
      `insert into project_configuration_revisions (
         project_id, organization_id, version, source_kind, source_evidence, raw_yaml,
         normalized_configuration, validation_errors, content_hash,
         created_by_user_id, received_at, validated_at
       ) select
         $1,
         projects.organization_id,
         coalesce((select max(version) + 1 from project_configuration_revisions where project_id = $1), 1),
         $2, $3, $4, $5, $6, $7, $8, clock_timestamp(),
         case when $6::jsonb is null then clock_timestamp() else null end
       from projects
       where projects.id = $1 and projects.status = 'active'
       returning *`,
      [
        input.projectId,
        input.sourceKind,
        input.sourceEvidence,
        input.rawYaml ?? null,
        input.normalizedConfiguration,
        input.validationErrors ?? null,
        input.contentHash,
        input.createdByUserId ?? null,
      ],
    );
    return toProjectConfigurationRevisionRecord(rows.rows[0]!);
  }

  async activateProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
    routes?: readonly ProjectTriggerRoute[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const revision = await lockValidProjectRevision(client, projectId, revisionId);
      const compiledRoutes =
        routes ??
        (
          await client.query<{
            provider: ConnectionProvider;
            connection_id: string;
            resource_id: string | null;
            trigger_name: string;
          }>(
            `select provider, connection_id, resource_id, trigger_name
             from project_trigger_routes where configuration_revision_id = $1`,
            [revisionId],
          )
        ).rows.map((row) => ({
          provider: row.provider,
          connectionId: row.connection_id,
          resourceId: row.resource_id,
          triggerName: row.trigger_name,
        }));
      await client.query(`delete from project_trigger_routes where project_id = $1`, [projectId]);
      for (const route of compiledRoutes) {
        await client.query(
          `insert into project_trigger_routes
             (organization_id, project_id, configuration_revision_id, provider,
              connection_id, resource_id, trigger_name)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            revision.organization_id,
            projectId,
            revisionId,
            route.provider,
            route.connectionId,
            route.resourceId,
            route.triggerName,
          ],
        );
      }
      await client.query(
        `update projects
         set active_configuration_revision_id = $2, updated_at = clock_timestamp()
         where id = $1`,
        [projectId, revisionId],
      );
      await client.query(
        `insert into audit_events
           (organization_id, project_id, actor_kind, actor_identity, action,
            subject_type, subject_id, evidence)
         select organization_id, id, 'system', 'configuration', 'configuration.activated',
                'configuration_revision', $2::text, jsonb_build_object('version', $3::integer)
         from projects where id = $1`,
        [projectId, revisionId, revision.version],
      );
      await client.query("commit");
      return toProjectConfigurationRevisionRecord(revision);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async findProjectConfigurationRollbackTarget(projectId: string) {
    const candidates = await query<ProjectConfigurationRevisionRow>(
      this.pool,
      `select prior.*
       from projects
       join project_configuration_revisions current
         on current.id = projects.active_configuration_revision_id
       join lateral (
         select * from project_configuration_revisions
         where project_id = projects.id and version < current.version
           and validation_errors is null
         order by version desc limit 1
       ) prior on true
       where projects.id = $1`,
      [projectId],
    );
    return candidates.rows[0] === undefined
      ? undefined
      : toProjectConfigurationRevisionRecord(candidates.rows[0]);
  }

  async rollbackProjectConfiguration(
    projectId: string,
    targetRevisionId: string,
    routes: readonly ProjectTriggerRoute[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const candidates = await client.query<ProjectConfigurationRevisionRow>(
        `select prior.*
         from projects
         join project_configuration_revisions current
           on current.id = projects.active_configuration_revision_id
         join lateral (
           select * from project_configuration_revisions
           where project_id = projects.id and version < current.version
             and validation_errors is null and id = $2
           order by version desc limit 1
         ) prior on true
         where projects.id = $1
         for update of projects`,
        [projectId, targetRevisionId],
      );
      const target = candidates.rows[0];
      if (target === undefined) throw new Error("configuration rollback target changed");
      await client.query(`delete from project_trigger_routes where project_id = $1`, [projectId]);
      for (const route of routes) {
        await client.query(
          `insert into project_trigger_routes
             (organization_id, project_id, configuration_revision_id, provider,
              connection_id, resource_id, trigger_name)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            target.organization_id,
            projectId,
            target.id,
            route.provider,
            route.connectionId,
            route.resourceId,
            route.triggerName,
          ],
        );
      }
      await client.query(
        `update projects set active_configuration_revision_id = $2, updated_at = clock_timestamp()
         where id = $1`,
        [projectId, target.id],
      );
      await client.query("commit");
      return toProjectConfigurationRevisionRecord(target);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async findActiveProjectConfiguration(projectId: string) {
    const rows = await query<ProjectConfigurationRevisionRow>(
      this.pool,
      `select revisions.*
       from projects
       join project_configuration_revisions revisions
         on revisions.id = projects.active_configuration_revision_id
       where projects.id = $1`,
      [projectId],
    );
    return rows.rows[0] === undefined
      ? undefined
      : toProjectConfigurationRevisionRecord(rows.rows[0]);
  }

  async findProjectConfigurationRevision(projectId: string, revisionId: string) {
    const rows = await query<ProjectConfigurationRevisionRow>(
      this.pool,
      `select * from project_configuration_revisions where project_id = $1 and id = $2`,
      [projectId, revisionId],
    );
    return rows.rows[0] === undefined
      ? undefined
      : toProjectConfigurationRevisionRecord(rows.rows[0]);
  }

  async switchProjectConfigurationToManual(
    input: SwitchProjectConfigurationToManualInput,
  ): Promise<ProjectConfigurationRevisionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const project = await client.query<ProjectRow>(
        `select project.*
         from projects project
         join member on member.organization_id = project.organization_id
         where project.id = $1 and project.status = 'active'
           and member.user_id = $2 and member.role in ('owner', 'admin')
           and project.active_configuration_revision_id is not null
         for update of project`,
        [input.projectId, input.userId],
      );
      const projectRow = project.rows[0];
      if (projectRow === undefined) throw new Error("project access denied");
      const inserted = await client.query<ProjectConfigurationRevisionRow>(
        `insert into project_configuration_revisions (
           project_id, organization_id, version, source_kind, source_evidence, raw_yaml,
           normalized_configuration, content_hash, created_by_user_id, received_at, validated_at
         ) values (
           $1, $2,
           coalesce((select max(version) + 1 from project_configuration_revisions where project_id = $1), 1),
           'manual', jsonb_build_object(
             'kind', 'authority-switch', 'fromRevisionId', $3::text,
             'formattingPreserved', $8::boolean
           ), $4, $5, $6, $7, clock_timestamp(), clock_timestamp()
         ) returning *`,
        [
          input.projectId,
          projectRow.organization_id,
          projectRow.active_configuration_revision_id,
          input.rawYaml,
          input.normalizedConfiguration,
          input.contentHash,
          input.userId,
          input.formattingPreserved,
        ],
      );
      const revision = inserted.rows[0]!;
      await client.query(
        `update project_configuration_sources
         set kind = 'manual', github_connection_id = null, github_repository_id = null,
             github_repository_full_name = null, github_default_branch = null,
             automatic_deployment_enabled = false, selected_by_user_id = $2,
             updated_at = clock_timestamp()
         where project_id = $1`,
        [input.projectId, input.userId],
      );
      await client.query(`delete from project_trigger_routes where project_id = $1`, [
        input.projectId,
      ]);
      for (const route of input.routes) {
        await client.query(
          `insert into project_trigger_routes
             (organization_id, project_id, configuration_revision_id, provider,
              connection_id, resource_id, trigger_name)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            revision.organization_id,
            input.projectId,
            revision.id,
            route.provider,
            route.connectionId,
            route.resourceId,
            route.triggerName,
          ],
        );
      }
      await client.query(
        `update projects set active_configuration_revision_id = $2,
             updated_at = clock_timestamp() where id = $1`,
        [input.projectId, revision.id],
      );
      await client.query("commit");
      return toProjectConfigurationRevisionRecord(revision);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void> {
    const result = await query(
      this.pool,
      `insert into project_configuration_sources
         (organization_id, project_id, kind, github_connection_id, github_repository_id,
          github_repository_full_name, github_default_branch,
          automatic_deployment_enabled, selected_by_user_id)
       select p.organization_id, p.id, 'github', $2, r.repository_id,
              r.full_name, r.default_branch, $4, $5
       from projects p
       join member m on m.organization_id = p.organization_id
       join github_repositories r
         on r.organization_id = p.organization_id and r.connection_id = $2
        and r.repository_id = $3
       join github_connections c
         on c.id = r.connection_id and c.organization_id = p.organization_id
       where p.id = $1 and p.status = 'active'
         and m.user_id = $5 and m.role in ('owner', 'admin')
       on conflict (project_id) do update
         set kind = 'github',
             github_connection_id = excluded.github_connection_id,
             github_repository_id = excluded.github_repository_id,
             github_repository_full_name = excluded.github_repository_full_name,
             github_default_branch = excluded.github_default_branch,
             automatic_deployment_enabled = excluded.automatic_deployment_enabled,
             selected_by_user_id = excluded.selected_by_user_id,
             updated_at = clock_timestamp()
       returning project_id`,
      [
        input.projectId,
        input.githubConnectionId,
        input.githubRepositoryId,
        input.automaticDeploymentEnabled,
        input.userId,
      ],
    );
    if (result.rowCount !== 1) throw new Error("project access denied");
  }

  async recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord> {
    const result = await query<{
      id: string;
      project_id: string;
      github_connection_id: string | null;
      github_repository_id: number | null;
      webhook_delivery_id: string | null;
      commit_sha: string | null;
      outcome: string;
      evidence: unknown;
      created_at: Date;
    }>(
      this.pool,
      `insert into configuration_sync_attempts
         (organization_id, project_id, github_connection_id, github_repository_id,
          webhook_delivery_id, commit_sha, outcome, evidence)
       select p.organization_id, p.id, $2, $3, $4, $5, $6, $7::jsonb
       from projects p
       where p.id = $1 and p.organization_id = (select organization_id from github_connections where id = $2)
       returning id, project_id, github_connection_id, github_repository_id, webhook_delivery_id,
                 commit_sha, outcome, evidence, created_at`,
      [
        input.projectId,
        input.githubConnectionId,
        input.githubRepositoryId,
        input.webhookDeliveryId,
        input.commitSha,
        input.outcome,
        JSON.stringify(input.evidence),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("configuration source unavailable");
    return {
      id: row.id,
      projectId: row.project_id,
      githubConnectionId: row.github_connection_id,
      githubRepositoryId: row.github_repository_id,
      webhookDeliveryId: row.webhook_delivery_id,
      commitSha: row.commit_sha,
      outcome: row.outcome,
      evidence: row.evidence,
      createdAt: row.created_at,
    };
  }

  async projectConfigurationReadModel(projectId: string): Promise<ProjectConfigurationReadModel> {
    const source = await query<{
      kind: "manual" | "github";
      github_connection_id: string | null;
      github_repository_id: number | null;
      github_repository_full_name: string | null;
      github_default_branch: string | null;
      automatic_deployment_enabled: boolean;
    }>(
      this.pool,
      `select kind, github_connection_id, github_repository_id, github_repository_full_name,
              github_default_branch, automatic_deployment_enabled
       from project_configuration_sources where project_id = $1`,
      [projectId],
    );
    const sourceRow = source.rows[0];
    if (sourceRow === undefined) throw new Error("configuration authority not found");
    const activeRevision = (await this.findActiveProjectConfiguration(projectId)) ?? null;
    const attempts = await query<{
      id: string;
      project_id: string;
      github_connection_id: string | null;
      github_repository_id: number | null;
      webhook_delivery_id: string | null;
      commit_sha: string | null;
      outcome: string;
      evidence: unknown;
      created_at: Date;
    }>(
      this.pool,
      `select * from configuration_sync_attempts
       where project_id = $1 order by created_at desc, id desc limit 1`,
      [projectId],
    );
    const attempt = attempts.rows[0];
    const lastSyncAttempt =
      attempt === undefined
        ? null
        : {
            id: attempt.id,
            projectId: attempt.project_id,
            githubConnectionId: attempt.github_connection_id,
            githubRepositoryId: attempt.github_repository_id,
            webhookDeliveryId: attempt.webhook_delivery_id,
            commitSha: attempt.commit_sha,
            outcome: attempt.outcome,
            evidence: attempt.evidence,
            createdAt: attempt.created_at,
          };
    if (sourceRow.kind === "manual") {
      const evidence = activeRevision?.sourceEvidence;
      const formattingPreserved =
        typeof evidence === "object" &&
        evidence !== null &&
        "formattingPreserved" in evidence &&
        evidence.formattingPreserved === true;
      return {
        authority: "manual",
        activeRevision,
        lastSyncAttempt,
        sourceState: { kind: "manual", formattingPreserved },
      };
    }
    if (
      sourceRow.github_connection_id === null ||
      sourceRow.github_repository_id === null ||
      sourceRow.github_repository_full_name === null ||
      sourceRow.github_default_branch === null
    ) {
      throw new Error("github configuration authority has no repository");
    }
    return {
      authority: "github",
      activeRevision,
      lastSyncAttempt,
      sourceState: {
        kind: "github",
        githubConnectionId: sourceRow.github_connection_id,
        githubRepositoryId: sourceRow.github_repository_id,
        githubRepositoryFullName: sourceRow.github_repository_full_name,
        githubDefaultBranch: sourceRow.github_default_branch,
        automaticDeploymentEnabled: sourceRow.automatic_deployment_enabled,
      },
    };
  }

  async organizationConnectionUsage(organizationId: string): Promise<OrganizationConnectionUsage> {
    const github = await query<{
      id: string;
      organization_id: string;
      slug: string;
      installation_id: number | string;
      account_id: string;
      account_login: string;
      account_type: string;
      status: "active" | "suspended";
    }>(
      this.pool,
      `select connection.id, connection.organization_id, connection.slug,
              connection.installation_id,
              connection.account_id, connection.account_login, connection.account_type,
              connection.status
       from github_connections connection
       where connection.organization_id = $1
       order by connection.account_login, connection.id`,
      [organizationId],
    );
    const [discord, slack] = await Promise.all([
      query<{
        id: string;
        organization_id: string;
        slug: string;
        guild_id: string;
        guild_name: string;
      }>(
        this.pool,
        `select id, organization_id, slug, guild_id, guild_name
         from discord_connections where organization_id = $1
         order by guild_name, id`,
        [organizationId],
      ),
      query<{
        id: string;
        organization_id: string;
        slug: string;
        team_id: string;
        team_name: string;
        bot_user_id: string;
        bot_access_token: string;
      }>(
        this.pool,
        `select id, organization_id, slug, team_id, team_name, bot_user_id, bot_access_token
         from slack_connections where organization_id = $1
         order by team_name, id`,
        [organizationId],
      ),
    ]);
    return {
      github: github.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        slug: row.slug,
        installationId: Number(row.installation_id),
        accountId: row.account_id,
        accountLogin: row.account_login,
        accountType: row.account_type,
        status: row.status,
      })),
      discord: discord.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        slug: row.slug,
        guildId: row.guild_id,
        guildName: row.guild_name,
      })),
      slack: slack.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        slug: row.slug,
        teamId: row.team_id,
        teamName: row.team_name,
        botUserId: row.bot_user_id,
        botAccessToken: row.bot_access_token,
      })),
    };
  }

  async listGitHubRepositories(organizationId: string): Promise<GitHubRepositoryRecord[]> {
    const rows = await query<GitHubRepositoryRow>(
      this.pool,
      `select repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id, repository.repository_id,
              repository.full_name, repository.default_branch
       from github_repositories repository
       join github_connections connection on connection.id = repository.connection_id
       where repository.organization_id = $1
       order by repository.full_name, repository.id`,
      [organizationId],
    );
    return rows.rows.map(toGitHubRepositoryRecord);
  }

  async findGitHubRepositoryForOrganization(organizationId: string, fullName: string) {
    const rows = await query<GitHubRepositoryRow>(
      this.pool,
      `select repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id, repository.repository_id,
              repository.full_name, repository.default_branch
       from github_repositories repository
       join github_connections connection on connection.id = repository.connection_id
       where repository.organization_id = $1 and repository.full_name = $2
       order by repository.id limit 2`,
      [organizationId, fullName],
    );
    if (rows.rows.length > 1) throw new Error("github repository resource is ambiguous");
    return rows.rows[0] === undefined ? undefined : toGitHubRepositoryRecord(rows.rows[0]);
  }

  async upsertGitHubRepositories(
    organizationId: string,
    connectionId: string,
    repositories: Array<
      Pick<GitHubRepositoryRecord, "repositoryId" | "fullName" | "defaultBranch">
    >,
  ): Promise<void> {
    for (const repository of repositories) {
      await query(
        this.pool,
        `insert into github_repositories
           (organization_id, connection_id, repository_id, full_name, default_branch)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, repository_id) do update
           set full_name = excluded.full_name,
               default_branch = excluded.default_branch,
               updated_at = clock_timestamp()`,
        [
          organizationId,
          connectionId,
          repository.repositoryId,
          repository.fullName,
          repository.defaultBranch,
        ],
      );
    }
  }

  async findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined> {
    const rows = await query<GitHubConfigurationTargetRow>(
      this.pool,
      `select project.id as project_id,
              repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id,
              repository.repository_id, repository.full_name, repository.default_branch,
              source.automatic_deployment_enabled
       from project_configuration_sources source
       join projects project on project.id = source.project_id and project.status = 'active'
       join github_repositories repository
         on repository.organization_id = project.organization_id
        and repository.connection_id = source.github_connection_id
        and repository.repository_id = source.github_repository_id
       join github_connections connection on connection.id = repository.connection_id
       where source.project_id = $1 and source.kind = 'github'
         and ($2::bigint is null or repository.repository_id = $2)
       limit 1`,
      [projectId, repositoryId ?? null],
    );
    const row = rows.rows[0];
    return row === undefined
      ? undefined
      : {
          ...toGitHubRepositoryRecord(row),
          projectId: row.project_id,
          installationId: Number(row.installation_id),
          automaticDeploymentEnabled: row.automatic_deployment_enabled,
        };
  }

  async listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]> {
    const rows = await query<GitHubConfigurationTargetRow>(
      this.pool,
      `select project.id as project_id,
              repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id,
              repository.repository_id, repository.full_name, repository.default_branch,
              source.automatic_deployment_enabled
       from project_configuration_sources source
       join projects project
         on project.id = source.project_id
        and project.organization_id = $1
        and project.status = 'active'
       join github_repositories repository
         on repository.organization_id = project.organization_id
        and repository.connection_id = source.github_connection_id
        and repository.repository_id = source.github_repository_id
       join github_connections connection
         on connection.id = repository.connection_id
        and connection.organization_id = project.organization_id
       where source.kind = 'github'
         and source.github_connection_id = $2
         and source.github_repository_id = $3
       order by project.id`,
      [organizationId, connectionId, repositoryId],
    );
    return rows.rows.map((row) =>
      Object.assign(toGitHubRepositoryRecord(row), {
        projectId: row.project_id,
        installationId: Number(row.installation_id),
        automaticDeploymentEnabled: row.automatic_deployment_enabled,
      }),
    );
  }

  async listUnroutedTriggersForOrganization(organizationId: string): Promise<TriggerRecord[]> {
    const [triggerRows, receiptRows] = await Promise.all([
      query<TriggerRow>(
        this.pool,
        `select * from triggers
         where organization_id = $1 and project_id is null
         order by received_at desc, id desc`,
        [organizationId],
      ),
      query<TriggerRow>(
        this.pool,
        `select receipt.id,
                receipt.organization_id,
                null::uuid as project_id,
                null::uuid as configuration_revision_id,
                receipt.id as receipt_id,
                receipt.connection_id,
                receipt.resource_id,
                receipt.delivery_id,
                receipt.signature_hash,
                receipt.source,
                receipt.repo,
                receipt.payload,
                receipt.received_at,
                null::text as matched_trigger_name,
                receipt.dropped_reason,
                null::jsonb as dispatch_plan,
                null::text as lifecycle_state
         from provider_event_receipts receipt
         where receipt.organization_id = $1
           and receipt.dropped_reason is not null
           and not exists (
             select 1 from triggers trigger
             where trigger.receipt_id = receipt.id
           )
         order by receipt.received_at desc, receipt.id desc`,
        [organizationId],
      ),
    ]);
    return [...triggerRows.rows, ...receiptRows.rows]
      .sort(
        (left, right) =>
          right.received_at.getTime() - left.received_at.getTime() ||
          right.id.localeCompare(left.id),
      )
      .map(toTriggerRecord);
  }

  async isOrganizationMember(userId: string, organizationId: string): Promise<boolean> {
    const rows = await query(
      this.pool,
      `select 1 from member where user_id = $1 and organization_id = $2 limit 1`,
      [userId, organizationId],
    );
    return rows.rowCount === 1;
  }

  startConnectionAttempt(input: StartConnectionAttemptInput): Promise<void> {
    return this.connections.startAttempt(input);
  }

  readConnectionAttempt(input: ReadConnectionAttemptInput) {
    return this.connections.readAttempt(input);
  }

  consumeConnectionAttempt(input: ReadConnectionAttemptInput): Promise<void> {
    return this.connections.consumeAttempt(input);
  }

  advanceGitHubConnectionAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    return this.connections.advanceGitHubAttempt(input);
  }

  bindGitHubConnection(input: BindGitHubConnectionInput): Promise<void> {
    return this.connections.bindGitHub(input);
  }

  bindDiscordConnection(input: BindDiscordConnectionInput): Promise<void> {
    return this.connections.bindDiscord(input);
  }

  bindSlackConnection(input: BindSlackConnectionInput): Promise<void> {
    return this.connections.bindSlack(input);
  }

  disconnectConnection(
    provider: ConnectionProvider,
    connectionId: string,
    access: ConnectionStartAuthority,
  ) {
    return this.connections.disconnect(provider, connectionId, access);
  }

  findGitHubConnection(installationId: number) {
    return this.connections.findGitHub(installationId);
  }

  findDiscordConnection(guildId: string) {
    return this.connections.findDiscord(guildId);
  }

  findSlackConnection(teamId: string) {
    return this.connections.findSlack(teamId);
  }

  findSlackConnectionForOrganization(organizationId: string, teamId: string) {
    return this.connections.findSlackForOrganization(organizationId, teamId);
  }

  findDiscordConnectionForOrganization(organizationId: string, guildId: string) {
    return this.connections.findDiscordForOrganization(organizationId, guildId);
  }

  removeDiscordConnection(guildId: string): Promise<void> {
    return this.connections.removeDiscord(guildId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findTriggerById(id: string): Promise<TriggerRecord | undefined> {
    const rows = await query<TriggerRow>(
      this.pool,
      "select * from triggers where id = $1 limit 1",
      [id],
    );

    return rows.rows[0] === undefined ? undefined : toTriggerRecord(rows.rows[0]);
  }

  async insertAttachment(input: InsertAttachmentInput): Promise<AttachmentRecord> {
    try {
      const rows = await query<AttachmentRow>(
        this.pool,
        `insert into attachment_capabilities (
           trigger_id,
           organization_id,
           connection_id,
           provider,
           source_id,
           locator,
           filename,
           content_type,
           byte_size
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (trigger_id, provider, source_id) do nothing
         returning *`,
        [
          input.triggerId,
          input.organizationId,
          input.connectionId,
          input.provider,
          input.sourceId,
          JSON.stringify(input.locator),
          input.filename,
          input.contentType ?? null,
          input.byteSize ?? null,
        ],
      );
      const inserted = rows.rows[0];
      if (inserted !== undefined) return toAttachmentRecord(inserted);
      const existing = await this.findAttachmentBySource(
        input.triggerId,
        input.provider,
        input.sourceId,
      );
      if (existing === undefined) throw new Error("attachment insert conflict without row");
      return existing;
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async findAttachmentBySource(
    triggerId: string,
    provider: AttachmentProvider,
    sourceId: string,
  ): Promise<AttachmentRecord | undefined> {
    const rows = await query<AttachmentRow>(
      this.pool,
      `select * from attachment_capabilities
       where trigger_id = $1 and provider = $2 and source_id = $3 limit 1`,
      [triggerId, provider, sourceId],
    );
    return rows.rows[0] === undefined ? undefined : toAttachmentRecord(rows.rows[0]);
  }

  async findAttachmentForExecution(
    executionId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | undefined> {
    const rows = await query<AttachmentRow>(
      this.pool,
      `select attachment.*
       from attachment_capabilities attachment
       join agent_executions execution
         on execution.trigger_id = attachment.trigger_id
        and execution.organization_id = attachment.organization_id
       where execution.id = $1 and attachment.id = $2 limit 1`,
      [executionId, attachmentId],
    );
    return rows.rows[0] === undefined ? undefined : toAttachmentRecord(rows.rows[0]);
  }
}

async function lockValidProjectRevision(
  client: PoolClient,
  projectId: string,
  revisionId: string,
): Promise<ProjectConfigurationRevisionRow> {
  const selected = await client.query<ProjectConfigurationRevisionRow>(
    `select revisions.*
     from project_configuration_revisions revisions
     join projects on projects.id = revisions.project_id
     where revisions.id = $2 and revisions.project_id = $1 and projects.status = 'active'
     for update of projects, revisions`,
    [projectId, revisionId],
  );
  const revision = selected.rows[0];
  if (revision === undefined) throw new Error("configuration revision not found");
  if (revision.validation_errors !== null) throw new Error("invalid configuration revision");
  return revision;
}

async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const targetUrl = new URL(url);
  const databaseName = basename(targetUrl.pathname);
  const postgresUrl = new URL(url);

  postgresUrl.pathname = `/${DEFAULT_POSTGRES_DATABASE}`;

  const pool = createPostgresPool(postgresUrl.toString());

  try {
    const existsResult = await query(pool, "select 1 from pg_database where datname = $1", [
      databaseName,
    ]);

    if (existsResult.rowCount === 0) {
      await query(pool, `create database ${quoteIdentifier(databaseName)}`);
    }
  } catch (error) {
    throw toDatabaseError(error);
  } finally {
    await pool.end();
  }
}

export function createPostgresPool(connectionString: string): Pool {
  const config: PoolConfig = {
    connectionString,
    connectionTimeoutMillis: QUERY_DEADLINE_MS,
    query_timeout: QUERY_DEADLINE_MS,
    statement_timeout: QUERY_DEADLINE_MS,
  };

  const pool = new Pool(config);
  pool.on("error", (error) => {
    logger.error({ err: error }, "PostgreSQL pool client error");
  });
  return pool;
}

async function query<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
) {
  return withDatabaseDeadline(pool.query<T>(text, values));
}

async function ensureTriggerReceipt(pool: Pool, input: InsertTriggerInput): Promise<string> {
  const inserted = await query<{ id: string }>(
    pool,
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, signature_hash, source, repo, payload, received_at)
     values ($1, 'manual', $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (organization_id, delivery_id) do nothing
     returning id`,
    [
      input.organizationId,
      input.deliveryId,
      input.signatureHash ?? null,
      input.source,
      input.repo ?? null,
      JSON.stringify(input.payload),
      input.receivedAt,
    ],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await query<{ id: string }>(
    pool,
    `select id from provider_event_receipts
     where organization_id = $1 and delivery_id = $2 limit 1`,
    [input.organizationId, input.deliveryId],
  );
  if (existing.rows[0] === undefined) throw new Error("provider receipt unavailable");
  return existing.rows[0].id;
}

async function withDatabaseDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new DatabaseUnavailableError("database query timed out"));
        }, QUERY_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid database name: ${value}`);
  }

  return `"${value.replaceAll('"', '""')}"`;
}

const TERMINAL_AGENT_EXECUTION_STATUSES = ["succeeded", "failed"] satisfies AgentExecutionStatus[];

export interface TriggerRow extends QueryResultRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  configuration_revision_id: string | null;
  receipt_id: string;
  connection_id: string | null;
  resource_id: string | null;
  delivery_id: string;
  signature_hash: string | null;
  source: string;
  repo: string | null;
  payload: unknown;
  received_at: Date;
  matched_trigger_name: string | null;
  dropped_reason: string | null;
  dispatch_plan: readonly LaunchMachineIntent[] | null;
  lifecycle_state: TriggerLifecycleState | null;
}

export interface MachineRow extends QueryResultRow {
  id: string;
  org_id: string;
  source: MachineSource;
  status: MachineStatus;
  started_at: Date;
  terminated_at: Date | null;
  shutdown_reason: string | null;
  trigger_name: string | null;
  trigger_context: unknown;
  specs: unknown;
}

export interface AgentExecutionRow extends QueryResultRow {
  id: string;
  organization_id: string;
  project_id: string;
  machine_id: string | null;
  status: AgentExecutionStatus;
  started_at: Date;
  completed_at: Date | null;
  completed_by_agent_at: Date | null;
  deadline_at: Date | null;
  idle_deadline_at: Date | null;
  result: unknown;
  trigger_context: unknown;
  output_context: unknown;
  configuration_revision_id: string;
  completion_token_hash: string | null;
  reply_claimed_at: Date | null;
  reply_claim_count: number;
  launch_intent: AgentExecutionRecord["launchIntent"];
  daemon_id: string | null;
  daemon_agent_id: string | null;
  trigger_id: string | null;
  trigger_connection_id: string | null;
  trigger_resource_id: string | null;
  hub_action: "interrupt" | "archive" | null;
  hub_action_completed_at: Date | null;
}

export interface AttachmentRow extends QueryResultRow {
  id: string;
  trigger_id: string;
  organization_id: string;
  connection_id: string;
  provider: AttachmentProvider;
  source_id: string;
  locator: unknown;
  filename: string;
  content_type: string | null;
  byte_size: number | null;
  created_at: Date;
}

interface DaemonRow extends QueryResultRow {
  id: string;
  enrollment_verifier: string;
  slug: string;
  machine_id: string;
  server_id: string;
  daemon_public_key: string;
  credential_verifier: string;
  scopes: string[];
  display_name: string | null;
  approved_by_user_id: string | null;
  registered_by_api_key_id: string | null;
  registration_method: "operator" | "device";
  status: "active" | "revoked";
  presence: "offline" | "connected";
  connected_at: Date | null;
  disconnected_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
}

interface DeviceAuthorizationRow extends QueryResultRow {
  id: string;
  device_verifier: string;
  user_code_verifier: string;
  fingerprint_verifier: string;
  suggested_display_name: string;
  status: "pending" | "approved" | "denied" | "expired" | "enrolled";
  poll_interval_seconds: number;
  next_poll_at: Date;
  approved_organization_id: string | null;
  approved_by_user_id: string | null;
  approved_display_name: string | null;
  created_at: Date;
  expires_at: Date;
  database_now: Date;
}

function toDaemon(row: DaemonRow): DaemonRecord {
  return {
    id: row.id,
    slug: row.slug,
    machineId: row.machine_id,
    serverId: row.server_id,
    daemonPublicKey: row.daemon_public_key,
    credentialVerifier: row.credential_verifier,
    scopes: row.scopes,
    displayName: row.display_name ?? row.slug,
    approvedByUserId: row.approved_by_user_id,
    registeredByApiKeyId: row.registered_by_api_key_id,
    registrationMethod: row.registration_method,
    status: row.status,
    presence: row.presence,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function toDeviceAuthorization(row: DeviceAuthorizationRow): DeviceAuthorizationRecord {
  return {
    id: row.id,
    suggestedDisplayName: row.suggested_display_name,
    status: row.status,
    pollIntervalSeconds: row.poll_interval_seconds,
    approvedOrganizationId: row.approved_organization_id,
    approvedByUserId: row.approved_by_user_id,
    approvedDisplayName: row.approved_display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface ProjectRow extends QueryResultRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  active_configuration_revision_id: string | null;
}

export interface ProjectConfigurationRevisionRow extends QueryResultRow {
  id: string;
  project_id: string;
  organization_id: string;
  version: number;
  source_kind: "github" | "manual";
  source_evidence: unknown;
  raw_yaml: string | null;
  normalized_configuration: unknown;
  validation_errors: unknown;
  content_hash: string;
  created_by_user_id: string | null;
  received_at: Date | null;
  created_at: Date;
  validated_at: Date | null;
}

interface GitHubRepositoryRow extends QueryResultRow {
  id: string;
  organization_id: string;
  connection_id: string;
  installation_id: number | string;
  repository_id: number | string;
  full_name: string;
  default_branch: string;
}

interface GitHubConfigurationTargetRow extends GitHubRepositoryRow {
  project_id: string;
  automatic_deployment_enabled: boolean;
}

function toGitHubRepositoryRecord(row: GitHubRepositoryRow): GitHubRepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    repositoryId: Number(row.repository_id),
    fullName: row.full_name,
    defaultBranch: row.default_branch,
  };
}

interface TenantRouteAccessRow extends QueryResultRow {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  membership_id: string;
  membership_role: "owner" | "admin" | "member";
  project_id: string | null;
  project_organization_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  project_status: "active" | "archived" | null;
  project_created_by_user_id: string | null;
  project_created_at: Date | null;
  project_updated_at: Date | null;
  project_archived_at: Date | null;
  project_active_configuration_revision_id: string | null;
}
