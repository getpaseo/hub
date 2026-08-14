import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { loadRuntimeEnvironment } from "./runtime-environment.js";

const TEST_VARIABLE = "PASEO_HUB_RUNTIME_ENVIRONMENT_TEST";
const originalDirectory = process.cwd();
const originalValue = process.env[TEST_VARIABLE];
let temporaryDirectory: string | undefined;

afterEach(async () => {
  process.chdir(originalDirectory);
  if (originalValue === undefined) {
    delete process.env[TEST_VARIABLE];
  } else {
    process.env[TEST_VARIABLE] = originalValue;
  }
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

it("loads dotenv only when the runtime explicitly starts it", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "hub-runtime-environment-"));
  await writeFile(join(temporaryDirectory, ".env"), `${TEST_VARIABLE}=loaded\n`);
  process.chdir(temporaryDirectory);
  delete process.env[TEST_VARIABLE];

  assert.equal(process.env[TEST_VARIABLE], undefined);

  loadRuntimeEnvironment("process-and-dotenv");

  assert.equal(process.env[TEST_VARIABLE], "loaded");
});

it("preserves environment variables supplied by the process", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "hub-runtime-environment-"));
  await writeFile(join(temporaryDirectory, ".env"), `${TEST_VARIABLE}=from-file\n`);
  process.chdir(temporaryDirectory);
  process.env[TEST_VARIABLE] = "from-process";

  loadRuntimeEnvironment("process-and-dotenv");

  assert.equal(process.env[TEST_VARIABLE], "from-process");
});

it("leaves dotenv untouched for process-only launches", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "hub-runtime-environment-"));
  await writeFile(join(temporaryDirectory, ".env"), `${TEST_VARIABLE}=from-file\n`);
  process.chdir(temporaryDirectory);
  delete process.env[TEST_VARIABLE];

  loadRuntimeEnvironment("process-only");

  assert.equal(process.env[TEST_VARIABLE], undefined);
});
