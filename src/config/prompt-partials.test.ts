import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  hashPromptPartialContent,
  resolvePromptPartials,
  validatePromptPartialPath,
} from "./prompt-partials.js";

describe("prompt partial resolution", () => {
  it("resolves a relative path once and treats nested include-looking text as content", async () => {
    const content = "Do this literally: { include: nested.md }";
    const resolved = await resolvePromptPartials({
      configuration: {
        triggers: [{ steps: [{ prompt: [{ include: "docs/safety.md" }] }] }],
      },
      read: async (path) => {
        assert.equal(path, ".paseo/partials/docs/safety.md");
        return { kind: "file", content };
      },
    });

    assert.deepEqual(
      [...resolved.values()],
      [
        {
          path: ".paseo/partials/docs/safety.md",
          content,
          contentHash: hashPromptPartialContent(content),
        },
      ],
    );
  });

  it.each([
    "../secret.md",
    "nested/../../secret.md",
    "%2e%2e/secret.md",
    "%252e%252e/secret.md",
    "/etc/passwd",
    "\\\\server\\share\\secret.md",
    "C:\\secret.md",
    "docs/./safety.md",
  ])("rejects unsafe partial path %s", (path) => {
    assert.throws(() => validatePromptPartialPath(path), /invalid prompt partial/iu);
  });

  it.each([
    { kind: "directory" as const },
    { kind: "symlink" as const },
    { kind: "submodule" as const },
  ])("rejects a GitHub object that is not a regular file (%s)", async (object) => {
    await assert.rejects(
      resolvePromptPartials({
        configuration: { triggers: [{ steps: [{ prompt: [{ include: "safety.md" }] }] }] },
        read: async () => object,
      }),
      /not a regular file/iu,
    );
  });

  it("rejects a missing partial", async () => {
    await assert.rejects(
      resolvePromptPartials({
        configuration: { triggers: [{ steps: [{ prompt: [{ include: "missing.md" }] }] }] },
        read: async () => undefined,
      }),
      /does not exist at exact commit/iu,
    );
  });
});
