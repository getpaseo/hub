import { load } from "js-yaml";
import { z } from "zod";

export type DeploymentDocument =
  | { success: true; configuration: unknown }
  | {
      success: false;
      kind: "invalid_yaml" | "invalid_document";
      issues: readonly { path: readonly string[]; message: string }[];
    };

export function parseDeploymentDocument(yaml: string): DeploymentDocument {
  let parsed: unknown;
  try {
    parsed = load(yaml);
  } catch (error) {
    return {
      success: false,
      kind: "invalid_yaml",
      issues: [{ path: ["yaml"], message: yamlMessage(error) }],
    };
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, "project")) {
    return { success: true, configuration: parsed };
  }
  if (typeof parsed["project"] !== "string" || parsed["project"].trim().length === 0)
    return invalidProject();
  const configuration = { ...parsed };
  delete configuration["project"];
  return { success: true, configuration };
}

function invalidProject() {
  return {
    success: false as const,
    kind: "invalid_document" as const,
    issues: [
      {
        path: ["project"] as readonly string[],
        message: "Project must be a non-empty string.",
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlMessage(error: unknown): string {
  const parsed = z
    .object({ mark: z.object({ line: z.number(), column: z.number() }).optional() })
    .passthrough()
    .safeParse(error);
  const mark = parsed.success ? parsed.data.mark : undefined;
  return mark === undefined
    ? "The configuration is not valid YAML."
    : `Invalid YAML at line ${mark.line + 1}, column ${mark.column + 1}.`;
}
