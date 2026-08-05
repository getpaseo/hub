export type EnvironmentTemplateAst = readonly (
  | { kind: "literal"; value: string }
  | { kind: "event"; path: readonly string[]; raw: string }
  | { kind: "connection"; slug: string; value: string; raw: string }
)[];

export interface ParsedEnvironmentTemplate {
  value: string;
  ast: EnvironmentTemplateAst;
}

const VARIABLE = /\$\{\{\s*([^}]+?)\s*\}\}/gu;

export function parseEnvironmentTemplate(value: string): ParsedEnvironmentTemplate {
  const ast: Array<EnvironmentTemplateAst[number]> = [];
  let cursor = 0;
  for (const match of value.matchAll(VARIABLE)) {
    const raw = match[0];
    const expression = match[1];
    const index = match.index;
    if (expression === undefined || index === undefined) continue;
    if (index > cursor) ast.push({ kind: "literal", value: value.slice(cursor, index) });
    ast.push(parseVariable(raw, expression));
    cursor = index + raw.length;
  }
  if (cursor < value.length) ast.push({ kind: "literal", value: value.slice(cursor) });
  if (ast.length === 0) ast.push({ kind: "literal", value });
  return { value, ast };
}

function parseVariable(raw: string, expression: string): EnvironmentTemplateAst[number] {
  const parts = expression.trim().split(".");
  if (parts[0] !== "paseo") throw new Error(`unsupported environment template: ${raw}`);
  if (parts[1] === "event" && parts.length > 2) {
    return { kind: "event", path: parts.slice(2), raw };
  }
  if (
    parts[1] === "connections" &&
    parts.length === 4 &&
    parts[2] !== undefined &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parts[2]) &&
    parts[3] !== undefined &&
    /^[a-z][a-z0-9_]*$/u.test(parts[3])
  ) {
    return { kind: "connection", slug: parts[2], value: parts[3], raw };
  }
  throw new Error(`unsupported environment template: ${raw}`);
}
