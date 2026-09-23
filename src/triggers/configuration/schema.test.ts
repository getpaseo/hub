import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isAbsoluteTargetPath } from "./schema.js";

describe("isAbsoluteTargetPath", () => {
  it.each([
    ["/srv/x", true],
    ["D:\\x\\y", true],
    ["D:/x/y", true],
    ["\\\\server\\share", true],
    ["workspace", false],
    ["./x", false],
    ["x/y", false],
  ])("%s -> %s", (path, expected) => {
    assert.equal(isAbsoluteTargetPath(path), expected);
  });
});
