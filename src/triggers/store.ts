import type {
  Database,
  OrganizationTriggerRecord,
  OrganizationTriggerRevisionRecord,
} from "../db/types.js";
import {
  resolveTriggerConfigurationForOrganization,
  type CompiledProjectConfiguration,
  type DaemonAgentConfigurationValidator,
} from "../configuration/store.js";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  TriggerDocumentError,
  type CompiledTriggerDocument,
  type TriggerDocument,
  type TriggerDocumentIssue,
} from "./configuration/index.js";
import { supportsUnattendedRuns, unattendedProviderRefusal } from "./configuration/unattended.js";

export interface SaveTriggerInput {
  triggerId?: string;
  yaml: string;
  userId: string | null;
  sourceKind?: "manual" | "github";
  sourceEvidence?: unknown;
}

type AuthoredAgent = Extract<TriggerDocument["run"]["agent"], { provider: string }>;

export class OrganizationTriggerStore {
  constructor(
    private readonly database: Database,
    private readonly organizationId: string,
    /**
     * The daemon's own answer about an agent. Provider, model, mode, thinking option, and options
     * are facts about the daemon that will run the trigger, not about the document, so the store
     * asks that daemon before anything is stored.
     */
    private readonly agentValidator: DaemonAgentConfigurationValidator,
  ) {}

  list(): Promise<OrganizationTriggerRecord[]> {
    return this.database.listOrganizationTriggers(this.organizationId);
  }

  async activeRevision(
    trigger: OrganizationTriggerRecord,
  ): Promise<OrganizationTriggerRevisionRecord> {
    if (trigger.organizationId !== this.organizationId) {
      throw new Error("organization trigger not found");
    }
    const revision = await this.database.findOrganizationTriggerRevision(
      trigger.id,
      trigger.activeRevisionId,
    );
    if (revision === undefined) throw new Error("active trigger revision not found");
    return revision;
  }

  async save(input: SaveTriggerInput): Promise<OrganizationTriggerRecord> {
    const previousYaml = await this.activeYaml(input.triggerId);
    const prepared = await this.validate(
      input.yaml,
      previousYaml === undefined ? {} : { previousYaml },
    );
    const recurrence = prepared.compiled.authored.on["schedule.tick"]?.recurrence;
    return this.database.saveOrganizationTrigger({
      organizationId: this.organizationId,
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      ...(recurrence === undefined ? {} : { recurrence }),
      name: prepared.compiled.authored.name,
      enabled: prepared.compiled.authored.enabled,
      format: "single_run",
      yaml: input.yaml,
      normalizedConfiguration: prepared.resolved.configuration,
      contentHash: prepared.compiled.authoredHash,
      sourceKind: input.sourceKind ?? "manual",
      sourceEvidence: input.sourceEvidence ?? {
        kind: "manual",
        authoredFormat: "self_contained_trigger_v1",
      },
      createdByUserId: input.userId,
      routes: prepared.compiled.authored.enabled ? prepared.resolved.routes : [],
    });
  }

  /**
   * Everything that has to be true before a document becomes a trigger. `previousYaml` is the
   * revision being replaced: an unchanged document skips the authoring contract (a preserved
   * legacy trigger may be re-saved as it is), and a document that keeps its target and agent
   * skips the daemon — a prompt edit does not need the daemon online, a new agent does.
   */
  async validate(yaml: string, options: { previousYaml?: string } = {}) {
    const compiled = compileTriggerDocument(yaml);
    if (options.previousYaml !== yaml) validateAuthoringContract(compiled.authored);
    const resolved = await resolveTriggerConfigurationForOrganization(
      this.database,
      this.organizationId,
      {
        environments: [compiled.environment],
        triggers: compiled.events,
      },
    );
    if (!resolved.success) {
      throw new TriggerDocumentError(resolved.issues);
    }
    if (options.previousYaml === undefined || runtimeChanged(options.previousYaml, compiled)) {
      await this.validateAgainstDaemon(compiled, resolved.configuration);
    }
    return { compiled, resolved };
  }

  private async activeYaml(triggerId: string | undefined): Promise<string | undefined> {
    if (triggerId === undefined) return undefined;
    const trigger = (await this.list()).find(({ id }) => id === triggerId);
    if (trigger === undefined) return undefined;
    return (await this.activeRevision(trigger)).yaml;
  }

  private async validateAgainstDaemon(
    compiled: CompiledTriggerDocument,
    configuration: CompiledProjectConfiguration,
  ): Promise<void> {
    const target = configuration.environments.find((environment) => environment.kind === "daemon");
    if (target === undefined) throw new Error("compiled trigger target is missing");
    const issues: TriggerDocumentIssue[] = [];
    for (const { path, agent } of authoredAgents(compiled.authored)) {
      if (!supportsUnattendedRuns(agent.provider)) {
        issues.push({
          path: [...path, "provider"],
          message: unattendedProviderRefusal(agent.provider),
        });
        continue;
      }
      let verdict: Awaited<
        ReturnType<DaemonAgentConfigurationValidator["validateAgentConfiguration"]>
      >;
      try {
        verdict = await this.agentValidator.validateAgentConfiguration(target.daemonId, agent);
      } catch (error) {
        throw new TriggerDocumentError([
          {
            path: ["run", "target", "daemon"],
            message: daemonUnavailable(compiled.authored.run.target.daemon, error),
          },
        ]);
      }
      if (!verdict.valid) {
        issues.push(
          ...verdict.issues.map((issue) => ({
            path: [...path, ...issue.path.map(authoredFieldName)],
            message: issue.message,
          })),
        );
      }
    }
    if (issues.length > 0) throw new TriggerDocumentError(issues);
  }
}

/** Every agent the document may launch, each addressed by where it is written. */
function authoredAgents(
  trigger: TriggerDocument,
): readonly { path: readonly string[]; agent: AuthoredAgent }[] {
  if ("choices" in trigger.run.agent) {
    return Object.entries(trigger.run.agent.choices).map(([name, agent]) => ({
      path: ["run", "agent", "choices", name],
      agent,
    }));
  }
  return [{ path: ["run", "agent"], agent: trigger.run.agent }];
}

/** The daemon names fields by its own wire contract; the document names them by its schema. */
function authoredFieldName(segment: string | number): string | number {
  if (segment === "modeId") return "mode";
  if (segment === "providerOptions") return "options";
  return segment;
}

function daemonUnavailable(slug: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason === "daemon_not_connected") {
    return `"${slug}" is not connected, so Hub cannot check this agent against it. Connect the daemon and save again.`;
  }
  if (reason === "daemon_execution_not_allowed") {
    return `"${slug}" cannot run Hub automations. Run \`paseo hub permissions grant hub.execute\` on it and save again.`;
  }
  return `"${slug}" could not check this agent: ${reason}`;
}

/** Whether the daemon has anything new to say: the target or an agent differs from what runs now. */
function runtimeChanged(previousYaml: string, compiled: CompiledTriggerDocument): boolean {
  let previous: TriggerDocument;
  try {
    previous = parseTriggerDocument(previousYaml);
  } catch {
    return true;
  }
  const runtime = (document: TriggerDocument) =>
    JSON.stringify({ target: document.run.target, agent: document.run.agent });
  return runtime(previous) !== runtime(compiled.authored);
}

function validateAuthoringContract(trigger: TriggerDocument): void {
  const issues: Array<{ path: readonly (string | number)[]; message: string }> = [];
  if (!trigger.run.target.cwd.startsWith("/")) {
    issues.push({ path: ["run", "target", "cwd"], message: "must be an absolute path" });
  }
  for (const { path, agent } of authoredAgents(trigger)) {
    if (agent.mode === undefined) {
      issues.push({ path: [...path, "mode"], message: "is required for new triggers" });
    }
  }
  if (issues.length > 0) throw new TriggerDocumentError(issues);
}
