import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

/*
 * Mechanical half of docs/design.md. Everything here is a rule a regular expression can see:
 * one font weight, no letter-spacing, no shouting, no arbitrary sizes or colours, no theme
 * variants. The rest of the contract — density, hierarchy, which component owns which shape —
 * is on review.
 */

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const sourceExtensions = new Set([".css", ".ts", ".tsx"]);

const weightClass =
  /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|title|[1-9]00)\b/g;

/** `font-title` is the one elevated weight, and it goes on the one title of a surface. */
const titleTags = ["<h1", "<DialogTitle", "<AlertDialogTitle", "<SheetTitle", "<AuthCard"];

/** The components that own a surface title; inside them `font-title` is not attached to a tag. */
const titleOwners = new Set([
  "components/ui/dialog.tsx",
  "components/ui/alert-dialog.tsx",
  "components/ui/sheet.tsx",
  "components/app/page.tsx",
  "components/app/auth-layout.tsx",
]);

const forbidden: { rule: string; pattern: RegExp; extensions?: Set<string> }[] = [
  { rule: "letter-spacing utility", pattern: /\btracking-/g },
  { rule: "uppercase", pattern: /\buppercase\b/g },
  { rule: "text-transform", pattern: /\btext-transform\b/g },
  { rule: "letter-spacing", pattern: /\bletter-spacing\b/g },
  { rule: "arbitrary text size", pattern: /\btext-\[/g },
  { rule: "arbitrary font", pattern: /\bfont-\[/g },
  { rule: "dark: variant", pattern: /\bdark:/g },
  { rule: "inline font weight", pattern: /\bfontWeight\b/g },
  { rule: "bold element", pattern: /<(?:strong|b)[\s>]/g },
  { rule: "hex colour", pattern: /#[0-9a-f]{3,8}\b/gi, extensions: new Set([".tsx"]) },
];

/** The theme tokens that define the scale itself; every other weight declaration must be 400. */
const weightTokens = new Set(["--font-weight-*", "--font-weight-normal", "--font-weight-title"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!sourceExtensions.has(extname(entry.name)) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

function isSurfaceTitle(source: string, index: number, name: string): boolean {
  if (titleOwners.has(name)) return true;
  const openingTagEnd = source.lastIndexOf(">", index);
  return titleTags.some((tag) => source.lastIndexOf(tag, index) > openingTagEnd);
}

function declaredWeights(source: string): string[] {
  const declarations = source.matchAll(/(--)?font-weight([\w*-]*)\s*:\s*([^;}]+)/g);
  return [...declarations].flatMap((declaration) => {
    const property = `${declaration[1] ?? ""}font-weight${declaration[2] ?? ""}`;
    if (property.startsWith("--")) {
      return weightTokens.has(property) ? [] : [`weight token ${property}`];
    }
    const value = (declaration[3] ?? "").replace(/!important/g, "").trim();
    return value === "400" ? [] : [`font-weight: ${value}`];
  });
}

describe("design contract", () => {
  it("holds everywhere a regex can see it", () => {
    const violations: string[] = [];

    for (const path of sourceFiles(sourceRoot)) {
      const source = readFileSync(path, "utf8");
      const name = relative(sourceRoot, path).split(sep).join("/");
      const extension = extname(path);

      for (const match of source.matchAll(weightClass)) {
        if (match[0] === "font-title" && isSurfaceTitle(source, match.index, name)) continue;
        violations.push(`${name}: ${match[0]}`);
      }

      for (const { rule, pattern, extensions } of forbidden) {
        if (extensions && !extensions.has(extension)) continue;
        for (const match of source.matchAll(pattern)) {
          violations.push(`${name}: ${rule} (${match[0].trim()})`);
        }
      }

      for (const weight of declaredWeights(source)) {
        violations.push(`${name}: ${weight}`);
      }
    }

    assert.deepEqual(violations, []);
  });
});
