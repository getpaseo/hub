import type { DatabaseRuntime, QueryRow } from "../../db/runtime/index.js";
import { hasRequiredSlackScopes } from "../../providers/slack/client.js";
import type { Provider, ProviderApplicationInventory } from "../index.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { slackActionReasonFromPersistence } from "../../triggers/slack/source/health-policy.js";
import { PROVIDER_OBSERVATION_LIFETIME_SECONDS } from "./observation-lifetime.js";

interface ConnectionIdentityRow extends QueryRow {
  id: string;
  provider_id: string;
  name: string;
  application_id: string | null;
  action_needed: boolean;
  scopes: unknown;
}

/** @package */
export function createProviderApplicationInventory(
  database: DatabaseRuntime,
): ProviderApplicationInventory & { organizationSlug(id: string): Promise<string | undefined> } {
  return {
    async connectedIdentities(provider) {
      const result = await database.query<ConnectionIdentityRow>(connectionIdentityQuery(provider));
      return result.rows.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        name: row.name,
        applicationId: row.application_id,
        status:
          row.action_needed ||
          (provider === "slack" &&
            (!Array.isArray(row.scopes) || !hasRequiredSlackScopes(row.scopes)))
            ? "actionNeeded"
            : "connected",
      }));
    },
    async lastEventAt(provider, identity, configurationVersion) {
      if (provider === "discord") return null;
      const result = await database.query<{ received_at: Date | string | null }>(
        `select max(received_at) as received_at
         from provider_event_receipts
         where provider = $1 and signature_hash is not null
           and provider_application_id = $2
           and provider_configuration_version = $3`,
        [provider, identity.id, configurationVersion],
      );
      const value = result.rows[0]?.received_at;
      return value === null || value === undefined ? null : new Date(value);
    },
    async claimLegacyConnections(provider, identity) {
      const table = connectionTable(provider);
      return database.transaction(async (transaction) => {
        await transaction.query(
          `update ${table} set provider_application_id = $1
           where provider_application_id is null`,
          [identity.id],
        );
        const ownership = await transaction.query<{ owned: boolean }>(
          `select exists (select 1 from ${table})
              and not exists (
                select 1 from ${table}
                where provider_application_id is null or provider_application_id <> $1
              ) as owned`,
          [identity.id],
        );
        return ownership.rows[0]?.owned === true;
      });
    },
    async slackDeliveryStatus(applicationId, configurationVersion) {
      const result = await database.query<{
        state: string;
        reason: string | null;
        observed_at: Date | string;
      }>(
        `select state, reason, observed_at
         from runtime_provider_instances
         where provider = 'slack'
           and provider_application_id = $1
           and configuration_version = $2
           and observed_at > now() - ($3 * interval '1 second')
         order by observed_at desc`,
        [applicationId, configurationVersion, PROVIDER_OBSERVATION_LIFETIME_SECONDS],
      );
      if (result.rows.length === 0) return undefined;
      const observedAt = new Date(result.rows[0]!.observed_at);
      const connected = result.rows.filter((row) => row.state === "connected");
      if (connected.length > 0) {
        const delayedWorkspaces = await nameDelayedWorkspaces(
          database,
          applicationId,
          configurationVersion,
        );
        return {
          state: "connected",
          since: observedAt,
          connectionCount: connected.length,
          ...(connected.some((row) => row.reason === "connection_limit")
            ? { connectionLimitReached: true }
            : {}),
          ...(delayedWorkspaces.length === 0 ? {} : { delayedWorkspaces }),
        } satisfies SlackDeliveryStatus;
      }
      const action = result.rows.find((row) => row.state === "action_needed");
      if (action !== undefined) {
        const reason = slackActionReasonFromPersistence(action.reason) ?? "appTokenRejected";
        return { state: "actionNeeded", reason, since: observedAt } satisfies SlackDeliveryStatus;
      }
      return { state: "reconnecting", since: observedAt };
    },
    async organizationSlug(id) {
      const result = await database.query<{ slug: string }>(
        `select slug from organization where id = $1`,
        [id],
      );
      return result.rows[0]?.slug;
    },
  };
}

async function nameDelayedWorkspaces(
  database: DatabaseRuntime,
  applicationId: string,
  configurationVersion: number,
): Promise<{ teamId: string; name?: string; since: Date }[]> {
  const result = await database.query<{
    team_id: string;
    observed_at: Date | string;
    team_name: string | null;
  }>(
    `select observation.team_id, observation.observed_at, connection.team_name
     from slack_workspace_delivery_observations observation
     left join slack_connections connection
       on connection.provider_application_id = observation.provider_application_id
      and connection.team_id = observation.team_id
     where observation.provider_application_id = $1
       and observation.configuration_version = $2
       and observation.delayed = true
     order by observation.team_id`,
    [applicationId, configurationVersion],
  );
  return result.rows.map((row) => {
    const workspace: { teamId: string; since: Date; name?: string } = {
      teamId: row.team_id,
      since: new Date(row.observed_at),
    };
    if (row.team_name !== null) workspace.name = row.team_name;
    return workspace;
  });
}

function connectionTable(provider: Provider): string {
  if (provider === "github") return "github_connections";
  if (provider === "slack") return "slack_connections";
  return "discord_connections";
}

function connectionIdentityQuery(provider: Provider): string {
  if (provider === "github") {
    return `select id::text as id, installation_id::text as provider_id, account_login as name,
                   provider_application_id as application_id,
                   status = 'suspended' as action_needed, null::jsonb as scopes
            from github_connections order by connected_at`;
  }
  if (provider === "slack") {
    return `select id::text as id, team_id as provider_id, team_name as name,
                   provider_application_id as application_id,
                   false as action_needed, scopes
            from slack_connections order by connected_at`;
  }
  return `select id::text as id, guild_id as provider_id, guild_name as name,
                 provider_application_id as application_id,
                 false as action_needed, null::jsonb as scopes
          from discord_connections order by connected_at`;
}
