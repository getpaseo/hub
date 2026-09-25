import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { apiUrl, normalizeInstanceBaseUrl, readInstanceBaseUrl } from "./instance-url.js";

describe("Forgejo API URLs", () => {
  it("hangs the v1 API off the instance root", () => {
    assert.equal(
      apiUrl("https://git.example.test", "/user"),
      "https://git.example.test/api/v1/user",
    );
  });

  it("keeps a subpath an instance is hosted under", () => {
    assert.equal(
      apiUrl("https://example.test/forge", "/user"),
      "https://example.test/forge/api/v1/user",
    );
  });

  it("does not double the separator when the stored URL ends in a slash", () => {
    assert.equal(
      apiUrl("https://git.example.test/", "/user"),
      "https://git.example.test/api/v1/user",
    );
  });

  it("strips every trailing slash so the stored value is canonical", () => {
    assert.equal(
      normalizeInstanceBaseUrl("https://git.example.test///"),
      "https://git.example.test",
    );
  });
});

describe("Forgejo instance URLs an operator may supply", () => {
  it("takes a plain https origin", () => {
    assert.equal(readInstanceBaseUrl("https://git.example.test"), "https://git.example.test");
  });

  it("takes a private-looking hostname as syntactically valid; whether Hub will actually dial it is instance-guard.ts's call, not this function's", () => {
    assert.equal(readInstanceBaseUrl("https://forge.internal"), "https://forge.internal");
  });

  it("takes plaintext http, because a LAN instance often has no certificate", () => {
    assert.equal(readInstanceBaseUrl("http://git.internal"), "http://git.internal");
  });

  it("refuses credentials smuggled into the host field", () => {
    assert.equal(readInstanceBaseUrl("https://zaphod:beeblebrox@git.example.test"), undefined);
  });

  it("refuses a scheme that is not http at all", () => {
    assert.equal(readInstanceBaseUrl("file:///etc/passwd"), undefined);
    assert.equal(readInstanceBaseUrl("not a url"), undefined);
  });

  it("drops a bare trailing question mark instead of storing it", () => {
    assert.equal(readInstanceBaseUrl("https://git.example.test/?"), "https://git.example.test");
  });
});
