import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * The daemon suites depend on the source being packed before any worker starts. Without this,
 * the first daemon test in each worker pays for the build inside its own timeout, which is how
 * an arbitrary daemon test ends up timing out on a loaded runner.
 */
test("hands every worker a source tree that was packed before the run", () => {
  test.skip(!process.env["PASEO_E2E_WORKTREE"], "no source checkout under test");

  const packages = process.env["PASEO_E2E_PACKAGES"];

  expect(packages, "global setup must publish the packed source to its workers").toBeTruthy();
  expect(existsSync(`${packages!}/node_modules/.bin/paseo`)).toBe(true);
});
