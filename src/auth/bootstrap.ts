import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  provisionOrganization,
  UNLIMITED_PROVISIONING,
  type ProvisioningEntitlement,
  type ProvisioningEntitlementResolver,
} from "../organizations/provisioning.js";
import type { BootstrapSettings, InstanceAuthPolicy } from "./instance-policy.js";

const BOOTSTRAP_ROW_ID = "default";

interface BootstrapRow extends QueryResultRow {
  organization_id: string | null;
  owner_user_id: string | null;
  completed_at: Date | null;
}

interface ExistingOrganization extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  member_count: number;
  project_count: number;
}

export class InstanceBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceBootstrapError";
  }
}

/**
 * Creates the configured owner under a singleton row lock. All durable writes happen in
 * one transaction, so a crash cannot leave an organization, account, or membership that
 * a later startup might mistake for a completed bootstrap.
 */
export async function bootstrapInstance(
  pool: Pool,
  policy: InstanceAuthPolicy,
  provisioningEntitlements: ProvisioningEntitlementResolver = () =>
    Promise.resolve(UNLIMITED_PROVISIONING),
): Promise<void> {
  const settings = policy.bootstrap;
  if (settings === undefined) return;

  // Resolve outside the transaction — the same value the create-organization path uses, so the
  // bootstrap owner's organization is stamped by the instance's provisioning policy too.
  const entitlement = await provisioningEntitlements();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into instance_bootstrap (id) values ($1)
       on conflict (id) do nothing`,
      [BOOTSTRAP_ROW_ID],
    );
    const existing = await client.query<BootstrapRow>(
      `select organization_id, owner_user_id, completed_at
       from instance_bootstrap
       where id = $1
       for update`,
      [BOOTSTRAP_ROW_ID],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new InstanceBootstrapError("bootstrap state disappeared");
    if (row.completed_at !== null) {
      await client.query("commit");
      return;
    }
    if (row.owner_user_id !== null) {
      throw new InstanceBootstrapError(
        "bootstrap state has an owner without completion; repair the instance_bootstrap row before restarting",
      );
    }

    const created = await createBootstrapData(client, settings, row.organization_id, entitlement);
    await client.query(
      `update instance_bootstrap
       set organization_id = $2, owner_user_id = $3, completed_at = now()
       where id = $1`,
      [BOOTSTRAP_ROW_ID, created.organizationId, created.ownerUserId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof InstanceBootstrapError) throw error;
    throw new InstanceBootstrapError(
      `bootstrap failed: ${error instanceof Error ? error.message : "unknown database error"}`,
    );
  } finally {
    client.release();
  }
}

async function createBootstrapData(
  client: PoolClient,
  settings: BootstrapSettings,
  existingOrganizationId: string | null,
  entitlement: ProvisioningEntitlement,
): Promise<{ organizationId: string; ownerUserId: string }> {
  const existingOwner = await client.query<{ id: string }>(
    `select id from "user" where lower(email) = $1 limit 1`,
    [settings.ownerEmail],
  );
  if (existingOwner.rowCount !== 0) {
    throw new InstanceBootstrapError(
      "bootstrap owner email already belongs to an existing account; resolve the conflict before restarting",
    );
  }

  let resolvedOrganizationId = existingOrganizationId;
  if (resolvedOrganizationId === null) {
    const matchingOrganizations = await client.query<{ id: string }>(
      `select id from organization where lower(trim(name)) = lower(trim($1)) order by id for update`,
      [settings.organizationName],
    );
    if (matchingOrganizations.rows.length > 1) {
      throw new InstanceBootstrapError(
        "bootstrap organization name matches more than one existing organization; resolve the ambiguity before restarting",
      );
    }
    if (matchingOrganizations.rows.length === 1) {
      resolvedOrganizationId = matchingOrganizations.rows[0]!.id;
    } else {
      const existingOrganizations = await client.query<{ count: number }>(
        `select count(*)::integer as count from organization`,
      );
      if (existingOrganizations.rows[0]?.count !== 0) {
        throw new InstanceBootstrapError(
          "bootstrap cannot identify the existing organization from the configured name; resolve ownership before restarting",
        );
      }
    }
  }

  const existingOrganization =
    resolvedOrganizationId === null
      ? undefined
      : (
          await client.query<ExistingOrganization>(
            `select organization.id, organization.name, organization.slug,
                    (select count(*)::integer from member where member.organization_id = organization.id) as member_count,
                    (select count(*)::integer from projects where projects.organization_id = organization.id) as project_count
             from organization
             where organization.id = $1
             for update`,
            [resolvedOrganizationId],
          )
        ).rows[0];
  if (resolvedOrganizationId !== null && existingOrganization === undefined) {
    throw new InstanceBootstrapError(
      "bootstrap points to an organization that no longer exists; restore the organization before restarting",
    );
  }
  if (
    existingOrganization !== undefined &&
    normalizeName(existingOrganization.name) !== normalizeName(settings.organizationName)
  ) {
    throw new InstanceBootstrapError(
      "bootstrap organization name conflicts with the organization preserved from the previous installation",
    );
  }
  if (existingOrganization !== undefined && existingOrganization.member_count !== 0) {
    throw new InstanceBootstrapError(
      "bootstrap organization already has members; resolve the ownership conflict before restarting",
    );
  }
  if (settings.ownerPassword === undefined) {
    throw new InstanceBootstrapError(
      "PASEO_BOOTSTRAP_OWNER_PASSWORD is required until instance bootstrap completes",
    );
  }

  const ownerUserId = randomUUID();
  const password = await hashPassword(settings.ownerPassword);
  // The bootstrap owner is the instance's first operator — the only limits surface on a
  // self-hosted instance and the back office on a hosted one. Every later operator is granted
  // by SQL (docs/entitlements.md), never a UI or env var.
  await client.query(
    `insert into "user"
       (id, name, email, email_verified, must_change_password, is_instance_operator)
     values ($1, $2, $3, true, true, true)`,
    [ownerUserId, settings.ownerEmail.split("@")[0] ?? settings.ownerEmail, settings.ownerEmail],
  );
  await client.query(
    `insert into account
       (id, account_id, provider_id, user_id, password)
     values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), ownerUserId, password],
  );

  if (existingOrganization === undefined) {
    await provisionOrganization(
      client,
      {
        organizationId: randomUUID(),
        name: settings.organizationName,
        ownerUserId,
      },
      entitlement,
    );
  } else {
    await client.query(
      `insert into member (id, organization_id, user_id, role)
       values ($1, $2, $3, 'owner')`,
      [randomUUID(), existingOrganization.id, ownerUserId],
    );
    if (existingOrganization.project_count === 0) {
      const projectId = randomUUID();
      await client.query(
        `insert into projects (id, organization_id, name, slug, created_by_user_id)
         values ($1, $2, 'Default', 'default', $3)`,
        [projectId, existingOrganization.id, ownerUserId],
      );
      await client.query(
        `insert into project_configuration_sources
           (project_id, organization_id, kind, automatic_deployment_enabled, selected_by_user_id)
         values ($1, $2, 'manual', false, $3)`,
        [projectId, existingOrganization.id, ownerUserId],
      );
    }
  }
  return {
    organizationId: existingOrganization?.id ?? (await latestOrganizationId(client, ownerUserId)),
    ownerUserId,
  };
}

async function latestOrganizationId(client: PoolClient, ownerUserId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select organization_id as id from member where user_id = $1 and role = 'owner'`,
    [ownerUserId],
  );
  const organizationId = result.rows[0]?.id;
  if (organizationId === undefined)
    throw new InstanceBootstrapError("bootstrap owner membership missing");
  return organizationId;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
