import { describe, expect, it } from "vitest";
import { DROP_REASONS, resourceLabel, runSession } from "./presentation.js";

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

describe("DROP_REASONS", () => {
  it("presents a handled Linear Stop without suggesting configuration changes", () => {
    expect(DROP_REASONS.agent_session_stopped).toMatchObject({
      label: "Agent session stopped",
      next: "none",
    });
  });
});
