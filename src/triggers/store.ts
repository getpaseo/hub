import type {
  Database,
  OrganizationTriggerRecord,
  OrganizationTriggerRevisionRecord,
} from "../db/types.js";
import { resolveTriggerConfigurationForOrganization } from "../configuration/store.js";
import { compileTriggerDocument, TriggerDocumentError } from "./configuration/index.js";

export interface SaveTriggerInput {
  triggerId?: string;
  yaml: string;
  userId: string | null;
  sourceKind?: "manual" | "github";
  sourceEvidence?: unknown;
}

export class OrganizationTriggerStore {
  constructor(
    private readonly database: Database,
    private readonly organizationId: string,
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
    const prepared = await this.validate(input.yaml);
    return this.database.saveOrganizationTrigger({
      organizationId: this.organizationId,
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
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

  async validate(yaml: string) {
    const compiled = compileTriggerDocument(yaml);
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
    return { compiled, resolved };
  }
}
