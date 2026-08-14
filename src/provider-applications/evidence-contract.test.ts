import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

describe("operator app screenshot evidence", () => {
  it("has exactly one writer for every evidence filename", async () => {
    const sources = await Promise.all(
      ["e2e/apps.spec.ts", "e2e/apps-mobile.spec.ts"].map((path) => readFile(path, "utf8")),
    );
    const writers: string[] = [];
    for (const source of sources) {
      for (const match of source.matchAll(/\.shoot\(SHOTS, "([^"]+)"\)/gu)) {
        writers.push(match[1]!);
      }
    }

    assert.equal(new Set(writers).size, writers.length);
  });
});
