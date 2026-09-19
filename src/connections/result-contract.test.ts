import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CONNECTIONS_RETURN_ROUTE,
  connectionReturnCopy,
  connectionReturnUrl,
  readConnectionReturn,
  stripConnectionReturn,
} from "./result-contract.js";

describe("connection return contract", () => {
  it("round-trips a return through the location it is carried in", () => {
    const url = connectionReturnUrl("https://hub.test", "/o/acme/connections", {
      provider: "github",
      result: "connection_unavailable",
      reference: "req-1",
    });
    assert.equal(
      url.toString(),
      "https://hub.test/o/acme/connections?app=github&result=connection_unavailable&reference=req-1",
    );
    assert.deepEqual(readConnectionReturn(url), {
      provider: "github",
      result: "connection_unavailable",
      reference: "req-1",
    });
  });

  it("only reads returns from providers it knows, and shows unknown results as failures", () => {
    assert.equal(
      readConnectionReturn(new URL("https://hub.test/o/acme/connections?result=github_connected")),
      undefined,
    );
    assert.equal(
      readConnectionReturn(new URL("https://hub.test/o/acme/connections?app=jira&result=x")),
      undefined,
    );
    assert.deepEqual(
      readConnectionReturn(
        new URL("https://hub.test/o/acme/connections?app=slack&result=something_nobody_mapped"),
      ),
      { provider: "slack", result: "connection_unavailable" },
    );
  });

  it("strips every return parameter and says whether there was one", () => {
    const url = new URL("https://hub.test/apps?app=linear&result=linear_connected&reference=r&x=1");
    assert.equal(stripConnectionReturn(url), true);
    assert.equal(url.toString(), "https://hub.test/apps?x=1");
    assert.equal(stripConnectionReturn(url), false);
  });

  it("falls back to the connections landing, never the dashboard landing", () => {
    assert.equal(CONNECTIONS_RETURN_ROUTE, "/connections");
  });

  it("phrases every outcome with what happened and what to do next", () => {
    assert.deepEqual(connectionReturnCopy({ provider: "github", result: "github_connected" }), {
      tone: "success",
      message: "GitHub connected.",
    });
    const unauthenticated = connectionReturnCopy({
      provider: "github",
      result: "connection_unauthenticated",
    });
    assert.equal(unauthenticated.tone, "error");
    assert.match(unauthenticated.message, /GitHub sent you back to a Hub address/u);
    assert.match(unauthenticated.message, /isn't signed in/u);
    const unavailable = connectionReturnCopy({
      provider: "discord",
      result: "connection_unavailable",
      reference: "req-9",
    });
    assert.equal(unavailable.tone, "error");
    assert.match(unavailable.message, /^Hub couldn't finish the Discord connection\./u);
    assert.match(unavailable.message, /quote reference req-9/u);
  });
});
