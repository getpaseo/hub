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
        jwt,
        secret,
        nested: {
          authHeader: `Bearer ${githubToken}`,
        },
      },
      "captured payload",
    );

    const output = stream.text();

    assert.equal(output.includes(githubToken), false);
    assert.equal(output.includes(jwt), false);
    assert.equal(output.includes(secret), false);
  });
});
