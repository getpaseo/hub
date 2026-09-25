import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  classifyForgejoInstanceVersion,
  forgejoMajorVersion,
  supportsForgejoActionRunHookEvents,
} from "./instance-flavor.js";

describe("classifyForgejoInstanceVersion", () => {
  it("reads a real captured forgejo version string", () => {
    assert.deepEqual(classifyForgejoInstanceVersion("16.0.5+gitea-1.22.0"), {
      flavor: "forgejo",
      version: "16.0.5+gitea-1.22.0",
    });
  });

  it("reads a plain semver as gitea", () => {
    assert.deepEqual(classifyForgejoInstanceVersion("1.22.0"), {
      flavor: "gitea",
      version: "1.22.0",
    });
  });

  it("trims surrounding whitespace before classifying", () => {
    assert.deepEqual(classifyForgejoInstanceVersion("  1.22.0  "), {
      flavor: "gitea",
      version: "1.22.0",
    });
  });

  it("refuses an empty string", () => {
    assert.equal(classifyForgejoInstanceVersion(""), undefined);
  });

  it("refuses a string that is neither a forgejo nor a plain gitea version", () => {
    assert.equal(classifyForgejoInstanceVersion("Gogs 0.12.3"), undefined);
  });
});

describe("forgejoMajorVersion", () => {
  it("reads the leading integer off a real captured version", () => {
    assert.equal(forgejoMajorVersion("16.0.5+gitea-1.22.0"), 16);
  });

  it("reads a dev build's own spelling", () => {
    assert.equal(forgejoMajorVersion("12.0.0-dev-123-abcdef"), 12);
  });

  it("refuses a string with no leading integer", () => {
    assert.equal(forgejoMajorVersion("v16.0.5"), undefined);
  });
});

describe("supportsForgejoActionRunHookEvents", () => {
  it("accepts a forgejo instance at exactly the minimum version", () => {
    assert.equal(
      supportsForgejoActionRunHookEvents({
        instanceFlavor: "forgejo",
        instanceVersion: "12.0.0+gitea-1.22.0",
      }),
      true,
    );
  });

  it("refuses a forgejo instance older than the minimum version", () => {
    assert.equal(
      supportsForgejoActionRunHookEvents({
        instanceFlavor: "forgejo",
        instanceVersion: "11.0.1+gitea-1.22.0",
      }),
      false,
    );
  });

  it("refuses a gitea instance regardless of version", () => {
    assert.equal(
      supportsForgejoActionRunHookEvents({ instanceFlavor: "gitea", instanceVersion: "20.0.0" }),
      false,
    );
  });
});
