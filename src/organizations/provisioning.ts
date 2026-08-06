import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hashTemplate, UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";

export interface ProvisionedOrganization {
  id: string;
  slug: string;
  projectId: string;
}

export async function provisionOrganization(
  client: PoolClient,
  input: { organizationId: string; name: string; ownerUserId: string },
): Promise<ProvisionedOrganization> {
  const slug = organizationSlug(input.name, input.organizationId);
  const projectId = randomUUID();
  await client.query(`insert into organization (id, name, slug) values ($1, $2, $3)`, [
    input.organizationId,
    input.name,
    slug,
  ]);
  await client.query(
    `insert into member (id, organization_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), input.organizationId, input.ownerUserId],
  );
  await client.query(
    `insert into projects (id, organization_id, name, slug, created_by_user_id)
     values ($1, $2, 'Default', 'default', $3)`,
    [projectId, input.organizationId, input.ownerUserId],
  );
  await client.query(
    `insert into project_configuration_sources
       (project_id, organization_id, kind, automatic_deployment_enabled, selected_by_user_id)
     values ($1, $2, 'manual', false, $3)`,
    [projectId, input.organizationId, input.ownerUserId],
  );
  await stampDefaultEntitlements(client, input.organizationId, input.ownerUserId);
  return { id: input.organizationId, slug, projectId };
}

/**
 * Every organization is stamped at provisioning — `EntitlementsService.read()` throws
 * for an organization with no row, so this insert cannot be skipped or deferred.
 */
async function stampDefaultEntitlements(
  client: PoolClient,
  organizationId: string,
  ownerUserId: string,
): Promise<void> {
  const granted = UNLIMITED_TEMPLATE;
  await client.query(
    `insert into organization_entitlements
       (organization_id, granted, overrides, plan_id, plan_version, stamped_at, updated_at)
     values ($1, $2::jsonb, '{}'::jsonb, null, $3, now(), now())`,
    [organizationId, JSON.stringify(granted), hashTemplate(granted)],
  );
  await client.query(
    `insert into entitlement_changes (organization_id, actor, source, before, after, reason)
     values ($1, $2, 'provisioning', null, $3::jsonb, null)`,
    [organizationId, ownerUserId, JSON.stringify({ granted, overrides: {} })],
  );
}

export function organizationSlug(name: string, id: string): string {
  const stem = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  return `${stem.length === 0 ? "organization" : stem}-${id.slice(0, 8)}`;
}
