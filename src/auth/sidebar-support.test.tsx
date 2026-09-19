import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SidebarMenu, SidebarProvider } from "../components/ui/sidebar.js";
import { HelpChannels, SidebarHelp } from "./sidebar-help.js";
import { trialNoticeLabel } from "./trial-notice.js";

function footerMarkup(): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarHelp />
      </SidebarMenu>
    </SidebarProvider>,
  );
}

describe("the sidebar help item", () => {
  it("names itself and stays shut until it is asked", () => {
    const markup = footerMarkup();

    assert.match(markup, /Help/u);
    assert.match(markup, /aria-expanded="false"/u);
    // Nothing about support is on screen before the popover opens.
    assert.doesNotMatch(markup, /discord/iu);
    assert.doesNotMatch(markup, /paseo\.sh/u);
  });
});

describe("the help popover's copy", () => {
  it("offers the Discord channel and the mailbox, each as a working link", () => {
    const markup = renderToStaticMarkup(<HelpChannels />);

    assert.match(markup, /href="https:\/\/discord\.gg\/[A-Za-z0-9]+"/u);
    assert.match(markup, /#paseo-hub/u);
    assert.match(markup, /href="mailto:hello@paseo\.sh"/u);
    assert.match(markup, />hello@paseo\.sh</u);
  });

  it("opens Discord in a new tab without handing it this session", () => {
    const markup = renderToStaticMarkup(<HelpChannels />);

    assert.match(markup, /target="_blank"[^>]*rel="noreferrer"/u);
  });
});

describe("the trial reminder's copy", () => {
  it("counts days, and one day as a day", () => {
    assert.equal(trialNoticeLabel(12), "12 days left in trial");
    assert.equal(trialNoticeLabel(1), "1 day left in trial");
    assert.equal(trialNoticeLabel(0), "0 days left in trial");
  });
});
