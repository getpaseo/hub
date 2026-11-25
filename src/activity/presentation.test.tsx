import { describe, expect, it } from "vitest";
import { resourceLabel, runSession, sessionLink, sessionVisibility } from "./presentation.js";

const agent = (daemonAgentId: string | null) => ({ execution: { id: "execution", daemonAgentId } });

describe("runSession", () => {
  it("offers the newest step that reached an agent, past a skipped last step", () => {
    expect(runSession([agent("first"), agent("second"), { execution: null }])).toMatchObject({
      daemonAgentId: "second",
    });
  });

  it("skips a step whose agent was never created", () => {
    expect(runSession([agent("first"), agent(null)])).toMatchObject({ daemonAgentId: "first" });
  });

  it("offers nothing when no step reached an agent", () => {
    expect(runSession([{ execution: null }, agent(null)])).toBeUndefined();
  });
});

describe("resourceLabel", () => {
  it("names an event's resource as its provider does", () => {
    expect(
      (["github", "slack", "discord", "linear", "webhook"] as const).map(resourceLabel),
    ).toEqual(["Repository", "Workspace", "Server", "Project", "Resource"]);
  });
});

describe("sessionLink", () => {
  it("opens the agent in Paseo directly when Hub knows its deep link", () => {
    expect(sessionLink({ id: "execution", deepLink: "paseo://h/server/agent/agent-1" })).toBe(
      "paseo://h/server/agent/agent-1",
    );
  });

  it("falls back to Hub's open page when the deep link is unknown", () => {
    expect(sessionLink({ id: "execution", deepLink: null })).toBe("/open/executions/execution");
  });
});

describe("sessionVisibility", () => {
  it("says nothing for an agent Paseo lists like any other", () => {
    expect(sessionVisibility({ background: false, autoArchive: false })).toBeUndefined();
  });

  it.each([false, true])(
    "describes background as a request when auto-archive is %s",
    (autoArchive) => {
      const note = sessionVisibility({ background: true, autoArchive });
      expect(note).toContain("This run requested a background workspace");
      expect(note).toContain("If the agent is hidden, turn on Show background");
    },
  );

  it.each([false, true])(
    "describes the run's auto-archive setting without promising the agent will be archived (background %s)",
    (background) => {
      const note = sessionVisibility({ background, autoArchive: true });
      expect(note).toContain("Auto-archive is on for this run");
      expect(note).toContain("Hub skips archiving if another run is using the agent");
    },
  );
});
