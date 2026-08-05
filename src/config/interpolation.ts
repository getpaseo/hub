import {
  parseEnvironmentTemplate,
  type EnvironmentTemplateAst,
  type ParsedEnvironmentTemplate,
} from "./environment-template.js";
import type { WorktreeTarget } from "./schema.js";

export interface InterpolationContext {
  event: unknown;
  connections: ConnectionResolver;
}

export interface ConnectionResolutionContext {
  executionId?: string;
  registerToken?: (token: string) => Promise<void> | void;
}

export type ConnectionResolver = (
  connectionSlug: string,
  value: string,
  context?: ConnectionResolutionContext,
) => Promise<string> | string;

export function createInterpolationContext(
  event: unknown,
  connections: ConnectionResolver = () => {
    throw new Error("no connection resolver registered");
  },
): InterpolationContext {
  return {
    event,
    connections: memoizeConnectionResolver(connections),
  };
}

export async function interpolateTemplate(
  template: ParsedEnvironmentTemplate,
  context: InterpolationContext,
): Promise<string> {
  return interpolateAst(template.ast, context);
}

export async function interpolateAst(
  ast: EnvironmentTemplateAst,
  context: InterpolationContext,
): Promise<string> {
  const parts = await Promise.all(ast.map((node) => resolveNode(node, context)));
  return parts.join("");
}

export async function interpolateRecord(
  record: Readonly<Record<string, ParsedEnvironmentTemplate>> | undefined,
  context: InterpolationContext,
): Promise<Record<string, string>> {
  if (record === undefined) {
    return {};
  }

  const entries = await Promise.all(
    Object.entries(record).map(async ([key, value]) => {
      return [key, await interpolateTemplate(value, context)] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export async function interpolateWorktree(
  worktree: WorktreeTarget,
  context: InterpolationContext,
): Promise<WorktreeTarget> {
  switch (worktree.mode) {
    case "branch-off":
      return {
        mode: "branch-off",
        newBranch: await interpolateTemplate(parseEnvironmentTemplate(worktree.newBranch), context),
        ...(worktree.base === undefined
          ? {}
          : { base: await interpolateTemplate(parseEnvironmentTemplate(worktree.base), context) }),
      };
    case "checkout-branch":
      return {
        mode: "checkout-branch",
        branch: await interpolateTemplate(parseEnvironmentTemplate(worktree.branch), context),
      };
    case "checkout-pr":
      return worktree;
  }
  throw new Error(`unhandled worktree mode: ${JSON.stringify(worktree)}`);
}

async function resolveNode(
  node: EnvironmentTemplateAst[number],
  context: InterpolationContext,
): Promise<string> {
  if (node.kind === "literal") {
    return node.value;
  }

  if (node.kind === "event") {
    return stringifyEventValue(node.raw, readEventPath(context.event, node.path));
  }

  if (node.kind === "connection") {
    return await context.connections(node.slug, node.value);
  }

  throw new Error("unhandled interpolation node");
}

function memoizeConnectionResolver(resolver: ConnectionResolver): ConnectionResolver {
  const values = new Map<string, Promise<string>>();

  return (connectionSlug, value) => {
    const key = `${connectionSlug}:${value}`;
    const cached = values.get(key);
    if (cached !== undefined) return cached;

    const resolved = Promise.resolve().then(() => resolver(connectionSlug, value));
    values.set(key, resolved);
    return resolved;
  };
}

function readEventPath(event: unknown, path: readonly string[]): unknown {
  let cursor: unknown = event;

  for (const segment of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return undefined;
    }

    cursor = Reflect.get(cursor, segment);
  }

  return cursor;
}

function stringifyEventValue(raw: string, value: unknown): string {
  if (value === undefined || value === null) {
    throw new Error(`event path missing for merge variable: ${raw}`);
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
