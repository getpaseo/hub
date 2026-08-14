import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { PROVIDER_GUIDES } from "./guides.js";
import { ProviderSectionLoading } from "./provider-section.js";

describe("provider application loading surface", () => {
  it("keeps every header and the default-open GitHub instructions and URLs available", () => {
    const origin = "https://hub.test";
    const markup = renderToStaticMarkup(
      <div>
        {PROVIDER_GUIDES.map((guide) => (
          <ProviderSectionLoading
            key={guide.provider}
            guide={guide}
            origin={origin}
            open={guide.provider === "github"}
          />
        ))}
      </div>,
    );

    for (const name of ["GitHub", "Slack", "Discord"]) assert.match(markup, new RegExp(name, "u"));
    assert.match(markup, /Create a GitHub App/u);
    assert.match(markup, /https:\/\/hub\.test\/api\/integrations\/github\/callback/u);
    assert.match(markup, /aria-busy="true"/u);
  });
});
