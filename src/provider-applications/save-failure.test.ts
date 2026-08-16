import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import { ProviderApplicationError } from "./index.js";
import { providerApplicationSaveFailure } from "./save-failure.js";

describe("provider application failure copy", () => {
  it("turns Discord gateway 4014 into an actionable, scrubbed, exactly-once failure", () => {
    const canary = "formatless-gateway-secret-2d81";
    const stream = new FailureLogStream();
    const gateway = Object.assign(new Error("safe gateway failure", { cause: new Error(canary) }), {
      name: "DiscordGatewayError",
      gatewayCloseCode: 4014,
      gatewayFailure: "disallowedIntents",
      code: "permissionMissing",
    });
    const error = new ProviderApplicationError(
      "permissionMissing",
      "discordGatewayDisallowedIntents",
      { cause: gateway },
    );

    const result = runWithFailureTracking(
      () => providerApplicationSaveFailure("discord", error, [canary]),
      createLogger(stream),
    );

    assert.equal(
      result.error.message,
      "Discord requires Message Content Intent. Turn it on under Bot → Privileged Gateway Intents, save in Discord, then verify again.",
    );
    const records = stream.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.["operation"], "provider_application.verify_and_save");
    assert.equal(records[0]?.["component"], "provider_applications");
    assert.equal(records[0]?.["provider"], "discord");
    assert.equal(records[0]?.["failureKind"], "permissionMissing");
    assert.deepEqual(records[0]?.["diagnostic"], {
      gatewayCloseCode: 4014,
      gatewayFailure: "disallowedIntents",
    });
    assert.equal(stream.text().includes(canary), false);
  });
});
