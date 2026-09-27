import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NO_ALLOWED_PRIVATE_HOSTS, parseAllowedPrivateHosts } from "./instance-guard.js";
import { createForgejoLookup, type RawForgejoLookup } from "./instance-lookup.js";

// drives the callback-style net.LookupFunction directly and resolves once it fires
function runLookup(
  lookup: ReturnType<typeof createForgejoLookup>,
  hostname: string,
  options: { all?: boolean } = {},
): Promise<{ error: Error | null; address: string | { address: string; family: number }[] }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address) => {
      resolve({ error: error ?? null, address });
    });
  });
}

function fakeLookup(
  byHostname: Record<string, { address: string; family: number }>,
): RawForgejoLookup {
  return (hostname) => {
    const answer = byHostname[hostname];
    if (answer === undefined) throw new Error(`fakeLookup: no answer configured for ${hostname}`);
    return Promise.resolve(answer);
  };
}

describe("Forgejo instance lookup", () => {
  it("blocks a literal metadata IP with no DNS lookup involved", async () => {
    const lookup = createForgejoLookup(NO_ALLOWED_PRIVATE_HOSTS, fakeLookup({}));
    const result = await runLookup(lookup, "169.254.169.254");
    assert.ok(result.error !== null);
  });

  it("blocks a hostname that resolves to a private address", async () => {
    const lookup = createForgejoLookup(
      NO_ALLOWED_PRIVATE_HOSTS,
      fakeLookup({ "forge.example.test": { address: "10.0.0.5", family: 4 } }),
    );
    const result = await runLookup(lookup, "forge.example.test");
    assert.ok(result.error !== null);
  });

  it("allows a hostname that resolves to a public address", async () => {
    const lookup = createForgejoLookup(
      NO_ALLOWED_PRIVATE_HOSTS,
      fakeLookup({ "git.example.test": { address: "93.184.216.34", family: 4 } }),
    );
    const result = await runLookup(lookup, "git.example.test");
    assert.equal(result.error, null);
    assert.equal(result.address, "93.184.216.34");
  });

  it("allows a private address once the exact hostname is in the allowlist", async () => {
    const allowlist = parseAllowedPrivateHosts("forge.example.test");
    const lookup = createForgejoLookup(
      allowlist,
      fakeLookup({ "forge.example.test": { address: "10.0.0.5", family: 4 } }),
    );
    const result = await runLookup(lookup, "forge.example.test");
    assert.equal(result.error, null);
    assert.equal(result.address, "10.0.0.5");
  });

  it("allows a private address once its network is in the allowlist by CIDR", async () => {
    const allowlist = parseAllowedPrivateHosts("10.0.0.0/24");
    const lookup = createForgejoLookup(
      allowlist,
      fakeLookup({ "forge.example.test": { address: "10.0.0.5", family: 4 } }),
    );
    const result = await runLookup(lookup, "forge.example.test");
    assert.equal(result.error, null);
    assert.equal(result.address, "10.0.0.5");
  });

  it("still blocks a hostname allowlisted under a different name", async () => {
    const allowlist = parseAllowedPrivateHosts("other.internal");
    const lookup = createForgejoLookup(
      allowlist,
      fakeLookup({ "forge.example.test": { address: "10.0.0.5", family: 4 } }),
    );
    const result = await runLookup(lookup, "forge.example.test");
    assert.ok(result.error !== null);
  });

  it("answers with an array when node asks for every address (autoSelectFamily)", async () => {
    const lookup = createForgejoLookup(
      NO_ALLOWED_PRIVATE_HOSTS,
      fakeLookup({ "git.example.test": { address: "93.184.216.34", family: 4 } }),
    );
    const result = await runLookup(lookup, "git.example.test", { all: true });
    assert.equal(result.error, null);
    assert.deepEqual(result.address, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("strips the brackets around a literal IPv6 host before checking it", async () => {
    const lookup = createForgejoLookup(NO_ALLOWED_PRIVATE_HOSTS, fakeLookup({}));
    const result = await runLookup(lookup, "[::1]");
    assert.ok(result.error !== null);
  });
});
