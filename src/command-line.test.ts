import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isCommandLineEntrypoint, readHubCommandLine } from "./command-line.js";

describe("Hub command line", () => {
  it("loads dotenv by default", () => {
    assert.deepEqual(readHubCommandLine(["node", "/hub/index.js"]), {
      environmentSource: "process-and-dotenv",
    });
  });

  it("maps --no-env to process-only configuration", () => {
    assert.deepEqual(readHubCommandLine(["node", "/hub/index.js", "--no-env"]), {
      environmentSource: "process-only",
    });
  });

  it("ignores arguments owned by the outer Vite command", () => {
    assert.deepEqual(
      readHubCommandLine(["node", "/hub/vite.js", "dev", "--port", "3000", "--no-env"]),
      { environmentSource: "process-only" },
    );
  });

  it("recognizes only the requested module as the executable entrypoint", () => {
    assert.equal(isCommandLineEntrypoint("file:///hub/index.js", ["node", "/hub/index.js"]), true);
    assert.equal(
      isCommandLineEntrypoint("file:///hub/index.js", ["node", "/hub/another.js"]),
      false,
    );
  });
});
