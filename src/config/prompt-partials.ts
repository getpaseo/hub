import { createHash } from "node:crypto";

export const PROMPT_PARTIAL_ROOT = ".paseo/partials";

export interface ResolvedPromptPartial {
  path: string;
  content: string;
  contentHash: string;
}

export type ResolvedPromptPartials = ReadonlyMap<string, ResolvedPromptPartial>;

export type PromptPartialReadResult =
  | { kind: "file"; content: string }
  | { kind: "directory" }
  | { kind: "symlink" }
  | { kind: "submodule" };

export class PromptPartialResolutionError extends Error {
  constructor(message: string) {
    super(`invalid prompt partial: ${message}`);
    this.name = "PromptPartialResolutionError";
  }
}

export function validatePromptPartialPath(value: string): string {
  const decoded = decodePromptPartialPath(value);
  if (decoded.length === 0) throw new PromptPartialResolutionError("path is empty");
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/u.test(decoded)) {
    throw new PromptPartialResolutionError(`path must be relative to ${PROMPT_PARTIAL_ROOT}/`);
  }

  const segments = decoded.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PromptPartialResolutionError(
      `path must not contain empty, '.' or '..' segments: ${value}`,
    );
  }
  const repositoryPath = `${PROMPT_PARTIAL_ROOT}/${segments.join("/")}`;
  if (!repositoryPath.startsWith(`${PROMPT_PARTIAL_ROOT}/`)) {
    throw new PromptPartialResolutionError(`path escapes ${PROMPT_PARTIAL_ROOT}/`);
  }
  return repositoryPath;
}

export function validateResolvedPromptPartialPath(value: string): string {
  const prefix = `${PROMPT_PARTIAL_ROOT}/`;
  if (!value.startsWith(prefix)) {
    throw new PromptPartialResolutionError(`resolved path is outside ${prefix}`);
  }
  const relative = value.slice(prefix.length);
  const validated = validatePromptPartialPath(relative);
  if (validated !== value) {
    throw new PromptPartialResolutionError(`resolved path is not canonical: ${value}`);
  }
  return validated;
}

export function hashPromptPartialContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function collectPromptPartialPaths(configuration: unknown): readonly string[] {
  const paths = new Set<string>();
  if (!isRecord(configuration) || !Array.isArray(configuration["triggers"])) return [];
  for (const trigger of configuration["triggers"]) {
    if (!isRecord(trigger) || !Array.isArray(trigger["steps"])) continue;
    for (const step of trigger["steps"]) {
      if (!isRecord(step) || !Array.isArray(step["prompt"])) continue;
      for (const block of step["prompt"]) {
        if (!isRecord(block) || !Object.hasOwn(block, "include")) continue;
        if (typeof block["include"] !== "string") {
          throw new PromptPartialResolutionError("include path must be a string");
        }
        paths.add(validatePromptPartialPath(block["include"]));
      }
    }
  }
  return [...paths];
}

export async function resolvePromptPartials(input: {
  configuration: unknown;
  read(path: string): Promise<PromptPartialReadResult | undefined>;
}): Promise<ResolvedPromptPartials> {
  const resolved = new Map<string, ResolvedPromptPartial>();
  for (const path of collectPromptPartialPaths(input.configuration)) {
    const file = await input.read(path);
    if (file === undefined) {
      throw new PromptPartialResolutionError(`file does not exist at exact commit: ${path}`);
    }
    if (file.kind !== "file") {
      throw new PromptPartialResolutionError(`${path} is not a regular file (${file.kind})`);
    }
    resolved.set(path, {
      path,
      content: file.content,
      contentHash: hashPromptPartialContent(file.content),
    });
  }
  return resolved;
}

function decodePromptPartialPath(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new PromptPartialResolutionError(`path contains invalid encoding: ${value}`);
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0")) {
    throw new PromptPartialResolutionError(`path contains a null byte: ${value}`);
  }
  if (/%[0-9a-f]{2}/iu.test(decoded)) {
    throw new PromptPartialResolutionError(`path contains encoded characters: ${value}`);
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
