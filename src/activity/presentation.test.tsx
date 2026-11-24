import { describe, expect, it } from "vitest";
import { runSession } from "./presentation.js";

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
