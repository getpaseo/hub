import assert from "node:assert/strict";
import test from "node:test";
import { scrubText } from "./forgejo-capture-scrub.mjs";

const ORIGIN = "http://localhost:34567";

test("rewrites the forgejo origin to the fixture host", () => {
  const text = `"url":"${ORIGIN}/api/v1/repos/acme/widgets"`;
  assert.equal(
    scrubText(text, ORIGIN),
    '"url":"https://git.example.test/api/v1/repos/acme/widgets"',
  );
});

test("rewrites the container-only capture listener host", () => {
  const text = '"config_url":"http://host.containers.internal:9001/capture"';
  assert.equal(scrubText(text, ORIGIN), '"config_url":"https://hub.example.test/capture"');
});

// ssh_url carries `ssh://git@localhost/...` with no port, so it never matches the
// `http://localhost:PORT` origin string the split above catches.
test("rewrites the bare ssh_url localhost the origin split misses", () => {
  const text = '"ssh_url":"ssh://git@localhost/acme/widgets.git"';
  assert.equal(scrubText(text, ORIGIN), '"ssh_url":"ssh://git@git.example.test/acme/widgets.git"');
});

test("rewrites a ported ssh_url localhost too", () => {
  const text = '"ssh_url":"ssh://git@localhost:2222/acme/widgets.git"';
  assert.equal(scrubText(text, ORIGIN), '"ssh_url":"ssh://git@git.example.test/acme/widgets.git"');
});

test("does not touch an unrelated localhost mention", () => {
  const text = '"note":"reach it at localhost in dev"';
  assert.equal(scrubText(text, ORIGIN), text);
});
