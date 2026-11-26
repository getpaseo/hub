import type { ActivitySummary } from "../activity/index.js";
import { rangeStart, type ActivityProvider, type RunStatus } from "../activity/query-contract.js";
import type { AuthServer } from "../auth/server.js";
import { toPublicConnectionView } from "../db/integrations.js";
import type { Database, OrganizationConnectionUsage } from "../db/types.js";
import { defaultIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry.js";
import { resolveRouteTenant } from "../projects/access.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { eventDefinition, eventProvider, isEditorEvent } from "../triggers/configuration/events.js";
import { configuredTriggerEvents } from "../triggers/store.js";
import type { HomeRange } from "./range.js";

/** As many triggers as the overview ranks; the rest are one link away on Triggers. */
const TRIGGERS_SHOWN = 8;

export interface HomeSnapshot {
  organization: { id: string; name: string; slug: string };
  /** Whether any provider app (GitHub, Slack, Discord, Linear) is set up on this Hub at all. */
  appsConfigured: boolean;
  connections: readonly {
    provider: string;
    slug: string;
    label: string;
    /**
     * `suspended`: GitHub stopped delivering events until someone acts on its side.
     * `requiresReauthorization`: the grant is short of what Hub needs, as Integrations says.
     */
    status: "connected" | "suspended" | "requiresReauthorization";
  }[];
  daemons: readonly {
    id: string;
    slug: string;
    presence: "offline" | "connected";
    /** Enrolled with `hub.execute`; without it Hub can see the daemon but launch nothing on it. */
    canExecute: boolean;
    /** Runs with a step this daemon executed, inside `range`. */
    runs: number;
  }[];
  triggers: readonly { id: string; name: string; events: readonly string[]; enabled: boolean }[];
  /** The window every figure below is counted over. */
  range: HomeRange;
  /** Every run that started inside `range`, counted by status. */
  runs: Readonly<Record<RunStatus, number>>;
  /** The triggers that ran most inside `range`, then the idle ones by name. */
  busiestTriggers: readonly HomeTrigger[];
  /**
   * The organization's newest run, whatever its age. An organization that has run before is not
   * new: this is what ends the checklist and keeps the overview on the page through a quiet week.
   */
  latestRun: { triggerName: string; receivedAt: string } | null;
}

export interface HomeTrigger {
  id: string;
  name: string;
  /** Where the trigger's first event comes from. */
  provider: ActivityProvider;
  /** The trigger's first event, as the trigger editor names it. */
  event: string;
  runs: number;
  failed: number;
  lastRunAt: string | null;
}

/**
 * Everything Home derives its checklist and overview from, read from records: nothing here is a
 * stored "onboarding" flag, so the checklist can only say what the organization has actually
 * done, and undoes itself when a daemon is revoked or a connection removed. Every figure is
 * counted in the database over the whole range, never over a page of rows.
 */
export class HomeDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    /**
     * Whether any provider app is configured, answered by the same registrations the
     * connections status reads; a self-hosted Hub with none has nothing to connect yet.
     */
    private readonly providerAppsConfigured: (bindings: OrganizationConnectionUsage) => boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly registry: IntegrationRegistry = defaultIntegrationRegistry,
  ) {}

  async snapshot(
    request: Request,
    organizationSlug: string,
    range: HomeRange = "7d",
  ): Promise<HomeSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const organizationId = tenant.organization.id;
    const now = this.now();
    const since = rangeStart(range, now) ?? new Date(0);
    const triggers = await this.database.listOrganizationTriggers(organizationId);
    const [connections, daemons, revisions, summary, latestRun] = await Promise.all([
      this.database.organizationConnectionUsage(organizationId),
      this.database.listDaemonsForOrganization(organizationId),
      Promise.all(
        triggers.map((trigger) =>
          this.database.findOrganizationTriggerRevision(trigger.id, trigger.activeRevisionId),
        ),
      ),
      this.database.activity.summarize(organizationId, since, TRIGGERS_SHOWN),
      this.database.activity.latestRun(organizationId),
    ]);
    const triggerViews = triggers.map((trigger, index) => ({
      id: trigger.id,
      name: trigger.name,
      events: configuredTriggerEvents(trigger.format, revisions[index]),
      enabled: trigger.enabled,
    }));
    return {
      organization: tenant.organization,
      appsConfigured: this.providerAppsConfigured(connections),
      connections: connectionViews(connections, now, this.registry),
      daemons: daemons
        .filter(({ status }) => status === "active")
        .map(({ id, slug, presence, permissions }) => ({
          id,
          slug,
          presence,
          canExecute: permissions.includes("hub.execute"),
          runs: summary.daemons.find((daemon) => daemon.id === id)?.runs ?? 0,
        })),
      triggers: triggerViews,
      range,
      runs: summary.statuses,
      busiestTriggers: busiestTriggers(summary, triggerViews),
      latestRun:
        latestRun === undefined
          ? null
          : { triggerName: latestRun.triggerName, receivedAt: latestRun.receivedAt.toISOString() },
    };
  }
}

function connectionViews(
  connections: OrganizationConnectionUsage,
  now: Date,
  registry: IntegrationRegistry,
): HomeSnapshot["connections"] {
  return [
    ...connections.github.map(({ slug, accountLogin, status }) => ({
      provider: "github" as const,
      slug,
      label: accountLogin,
      status: status === "suspended" ? ("suspended" as const) : ("connected" as const),
    })),
    ...connections.slack.map(({ slug, teamName, scopes }) => ({
      provider: "slack" as const,
      slug,
      label: teamName,
      status: hasRequiredSlackScopes(scopes)
        ? ("connected" as const)
        : ("requiresReauthorization" as const),
    })),
    ...connections.discord.map(({ slug, guildName }) => ({
      provider: "discord" as const,
      slug,
      label: guildName,
      status: "connected" as const,
    })),
    ...connections.linear.map((connection) => ({
      provider: "linear" as const,
      slug: connection.slug,
      label: connection.linearOrganizationName,
      status: linearConnectionRequiresReauthorization(connection, now)
        ? ("requiresReauthorization" as const)
        : ("connected" as const),
    })),
    ...(connections.integrations ?? []).map((record) => {
      const integration = registry.get(record.provider);
      if (integration !== undefined) {
        const projected = integration.connection.projectConnection(record, now);
        return {
          provider: projected.provider,
          slug: projected.slug,
          label: projected.displayName,
          status: projected.status,
        };
      }
      const publicView = toPublicConnectionView(record);
      return {
        provider: publicView.provider,
        slug: publicView.slug,
        label: publicView.displayName,
        status: integrationConnectionStatus(publicView.status),
      };
    }),
  ];
}

function integrationConnectionStatus(
  status: string,
): "connected" | "suspended" | "requiresReauthorization" {
  if (status === "suspended") return "suspended";
  if (status === "requires_reauthorization") return "requiresReauthorization";
  return "connected";
}

function busiestTriggers(
  summary: ActivitySummary,
  triggers: HomeSnapshot["triggers"],
): HomeTrigger[] {
  return summary.triggers.map((activity) => {
    const event = triggers.find(({ id }) => id === activity.id)?.events[0] ?? "manual.run";
    const definition = isEditorEvent(event) ? eventDefinition(event) : undefined;
    return {
      id: activity.id,
      name: activity.name,
      provider: eventProvider(event),
      event: definition?.label ?? event,
      runs: activity.runs,
      failed: activity.failed,
      lastRunAt: activity.lastRunAt?.toISOString() ?? null,
    };
  });
}
