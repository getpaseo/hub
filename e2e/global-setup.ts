import { prebuildPaseoArtifacts, resolvePaseoWorktree } from "../src/e2e/harness/source-paseo.js";

/**
 * Packs and installs the Paseo source once, before any worker starts.
 *
 * Tests that enroll a daemon call `SourcePaseo.start()`, which packs six workspaces and installs
 * the tarballs. Done from inside a test, that work spends the test's own 120s budget, and on a
 * loaded runner it was enough to exhaust it — one arbitrary daemon test timing out per run. Built
 * here it costs nothing that a test is timed against, and every worker inherits the result.
 *
 * Suites that never reach for the source checkout leave `PASEO_E2E_WORKTREE` unset; there is
 * nothing to build for them and nothing to fail.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env["PASEO_E2E_WORKTREE"]) return;
  await prebuildPaseoArtifacts(resolvePaseoWorktree());
}
