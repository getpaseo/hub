import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  assertDialable,
  ForgejoInstanceBlockedError,
  isBlockedAddress,
  isExceptedAddress,
  isExceptedHostname,
  narrowAddressFamily,
  parseAllowedPrivateHosts,
  stripHostnameBrackets,
  unwrapForgejoInstanceBlockedError,
} from "./instance-guard.js";

describe("Forgejo instance guard: address ranges", () => {
  it("blocks the cloud metadata address", () => {
    assert.equal(isBlockedAddress("169.254.169.254"), true);
  });

  it("blocks an RFC1918 private address", () => {
    assert.equal(isBlockedAddress("10.0.0.5"), true);
    assert.equal(isBlockedAddress("172.16.4.1"), true);
    assert.equal(isBlockedAddress("192.168.1.1"), true);
  });

  it("blocks loopback and CGNAT", () => {
    assert.equal(isBlockedAddress("127.0.0.1"), true);
    assert.equal(isBlockedAddress("100.64.0.1"), true);
  });

  it("blocks an IPv6 unique-local and link-local address", () => {
    assert.equal(isBlockedAddress("fc00::1"), true);
    assert.equal(isBlockedAddress("fe80::1"), true);
    assert.equal(isBlockedAddress("::1"), true);
  });

  it("blocks an IPv4-mapped-IPv6 form of a blocked address", () => {
    assert.equal(isBlockedAddress("::ffff:169.254.169.254"), true);
  });

  it.each([
    ["192.0.0.0/24 (IETF protocol assignments)", "192.0.0.8"],
    ["192.0.2.0/24 (TEST-NET-1)", "192.0.2.1"],
    ["198.18.0.0/15 (benchmarking)", "198.19.0.1"],
    ["198.51.100.0/24 (TEST-NET-2)", "198.51.100.1"],
    ["203.0.113.0/24 (TEST-NET-3)", "203.0.113.1"],
    ["240.0.0.0/4 (reserved)", "240.0.0.1"],
    ["the IPv4 limited broadcast address", "255.255.255.255"],
  ] as const)("blocks %s", (_label, address) => {
    assert.equal(isBlockedAddress(address), true);
  });

  it("blocks the this-network range (0.0.0.0/8), not just the all-zeros address", () => {
    assert.equal(isBlockedAddress("0.0.0.0"), true);
    assert.equal(isBlockedAddress("0.0.0.7"), true);
  });

  it("blocks NAT64 addresses, global and local-use (64:ff9b::/96, 64:ff9b:1::/48)", () => {
    assert.equal(isBlockedAddress("64:ff9b::c000:0201"), true);
    assert.equal(isBlockedAddress("64:ff9b:1::c000:0201"), true);
  });

  it("blocks the SIIT IPv4-translated form (::ffff:0:0:0/96), unlike the mapped form", () => {
    assert.equal(isBlockedAddress("::ffff:0:169.254.169.254"), true);
    assert.equal(isBlockedAddress("::ffff:0:8.8.8.8"), true);
  });

  it("blocks 6to4 addresses (2002::/16)", () => {
    assert.equal(isBlockedAddress("2002:c000:0204::1"), true);
  });

  it("blocks the deprecated IPv4-compatible IPv6 range (::/96)", () => {
    assert.equal(isBlockedAddress("::192.0.2.1"), true);
    assert.equal(isBlockedAddress("::"), true);
  });

  it("allows an ordinary public address", () => {
    assert.equal(isBlockedAddress("93.184.216.34"), false);
    assert.equal(isBlockedAddress("2001:db8::1"), false);
  });

  it("strips brackets from a literal IPv6 hostname", () => {
    assert.equal(stripHostnameBrackets("[::1]"), "::1");
    assert.equal(stripHostnameBrackets("forge.internal"), "forge.internal");
  });
});

describe("Forgejo instance guard: FORGEJO_ALLOWED_PRIVATE_HOSTS", () => {
  it("excepts a hostname named exactly", () => {
    const allowlist = parseAllowedPrivateHosts("forge.internal");
    assert.equal(isExceptedHostname("forge.internal", allowlist), true);
    assert.equal(isExceptedHostname("FORGE.INTERNAL", allowlist), true);
    assert.equal(isExceptedHostname("other.internal", allowlist), false);
  });

  it("excepts an address inside a named CIDR", () => {
    const allowlist = parseAllowedPrivateHosts("10.20.0.0/24");
    assert.equal(isExceptedAddress("10.20.0.5", allowlist), true);
    assert.equal(isExceptedAddress("10.20.1.5", allowlist), false);
  });

  it("treats a bare IP as an exact /32 or /128 exception, not a hostname", () => {
    const allowlist = parseAllowedPrivateHosts("10.20.0.5");
    assert.equal(isExceptedAddress("10.20.0.5", allowlist), true);
    assert.equal(isExceptedAddress("10.20.0.6", allowlist), false);
    assert.equal(isExceptedHostname("10.20.0.5", allowlist), false);
  });

  it("mixes hostnames and CIDRs across entries", () => {
    const allowlist = parseAllowedPrivateHosts(" forge.internal , 10.20.0.0/24 ,fd00::/8");
    assert.equal(isExceptedHostname("forge.internal", allowlist), true);
    assert.equal(isExceptedAddress("10.20.0.9", allowlist), true);
    assert.equal(isExceptedAddress("fd00::1", allowlist), true);
  });

  it("is empty for an unset or blank value", () => {
    assert.equal(parseAllowedPrivateHosts(undefined).hostnames.size, 0);
    assert.equal(parseAllowedPrivateHosts(undefined).addresses, undefined);
    assert.equal(parseAllowedPrivateHosts(" , ,").hostnames.size, 0);
  });

  it("throws on a CIDR with a prefix past the family's own bit width", () => {
    assert.throws(() => parseAllowedPrivateHosts("10.0.0.0/33"), /invalid entry/u);
    assert.throws(() => parseAllowedPrivateHosts("fd00::/129"), /invalid entry/u);
  });

  it("throws on a slash that isn't a real CIDR", () => {
    assert.throws(() => parseAllowedPrivateHosts("forge.internal/32"), /invalid entry/u);
    assert.throws(() => parseAllowedPrivateHosts("10.0.0.0/abc"), /invalid entry/u);
  });
});

describe("Forgejo instance guard: assertDialable", () => {
  it("throws on a blocked address that is not excepted", () => {
    assert.throws(
      () =>
        assertDialable("169.254.169.254", "169.254.169.254", parseAllowedPrivateHosts(undefined)),
      ForgejoInstanceBlockedError,
    );
  });

  it("does not throw once the hostname is excepted", () => {
    assert.doesNotThrow(() =>
      assertDialable("forge.internal", "10.20.0.5", parseAllowedPrivateHosts("forge.internal")),
    );
  });

  it("does not throw once the resolved address is excepted", () => {
    assert.doesNotThrow(() =>
      assertDialable("forge.internal", "10.20.0.5", parseAllowedPrivateHosts("10.20.0.0/24")),
    );
  });

  it("does not throw on an ordinary public address", () => {
    assert.doesNotThrow(() =>
      assertDialable("git.example.test", "93.184.216.34", parseAllowedPrivateHosts(undefined)),
    );
  });
});

describe("Forgejo instance guard: narrowAddressFamily", () => {
  it("narrows 4 and 6", () => {
    assert.equal(narrowAddressFamily(4), 4);
    assert.equal(narrowAddressFamily(6), 6);
  });

  it("returns undefined for anything else", () => {
    assert.equal(narrowAddressFamily(0), undefined);
    assert.equal(narrowAddressFamily(5), undefined);
  });
});

describe("Forgejo instance guard: unwrapping the blocked error", () => {
  it("finds the guard's own error directly", () => {
    const error = new ForgejoInstanceBlockedError("forge.internal");
    assert.equal(unwrapForgejoInstanceBlockedError(error), error);
  });

  it("finds it under fetch's TypeError('fetch failed', { cause }) wrapping", () => {
    const blocked = new ForgejoInstanceBlockedError("forge.internal");
    const wrapped = new TypeError("fetch failed", { cause: blocked });
    assert.equal(unwrapForgejoInstanceBlockedError(wrapped), blocked);
  });

  it("returns undefined for an unrelated error", () => {
    assert.equal(unwrapForgejoInstanceBlockedError(new Error("nope")), undefined);
    assert.equal(unwrapForgejoInstanceBlockedError(undefined), undefined);
  });
});
