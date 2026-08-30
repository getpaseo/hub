import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  assertResolvedAddressesAllowed,
  canonicalizeHttpsOrigin,
  rejectRedirectStatus,
  type DnsResolver,
} from "./approved-origin.js";

function resolver(addresses: readonly string[]): DnsResolver {
  return { resolve: async () => addresses };
}

describe("Forgejo approved origin SSRF contract", () => {
  it("canonicalizes https origins and rejects userinfo, http, query, fragment, and path", () => {
    const origin = canonicalizeHttpsOrigin("https://Forgejo.Example.test:8443/", {
      allowPrivateNetwork: false,
    });
    assert.equal(origin.origin, "https://forgejo.example.test:8443");
    assert.equal(origin.hostname, "forgejo.example.test");
    assert.throws(
      () => canonicalizeHttpsOrigin("http://forgejo.example.test", { allowPrivateNetwork: false }),
      {
        code: "not_https",
      },
    );
    assert.throws(
      () =>
        canonicalizeHttpsOrigin("https://user:pass@forgejo.example.test", {
          allowPrivateNetwork: false,
        }),
      { code: "userinfo_present" },
    );
    assert.throws(
      () =>
        canonicalizeHttpsOrigin("https://forgejo.example.test/api", { allowPrivateNetwork: false }),
      { code: "non_origin_components" },
    );
    assert.throws(
      () =>
        canonicalizeHttpsOrigin("https://forgejo.example.test?x=1", { allowPrivateNetwork: false }),
      { code: "non_origin_components" },
    );
  });

  it("re-resolves DNS and requires operator approval for private addresses", async () => {
    const publicOrigin = canonicalizeHttpsOrigin("https://forgejo.example.test", {
      allowPrivateNetwork: false,
    });
    assert.deepEqual(
      await assertResolvedAddressesAllowed(publicOrigin, resolver(["203.0.113.10"])),
      ["203.0.113.10"],
    );
    await assert.rejects(assertResolvedAddressesAllowed(publicOrigin, resolver(["10.0.0.4"])), {
      code: "private_network_forbidden",
    });
    const privateOrigin = canonicalizeHttpsOrigin("https://forgejo.internal.test", {
      allowPrivateNetwork: true,
    });
    assert.deepEqual(await assertResolvedAddressesAllowed(privateOrigin, resolver(["10.0.0.4"])), [
      "10.0.0.4",
    ]);
    await assert.rejects(
      assertResolvedAddressesAllowed(publicOrigin, resolver(["169.254.169.254"])),
      { code: "private_network_forbidden" },
    );
    await assert.rejects(assertResolvedAddressesAllowed(publicOrigin, resolver([])), {
      code: "origin_drift",
    });
  });

  it("rejects redirect statuses", () => {
    rejectRedirectStatus(200);
    assert.throws(() => rejectRedirectStatus(302), { code: "unsafe_redirect" });
  });
});
