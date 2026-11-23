import { describe, expect, it } from "vitest";
import { atLimit, overLimit } from "./limits.js";

describe("usage limit predicates", () => {
  it("treats unlimited measures as neither at nor over their limit", () => {
    const measure = { used: 100, limit: null };
    expect(atLimit(measure)).toBe(false);
    expect(overLimit(measure)).toBe(false);
  });

  it("distinguishes exhausted headroom from an existing overage", () => {
    expect(atLimit({ used: 2, limit: 2 })).toBe(true);
    expect(overLimit({ used: 2, limit: 2 })).toBe(false);
    expect(atLimit({ used: 3, limit: 2 })).toBe(true);
    expect(overLimit({ used: 3, limit: 2 })).toBe(true);
  });
});
