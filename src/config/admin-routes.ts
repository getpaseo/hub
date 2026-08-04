import { load } from "js-yaml";
import { z } from "zod";
import type { OperationAuthorization } from "../auth/api-keys.js";
import type { Database } from "../db/types.js";
import { ProjectConfigurationStore } from "../configuration/store.js";

const InstallSchema = z
  .object({
    projectSlug: z.string().min(1),
    yaml: z.string().min(1),
  })
  .strict();

export async function installConfiguration(
  request: Request,
  database: Database,
  storeForProject: (projectId: string) => ProjectConfigurationStore,
  authorization: OperationAuthorization,
): Promise<Response> {
  const body = InstallSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const project = await database.findProjectBySlugForOrganization(
    authorization.organizationId,
    body.data.projectSlug,
  );
  if (project === undefined || project.status !== "active") {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }
  const store = storeForProject(project.id);
  let rawConfig: unknown;
  try {
    rawConfig = load(body.data.yaml);
  } catch {
    return Response.json({ error: "invalid_yaml" }, { status: 422 });
  }
  const record = await store.insertManualRevision({
    rawYaml: body.data.yaml,
    rawConfiguration: rawConfig,
    userId: null,
    sourceEvidence: { kind: "api-key", keyId: authorization.keyId },
  });
  if (record.validationErrors !== null) {
    return Response.json({ error: "invalid_config", versionId: record.id }, { status: 422 });
  }
  const promoted = await store.activate(record.id);
  return Response.json(
    {
      projectSlug: project.slug,
      versionId: promoted.revision.id,
      version: promoted.revision.version,
      active: true,
    },
    { status: 201 },
  );
}
