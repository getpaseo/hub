#!/usr/bin/env node
/**
 * Capture real Forgejo webhook deliveries as fixtures.
 * Run: node scripts/capture-forgejo-fixtures.mjs (needs `podman machine` running).
 *
 * Drives real actions against a throwaway Forgejo container, scrubs and re-signs each
 * delivery, and writes them to `src/triggers/fixtures/forgejo/`. The image tag is pinned
 * so a re-run months from now still reproduces the same event shapes.
 * `action-run-failure.json`/`action-run-success.json` are hand-built instead, from
 * Forgejo's Go structs, since capturing them needs a registered Actions runner.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiClient, freePort, mintToken } from "./lib/forgejo-capture-api.mjs";
import { fixtureWriter } from "./lib/forgejo-capture-fixtures-io.mjs";
import {
  createInstanceUser,
  startContainer,
  stopContainer,
  waitForReady,
} from "./lib/forgejo-capture-instance.mjs";
import { startCaptureListener } from "./lib/forgejo-capture-listener.mjs";
import { FIXTURE_WEBHOOK_SECRET } from "./lib/forgejo-capture-scrub.mjs";
import { drive, HOOK_EVENTS } from "./lib/forgejo-capture-scenarios.mjs";

const IMAGE = "codeberg.org/forgejo/forgejo:16";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(ROOT, "src/triggers/fixtures/forgejo");
const API_FIXTURES_DIR = path.join(FIXTURES_DIR, "api");

const TRILLIAN = {
  username: "trillian",
  password: "PoemsAreBad42!Q",
  email: "trillian@example.test",
};
const ZAPHOD = {
  username: "zaphod",
  password: "TwoHeadsAreBetter1!Q",
  email: "zaphod@example.test",
};

async function main() {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await mkdir(API_FIXTURES_DIR, { recursive: true });

  const forgejoPort = await freePort();
  const capturePort = await freePort();
  const base = `http://127.0.0.1:${forgejoPort}`;
  // ROOT_URL is the `localhost` spelling, which is what Forgejo stamps into every
  // html_url/avatar_url it emits, not the 127.0.0.1 the API is reached on. Scrub
  // against that spelling, not `base`.
  const rootUrl = `http://localhost:${forgejoPort}`;
  const fixtures = fixtureWriter(FIXTURES_DIR, API_FIXTURES_DIR, rootUrl);
  let listener;

  try {
    process.stderr.write(`starting ${IMAGE} on port ${forgejoPort}...\n`);
    startContainer(IMAGE, forgejoPort);
    await waitForReady(base);

    createInstanceUser(TRILLIAN.username, TRILLIAN.password, TRILLIAN.email, { admin: true });
    createInstanceUser(ZAPHOD.username, ZAPHOD.password, ZAPHOD.email);

    const trillian = apiClient(base, await mintToken(base, TRILLIAN));
    const zaphod = apiClient(base, await mintToken(base, ZAPHOD));

    await trillian("POST", "/api/v1/orgs", { username: "acme" });
    await trillian("POST", "/api/v1/orgs/acme/repos", { name: "widgets", auto_init: true });
    await trillian("POST", "/api/v1/repos/acme/widgets/labels", { name: "bug", color: "ee0701" });
    await trillian("POST", "/api/v1/repos/acme/widgets/labels", {
      name: "triage",
      color: "fbca04",
    });
    await trillian("PUT", "/api/v1/repos/acme/widgets/collaborators/zaphod", {
      permission: "write",
    });

    listener = await startCaptureListener(capturePort);
    const hookResponse = await trillian("POST", "/api/v1/repos/acme/widgets/hooks", {
      type: "forgejo",
      config: {
        url: `http://host.containers.internal:${capturePort}/capture`,
        content_type: "json",
        secret: FIXTURE_WEBHOOK_SECRET,
      },
      events: HOOK_EVENTS,
      active: true,
    });
    await fixtures.saveApiFixture("hook-create", hookResponse.body);

    await drive({ trillian, zaphod, listener, fixtures });

    const versionResponse = await trillian("GET", "/api/v1/version");
    await fixtures.saveApiFixture("version", versionResponse.body);

    process.stderr.write(`wrote fixtures to ${FIXTURES_DIR}\n`);
  } finally {
    if (listener) await listener.close();
    stopContainer();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
