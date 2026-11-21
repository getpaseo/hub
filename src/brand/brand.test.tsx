import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { FAVICON_SVG } from "./favicon.js";
import { PaseoHubLockup, PaseoHubMark } from "./index.js";

describe("Paseo Hub brand assets", () => {
  it("renders the canonical five-petal flower mark with currentColor", () => {
    const markup = renderToStaticMarkup(<PaseoHubMark />);
    assert.match(markup, /viewBox="0 0 700 700"/u);
    assert.match(markup, /aria-hidden="true"/u);
    assert.match(markup, /stroke="currentColor"/u);
    assert.match(markup, /stroke-width="50"/u);
    assert.match(markup, /stroke-linecap="round"/u);
    assert.match(markup, /stroke-linejoin="round"/u);
    assert.match(markup, /d="M389\.47 112\.65/u);
  });

  it("renders the canonical Paseo Hub lockup with outlined wordmark and accessible label", () => {
    const markup = renderToStaticMarkup(<PaseoHubLockup />);
    assert.match(markup, /role="img"/u);
    assert.match(markup, /aria-label="Paseo Hub"/u);
    assert.match(markup, /viewBox="0 0 842 144"/u);
    assert.match(markup, /stroke="currentColor"/u);
    assert.match(markup, /stroke-width="13\.28"/u);
    assert.match(markup, /fill="currentColor"/u);
    assert.match(markup, /d="M82\.49 8\.95/u);
    assert.match(markup, /d="M246\.32 121\.48/u);
  });

  it("ships a rounded-tile SVG favicon with the canonical flower mark", () => {
    assert.match(FAVICON_SVG, /viewBox="0 0 700 700"/u);
    assert.match(FAVICON_SVG, /<rect width="700" height="700" rx="156" fill="#000000" \/>/u);
    assert.match(FAVICON_SVG, /d="M389\.47 112\.65/u);
    assert.match(FAVICON_SVG, /stroke="#FFFFFF"/u);
    assert.match(FAVICON_SVG, /stroke-width="50"/u);
  });
});
