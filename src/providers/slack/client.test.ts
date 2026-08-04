import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createSlackConnectionClient } from "./client.js";

describe("Slack connection client", () => {
  it("builds the minimal OAuth grant and validates the installation identity", async () => {
    let exchangeBody: URLSearchParams | undefined;
    const client = createSlackConnectionClient({
      appId: "A1",
      clientId: "client-1",
      clientSecret: "secret-1",
      publicBaseUrl: "https://hub.test",
      fetch: async (_input, init) => {
        if (init?.body instanceof URLSearchParams) exchangeBody = init.body;
        return Response.json({
          ok: true,
          app_id: "A1",
          access_token: "xoxb-token",
          bot_user_id: "UBOT",
          team: { id: "T1", name: "Acme" },
        });
      },
    });
    const authorization = new URL(client.authorizationUrl("random-state"));
    assert.equal(authorization.origin, "https://slack.com");
    assert.equal(authorization.pathname, "/oauth/v2/authorize");
    assert.equal(authorization.searchParams.get("state"), "random-state");
    assert.equal(
      authorization.searchParams.get("scope"),
      "app_mentions:read,chat:write,reactions:write",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/slack/callback",
    );
    assert.deepEqual(await client.exchangeCode("code-1"), {
      teamId: "T1",
      teamName: "Acme",
      botUserId: "UBOT",
      botAccessToken: "xoxb-token",
    });
    assert.equal(exchangeBody?.get("client_secret"), "secret-1");
    assert.equal(
      exchangeBody?.get("redirect_uri"),
      "https://hub.test/api/integrations/slack/callback",
    );
  });

  it("rejects an OAuth response for a different app", async () => {
    const client = createSlackConnectionClient({
      appId: "A1",
      clientId: "client-1",
      clientSecret: "secret-1",
      publicBaseUrl: "https://hub.test",
      fetch: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            app_id: "A2",
            access_token: "xoxb-token",
            bot_user_id: "UBOT",
            team: { id: "T1", name: "Acme" },
          }),
        ),
    });
    await assert.rejects(() => client.exchangeCode("code-1"), /invalid installation/u);
  });
});
