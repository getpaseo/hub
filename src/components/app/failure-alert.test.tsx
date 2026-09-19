import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

const NOOP = (): void => {};
const REVOKED = { status: "error", error: { message: "Daemon revoked" } } as const;

import { FailureAlert, failureMessage } from "./failure-alert.js";

const FALLBACK = "Hub did not receive the daemon list.";

describe("the message a failed request shows", () => {
  it("prefers what the server said over what the screen guessed", () => {
    const result = { status: "error", error: { message: "Daemon revoked" } } as const;

    assert.equal(failureMessage(result, FALLBACK), "Daemon revoked");
  });

  it("falls back when the transport failed and there is no result at all", () => {
    assert.equal(failureMessage(undefined, FALLBACK), FALLBACK);
    assert.equal(failureMessage(null, FALLBACK), FALLBACK);
  });

  it("falls back when the result did not fail, which is the caller's branch being wrong", () => {
    assert.equal(failureMessage({ status: "ok", data: { daemons: [] } }, FALLBACK), FALLBACK);
  });

  it("reads a thrown error and a hand-written string the same way", () => {
    assert.equal(
      failureMessage(new Error("Network is unreachable"), FALLBACK),
      "Network is unreachable",
    );
    assert.equal(failureMessage("Session expired", FALLBACK), "Session expired");
  });

  it("treats an empty message as no message, because a blank alert says nothing", () => {
    assert.equal(failureMessage({ status: "error", error: { message: "  " } }, FALLBACK), FALLBACK);
    assert.equal(failureMessage(new Error(""), FALLBACK), FALLBACK);
    assert.equal(failureMessage("", FALLBACK), FALLBACK);
  });
});

describe("the failure alert", () => {
  it("puts its title and message in the alert's own slots, never as bare children", () => {
    const markup = renderToStaticMarkup(
      <FailureAlert title="Daemons unavailable" error={REVOKED} fallback={FALLBACK} />,
    );

    assert.match(markup, /data-slot="alert-title"[^>]*>Daemons unavailable</u);
    assert.match(markup, /data-slot="alert-description"[\s\S]*Daemon revoked/u);
  });

  it("offers a retry only when trying again is a real option", () => {
    const withRetry = renderToStaticMarkup(
      <FailureAlert
        title="Apps unavailable"
        error={undefined}
        fallback={FALLBACK}
        onRetry={NOOP}
      />,
    );
    const without = renderToStaticMarkup(
      <FailureAlert title="Apps unavailable" error={undefined} fallback={FALLBACK} />,
    );

    assert.match(withRetry, /Try again/u);
    assert.doesNotMatch(without, /Try again/u);
  });
});
