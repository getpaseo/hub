import type { AuthServer } from "../auth/server.js";
import type {
  Database,
  OrganizationConnectionUsage,
  OrganizationRunRecord,
  UnroutedProviderEventCount,
} from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";

/** How far back the overview looks. One week is long enough to hold a first run and short enough that a nudge fades once a trigger listens. */
export const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;
const RECENT_RUNS_SHOWN = 5;
const BEGINNING = new Date(0);

export type HomeRun = Omit<OrganizationRunRecord, "receivedAt"> & { receivedAt: string };

export interface HomeSnapshot {
  organization: { id: string; name: string; slug: string };
  /** Whether any provider app (GitHub, Slack, Discord, Linear) is set up on this Hub at all. */
  appsConfigured: boolean;
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
  /** The overview's window: every run in the last `windowDays`, newest first. */
  runs: readonly HomeRun[];
  /**
   * The newest runs the organization ever had, whatever their age. An organization that has run
   * before is not new: this is what ends the checklist and what keeps Recent runs on the page
   * through a quiet week.
   */
  recentRuns: readonly HomeRun[];
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
    /**
     * Whether any provider app is configured, answered by the same registrations the
     * connections status reads; a self-hosted Hub with none has nothing to connect yet.
     */
    private readonly providerAppsConfigured: (bindings: OrganizationConnectionUsage) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(request: Request, organizationSlug: string): Promise<HomeSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const organizationId = tenant.organization.id;
    const since = new Date(this.now().getTime() - HOME_WINDOW_DAYS * 86_400_000);
    const triggers = await this.database.listOrganizationTriggers(organizationId);
    const [connections, daemons, revisions, runs, recentRuns, unrouted] = await Promise.all([
      this.database.organizationConnectionUsage(organizationId),
      this.database.listDaemonsForOrganization(organizationId),
      Promise.all(
        triggers.map((trigger) =>
          this.database.findOrganizationTriggerRevision(trigger.id, trigger.activeRevisionId),
        ),
      ),
      this.database.listOrganizationRunsSince(organizationId, since, RUNS_SHOWN),
      this.database.listOrganizationRunsSince(organizationId, BEGINNING, RECENT_RUNS_SHOWN),
      this.database.countUnroutedProviderEventsSince(organizationId, since),
    ]);
    return {
      organization: tenant.organization,
      appsConfigured: this.providerAppsConfigured(connections),
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
      runs: runs.map(toHomeRun),
      recentRuns: recentRuns.map(toHomeRun),
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

function toHomeRun(run: OrganizationRunRecord): HomeRun {
  return { ...run, receivedAt: run.receivedAt.toISOString() };
}
