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

  it("points a background agent at Show background", () => {
    expect(sessionVisibility({ background: true, autoArchive: false })).toContain(
      "Show background",
    );
  });

  it("says an auto-archived agent still opens", () => {
    expect(sessionVisibility({ background: false, autoArchive: true })).toContain("archive");
  });

  it("names both when the agent ran in the background and is archived", () => {
    const note = sessionVisibility({ background: true, autoArchive: true });
    expect(note).toContain("background");
    expect(note).toContain("archive");
  });
});
