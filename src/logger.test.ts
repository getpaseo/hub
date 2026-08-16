import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "vitest";

import { createLogger } from "./logger.js";

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("logger redaction", () => {
  it("does not write token-shaped or secret-keyed values verbatim", () => {
    const stream = new CaptureStream();
    const logger = createLogger(stream);
    const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    const secret = "plain-secret-value";

    logger.info(
      {
        GH_TOKEN: githubToken,
        API_SECRET: "uppercase-secret-key-value",
        jwt,
        secret,
        nested: {
          authHeader: `Bearer ${githubToken}`,
        },
        authored_slug: "worker-one",
      },
      "captured payload",
    );

    const output = stream.text();

    assert.equal(output.includes(githubToken), false);
    assert.equal(output.includes(jwt), false);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("uppercase-secret-key-value"), false);
    assert.equal(output.includes("worker-one"), true);
  });

  it("redacts provider credentials from error messages, stacks, and causes", () => {
    const stream = new CaptureStream();
    const logger = createLogger(stream);
    const secrets = [
      "xoxb-123456789-secret",
      ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      "whsec_abcdefghijklmnopqrstuvwxyz",
      "Bot abcdefghijklmnopqrstuvwxyz.abcdef.abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ];
    const cause = new Error(secrets.join(" "));
    logger.error({ err: new Error(`provider failed: ${secrets[0]}`, { cause }) }, "failure");
    const output = stream.text();
    for (const secret of secrets) assert.equal(output.includes(secret), false);
    assert.match(output, /"stack":/u);
    assert.match(output, /"cause":/u);
    assert.match(
      output,
      /provider failed/u,
      "ordinary diagnostic words following a provider name must remain useful",
    );
  });
});
