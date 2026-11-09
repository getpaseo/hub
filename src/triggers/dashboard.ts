import { capabilitiesFor } from "../auth/organization-policy.js";
import type { AuthServer } from "../auth/server.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import type { Database, OrganizationTriggerRecord } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { ProjectCommandError } from "../projects/command-error.js";
import type { ProviderConfigurationCatalog } from "../providers/configuration.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { organizationConnections } from "../providers/resources.js";
import { createTriggerEditor } from "./configuration/editor.js";
import { OrganizationTriggerStore } from "./store.js";

export class TriggerDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly providers: ProviderRegistry,
    private readonly agentValidator: DaemonAgentConfigurationValidator,
  ) {}

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.providers,
      this.agentValidator,
    );
    const [triggers, daemons, connections] = await Promise.all([
      store.list(),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      organizationConnections(this.database, this.providers, tenant.organization.id),
    ]);
    const activity = (
      await Promise.all(triggers.map((trigger) => this.activityForTrigger(trigger)))
    )
      .flat()
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: await Promise.all(
        triggers.map((trigger) =>
          triggerView(
            store,
            trigger,
            this.providers.configuration,
            activity.find(({ triggerId }) => triggerId === trigger.id),
          ),
        ),
      ),
      activity,
      // Only a daemon that can run agents is a target; one enrolled without `hub.execute` would
      // be refused at save, and Home says how to grant it.
      daemons: daemons
        .filter(
          ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug, presence }) => ({ id, slug, presence })),
      connections: [...connections]
        .sort(
          (a, b) =>
            this.providers.require(a.provider).resources.triggerOrder -
            this.providers.require(b.provider).resources.triggerOrder,
        )
        .flatMap(({ provider, connections: items }) =>
          items.map(({ id, slug, label }) => ({ id, slug, provider, label })),
        ),
    };
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined
        ? undefined
        : parseCompiledHubConfig(
            migrationRevision.normalizedConfiguration,
            this.providers.configuration,
          ).triggers[0]?.name;
    const [current, historical] = await Promise.all([
      this.database.listProjectActivityRuns(trigger.runtimeProjectId, 100),
      legacyProjectId === undefined
        ? Promise.resolve([])
        : this.database.listProjectActivityRuns(legacyProjectId, 100),
    ]);
    return [...current, ...historical]
      .filter(
        ({ run }) =>
          current.some((candidate) => candidate.run.id === run.id) ||
          run.configuredTriggerName === legacyTriggerName,
      )
      .map(({ run, receipt }) => ({
        id: run.id,
        triggerId: trigger.id,
        triggerName: trigger.name,
        provider: receipt.provider,
        source: receipt.source,
        repo: receipt.repo,
        status: run.status,
        receivedAt: receipt.receivedAt.toISOString(),
      }));
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { triggerId?: string; yaml: string },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.providers,
      this.agentValidator,
    ).save({
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      yaml: input.yaml,
      userId: account.account.id,
    });
  }
}

async function triggerView(
  store: OrganizationTriggerStore,
  trigger: OrganizationTriggerRecord,
  events: ProviderConfigurationCatalog,
  lastTriggered:
    | { provider: string; source: string; status: string; receivedAt: string }
    | undefined,
) {
  const revision = await store.activeRevision(trigger);
  const evidence = record(revision.sourceEvidence);
  const event = triggerEvent(revision.yaml, lastTriggered?.source);
  const operational =
    lastTriggered === undefined
      ? null
      : { status: lastTriggered.status, receivedAt: lastTriggered.receivedAt };
  if (trigger.format === "legacy_multistep") {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      format: trigger.format,
      yaml: revision.yaml,
      updatedAt: trigger.updatedAt.toISOString(),
      blockers: stringArray(evidence?.["conversionBlockers"]),
      draft: null,
      event,
      provider: triggerProvider(event, lastTriggered?.provider, events),
      lastTriggered: operational,
    };
  }
  const projection = createTriggerEditor(events).projectTriggerForm(revision.yaml);
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    format: trigger.format,
    yaml: revision.yaml,
    updatedAt: trigger.updatedAt.toISOString(),
    blockers: [],
    draft: projection.status === "editable" ? projection.value : null,
    event: projection.status === "editable" ? projection.value.event : event,
    provider: triggerProvider(
      projection.status === "editable" ? projection.value.event : event,
      lastTriggered?.provider,
      events,
    ),
    lastTriggered: operational,
  };
}

function triggerEvent(yaml: string, fallback: string | undefined): string {
  const inline = /^on:\s+([a-z]+(?:\.[a-z_]+)+)\s*$/mu.exec(yaml)?.[1];
  if (inline !== undefined) return inline;
  const nested = /^on:\s*$[\s\S]*?^\s{2}([a-z]+(?:\.[a-z_]+)+):\s*$/mu.exec(yaml)?.[1];
  return nested ?? fallback ?? "manual.run";
}

function triggerProvider(
  event: string,
  fallback: string | undefined,
  events: ProviderConfigurationCatalog,
): string {
  const provider = event.split(".")[0] ?? fallback;
  return provider !== undefined &&
    (provider === "manual" ||
      provider === "schedule" ||
      events.list().some((id) => events.definition(id).provider === provider))
    ? provider
    : "manual";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
