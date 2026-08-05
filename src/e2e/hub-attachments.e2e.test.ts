import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { HubHarness } from "../daemons/test-utils/hub-harness.js";

const describeHubE2E = process.env["RUN_HUB_E2E"] === "1" ? describe : describe.skip;

describeHubE2E("Hub provider attachment capability journey", () => {
  let hub: HubHarness;

  beforeEach(async () => {
    hub = await HubHarness.start();
    await hub.connectDaemon();
    const installed = await hub.installConfiguration({ yaml: hub.slackConfigurationYaml() });
    if (installed.status !== 201)
      throw new Error(`Slack config install failed: ${JSON.stringify(installed)}`);
  }, 120_000);

  afterEach(async () => {
    await hub?.stop();
  }, 120_000);

  it("dispatches Slack context and downloads the image from the materialized Hub URL", async () => {
    const response = await hub.deliverSlackMention();
    assert.equal(response.status, 200);

    const launch = hub.createdAgentLaunch();
    if (typeof launch.prompt !== "string") throw new Error("daemon prompt was not captured");
    const prompt = launch.prompt;
    assert.match(prompt, /inspect this image/u);
    assert.match(prompt, /diagram\.png/u);
    assert.match(prompt, /image\/png/u);
    assert.match(prompt, /19/u);
    assert.match(prompt, /Please inspect the latest diagram/u);
    assert.doesNotMatch(prompt, /files\.slack\.com|xoxb|F1/u);

    const downloadUrl = prompt.match(/https?:\/\/[^\s]+/u)?.[0];
    assert(downloadUrl);
    const image = await fetch(downloadUrl);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), "diagram-image-bytes");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("etag"), '"diagram-1"');
  }, 120_000);
});
