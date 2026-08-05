import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import { matchSlackTriggers, readSlackPromptBody } from "./match.js";

describe("Slack trigger matching", () => {
  it("requires the compiled trigger filters and bot mention", () => {
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "slack-run",
          on: "slack.mention",
          max_runtime: "2h",
          filters: {
            workspace: "T1",
            channels: ["C1"],
            from_users: ["U1"],
            pattern: "run",
          },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Run the request" }],
            },
          ],
        },
      ],
    });
    const event = mention();

    assert.equal(matchSlackTriggers(config, event, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(event, "UBOT"), "run tests");
    assert.equal(matchSlackTriggers(config, { ...event, channelId: "C2" }, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, { ...event, content: "run tests" }, "UBOT").length, 0);
  });
});

function mention(): NormalizedSlackMentionEvent {
  return {
    type: "mention",
    id: "Ev1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: "1700000000.000001",
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "hello <@UBOT> run tests",
    author: { id: "U1" },
    createdAt: new Date(1_700_000_000_000).toISOString(),
  };
}
