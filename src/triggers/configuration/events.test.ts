import { describe, expect, it } from "vitest";
import { EDITOR_EVENTS, eventProvider } from "./events.js";

describe("event provider", () => {
  it("names the provider of an event the editor offers", () => {
    expect(eventProvider("manual.run")).toBe("manual");
    expect(eventProvider("webhook.received")).toBe("webhook");
  });

  it("names the provider of a raw YAML event the editor does not offer", () => {
    expect(eventProvider("discord.message")).toBe("discord");
    expect(eventProvider("slack.app_mention")).toBe("slack");
    expect(eventProvider("github.issues.opened")).toBe("github");
    expect(eventProvider("linear.issue.created")).toBe("linear");
    expect(eventProvider("schedule.cron")).toBe("schedule");
  });

  it("falls back to manual for an event from no provider Hub knows", () => {
    expect(eventProvider("jira.issue_created")).toBe("manual");
    expect(eventProvider("")).toBe("manual");
  });
});

describe("event picker order", () => {
  it("offers the events Hub sends itself first, since they need no integration", () => {
    expect(EDITOR_EVENTS.slice(0, 3)).toEqual(["webhook.received", "schedule.tick", "manual.run"]);
  });
});
