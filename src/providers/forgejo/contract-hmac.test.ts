import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { field, list, readJson, record, text, texts } from "./contract-test-read.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "contract-fixtures");

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

describe("Forgejo 16.0.3 signed contract fixtures", () => {
  it("verifies every webhook fixture against the sanitized secret and exact raw bytes", async () => {
    const manifest = record(await readJson(join(fixturesRoot, "manifest.json")), "manifest");
    assert.equal(field(manifest, "secret"), "test-webhook-secret");
    assert.equal(field(manifest, "origin"), "https://forgejo.example.test");
    const deliveries = list(field(manifest, "deliveries"), "deliveries");
    assert.equal(deliveries.length > 0, true);

    for (const entry of deliveries) {
      const delivery = record(entry, "delivery");
      const name = text(field(delivery, "name"), "name");
      const fixture = record(
        await readJson(join(fixturesRoot, text(field(delivery, "file"), "file"))),
        name,
      );
      const headers = record(field(fixture, "headers"), `${name} headers`);
      const raw = text(field(fixture, "raw"), `${name} raw`);
      const expected = hmacHex(text(field(manifest, "secret"), "secret"), raw);
      assert.equal(field(headers, "x-forgejo-event"), field(delivery, "event"), name);
      assert.equal(field(headers, "x-forgejo-event-type"), field(delivery, "eventType"), name);
      assert.match(
        text(field(headers, "x-forgejo-delivery"), "delivery header"),
        /^[0-9a-f-]{36}$/u,
      );
      const signature = text(field(headers, "x-forgejo-signature"), "signature");
      assert.match(signature, /^[0-9a-f]{64}$/u);
      assert.equal(signature.startsWith("sha256="), false);
      assert.equal(equal(signature, expected), true, name);
      assert.equal(field(headers, "x-hub-signature-256"), `sha256=${expected}`, name);
      assert.equal(equal(hmacHex("wrong-secret", raw), expected), false);
    }
  });

  it("rejects a GitHub-prefixed signature as the Forgejo header value", async () => {
    const manifest = record(await readJson(join(fixturesRoot, "manifest.json")), "manifest");
    const first = list(field(manifest, "deliveries"), "deliveries")[0];
    assert.notEqual(first, undefined);
    const delivery = record(first, "first delivery");
    const fixture = record(
      await readJson(join(fixturesRoot, text(field(delivery, "file"), "file"))),
      "fixture",
    );
    const prefixed = `sha256=${hmacHex(
      text(field(manifest, "secret"), "secret"),
      text(field(fixture, "raw"), "raw"),
    )}`;
    const headers = record(field(fixture, "headers"), "headers");
    assert.equal(equal(text(field(headers, "x-forgejo-signature"), "signature"), prefixed), false);
  });

  it("covers the six raw families and six semantic classifications", async () => {
    const manifest = record(await readJson(join(fixturesRoot, "manifest.json")), "manifest");
    assert.deepEqual(texts(field(manifest, "rawFamilies"), "rawFamilies"), [
      "forgejo.issues",
      "forgejo.issue_comment",
      "forgejo.pull_request",
      "forgejo.pull_request_review",
      "forgejo.pull_request_review_comment",
      "forgejo.push",
    ]);
    assert.deepEqual(texts(field(manifest, "semanticFamilies"), "semanticFamilies"), [
      "forgejo.issue_created",
      "forgejo.pull_request_created",
      "forgejo.issue_comment_created",
      "forgejo.pull_request_comment_created",
      "forgejo.issue_label_added",
      "forgejo.pull_request_label_added",
    ]);
    const names = new Set(
      list(field(manifest, "deliveries"), "deliveries").map((entry) =>
        text(field(record(entry, "delivery"), "name"), "name"),
      ),
    );
    for (const required of [
      "issues-opened",
      "issue-comment-created",
      "issue-label-updated",
      "pull-request-opened",
      "pull-request-comment-created",
      "pull-request-label-updated",
      "pull-request-review-submitted",
      "push-default-branch",
    ]) {
      assert.equal(names.has(required), true, required);
    }
  });

  it("keeps fixture JSON free of live capture hosts and isolated passwords", async () => {
    const files = await readdir(fixturesRoot, { recursive: true });
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(fixturesRoot, file), "utf8");
      assert.doesNotMatch(content, /127\.0\.0\.1:30163/u);
      assert.doesNotMatch(content, /T00-.*Pass/u);
      assert.doesNotMatch(content, /t00-isolated-webhook-secret/u);
      assert.doesNotMatch(content, /example\.invalid/u);
    }
  });
});
