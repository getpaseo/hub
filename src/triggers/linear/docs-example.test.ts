import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { compileTriggerDocument } from "../configuration/index.js";

describe("Linear documentation", () => {
  it("shows a trigger document that Hub accepts as written", async () => {
    const guide = await readFile("docs/linear.md", "utf8");
    const examples = Array.from(guide.matchAll(/```yaml\n([\s\S]*?)```/gu), (match) => match[1]!);
    assert.equal(examples.length, 1);

    const compiled = compileTriggerDocument(examples[0]!);

    assert.deepEqual(
      compiled.events.map((event) => ({ on: event.on, filters: event.filters })),
      [
        {
          on: "linear.agent_session",
          filters: { team: "3f2b4c1e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", from_users: ["*"] },
        },
      ],
    );
    assert.deepEqual(
      compiled.events[0]?.steps[0]?.allowOutputs.map(({ type }) => type),
      ["linear.reply"],
    );
  });
});
