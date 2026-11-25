import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { WebhookSettingsView } from "./settings.js";

const NOOP = (): void => {};
const URL = "https://hub.example/webhooks/wh_abcdefghijklmnopqrstuvwxyz012345";
const SECRET = `whsec_${"a".repeat(43)}`;

function markup(endpoint: { hasSecret: boolean; secret?: string }): string {
  return renderToStaticMarkup(
    <WebhookSettingsView
      url={URL}
      hasSecret={endpoint.hasSecret}
      {...(endpoint.secret === undefined ? {} : { secret: endpoint.secret })}
      canManage
      pending={false}
      onCreateSecret={NOOP}
      onRotateSecret={NOOP}
    />,
  );
}

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

describe("the webhook example request", () => {
  it("carries the secret while it is on screen, so the copied command runs as it is", () => {
    const html = decoded(markup({ hasSecret: true, secret: SECRET }));

    assert.match(html, /Save this secret now/u);
    assert.ok(html.includes(`-H 'Authorization: Bearer ${SECRET}'`));
    assert.ok(!html.includes("$WEBHOOK_SECRET"));
  });

  it("asks for the saved secret once only its hash is left", () => {
    const html = decoded(markup({ hasSecret: true }));

    assert.ok(html.includes('-H "Authorization: Bearer $WEBHOOK_SECRET"'));
    assert.match(
      html,
      /Replace \$WEBHOOK_SECRET with your saved secret, or rotate to generate a new one/u,
    );
    assert.ok(!html.includes("Save this secret now"));
  });
});

describe("an endpoint without a secret", () => {
  it("warns that every request is refused until a secret exists", () => {
    const html = decoded(markup({ hasSecret: false }));

    assert.match(html, /Secret required/u);
    assert.match(html, /Requests return 401 until you create a secret/u);
    assert.match(html, /Create secret/u);
    assert.ok(!html.includes("No secret"));
  });
});
