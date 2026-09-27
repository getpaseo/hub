import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sameForgeName } from "./match.js";

describe("sameForgeName", () => {
  it("matches names differing only in ascii case", () => {
    assert.equal(sameForgeName("Zaphod", "zaphod"), true);
  });

  it("does not match a different name", () => {
    assert.equal(sameForgeName("zaphod", "trillian"), false);
  });

  it("never matches an undefined actual", () => {
    assert.equal(sameForgeName("zaphod", undefined), false);
  });

  // toLowerCase is locale-independent, unlike toLocaleLowerCase under tr-TR.
  it("matches dotted and dotless I regardless of locale", () => {
    assert.equal(sameForgeName("Istanbul", "istanbul"), true);
  });
});
