import type { AuthServer } from "../auth/server.js";
import type { Database, OrganizationRunRecord, UnroutedProviderEventCount } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";

/** How far back the overview looks. One week is long enough to hold a first run and short enough that a nudge fades once a trigger listens. */
export const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;

export interface HomeSnapshot {
  organization: { id: string; name: string; slug: string };
  connections: readonly {
    provider: "github" | "slack" | "discord" | "linear";
    slug: string;
    label: string;
  }[];
  daemons: readonly {
    id: string;
    slug: string;
    presence: "offline" | "connected";
    /** Enrolled with `hub.execute`; without it Hub can see the daemon but launch nothing on it. */
    canExecute: boolean;
  }[];
  triggers: readonly { id: string; name: string; event: string; enabled: boolean }[];
  runs: readonly (Omit<OrganizationRunRecord, "receivedAt"> & { receivedAt: string })[];
  unrouted: readonly UnroutedProviderEventCount[];
  windowDays: number;
}

/**
 * Everything Home derives its checklist and overview from, read from records: nothing here is a
 * stored "onboarding" flag, so the checklist can only say what the organization has actually
 * done, and undoes itself when a daemon is revoked or a connection removed.
 */
export class HomeDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(request: Request, organizationSlug: string): Promise<HomeSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const organizationId = tenant.organization.id;
    const since = new Date(this.now().getTime() - HOME_WINDOW_DAYS * 86_400_000);
    const triggers = await this.database.listOrganizationTriggers(organizationId);
    const [connections, daemons, revisions, runs, unrouted] = await Promise.all([
      this.database.organizationConnectionUsage(organizationId),
      this.database.listDaemonsForOrganization(organizationId),
      Promise.all(
        triggers.map((trigger) =>
          this.database.findOrganizationTriggerRevision(trigger.id, trigger.activeRevisionId),
        ),
      ),
      this.database.listOrganizationRunsSince(organizationId, since, RUNS_SHOWN),
      this.database.countUnroutedProviderEventsSince(organizationId, since),
    ]);
    return {
      organization: tenant.organization,
      connections: [
        ...connections.github.map(({ slug, accountLogin }) => ({
          provider: "github" as const,
          slug,
          label: accountLogin,
        })),
        ...connections.slack.map(({ slug, teamName }) => ({
          provider: "slack" as const,
          slug,
          label: teamName,
        })),
        ...connections.discord.map(({ slug, guildName }) => ({
          provider: "discord" as const,
          slug,
          label: guildName,
        })),
        ...connections.linear.map(({ slug, linearOrganizationName }) => ({
          provider: "linear" as const,
          slug,
          label: linearOrganizationName,
        })),
      ],
      daemons: daemons
        .filter(({ status }) => status === "active")
        .map(({ id, slug, presence, permissions }) => ({
          id,
          slug,
          presence,
          canExecute: permissions.includes("hub.execute"),
        })),
      triggers: triggers.map((trigger, index) => ({
        id: trigger.id,
        name: trigger.name,
        event: triggerEvent(revisions[index]?.yaml),
        enabled: trigger.enabled,
      })),
      runs: runs.map((run) => ({
        id: run.id,
        triggerName: run.triggerName,
        provider: run.provider,
        source: run.source,
        status: run.status,
        receivedAt: run.receivedAt.toISOString(),
        agent: run.agent,
      })),
      unrouted,
      windowDays: HOME_WINDOW_DAYS,
    };
  }
}

/** The one event a self-contained trigger listens for; a legacy document has none to name. */
function triggerEvent(yaml: string | undefined): string {
  if (yaml === undefined) return "manual.run";
  const projection = projectTriggerForm(yaml);
  return projection.status === "editable" ? projection.value.event : "manual.run";
}
