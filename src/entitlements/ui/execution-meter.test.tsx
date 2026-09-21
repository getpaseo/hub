import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { executionMeterLabel, meteredExecutions } from "./execution-meter.js";

describe("the execution meter's copy", () => {
  it("counts what is used against the allowance, in one sentence", () => {
    assert.equal(executionMeterLabel({ used: 0, limit: 50 }), "0 of 50 executions this month");
    assert.equal(executionMeterLabel({ used: 1, limit: 50 }), "1 of 50 executions this month");
    assert.equal(executionMeterLabel({ used: 50, limit: 50 }), "50 of 50 executions this month");
  });

  it("keeps counting past the allowance rather than pretending the organization is at it", () => {
    // A limit can drop below what was already consumed — a downgrade, or an operator lowering it.
    assert.equal(executionMeterLabel({ used: 63, limit: 50 }), "63 of 50 executions this month");
  });
});

describe("which organizations have an execution meter", () => {
  it("meters an organization with a finite allowance", () => {
    assert.deepEqual(meteredExecutions({ executionsMonthly: { used: 4, limit: 50 } }), {
      used: 4,
      limit: 50,
    });
  });

  it("does not meter an unlimited allowance: a paid plan and a self-hosted instance have none", () => {
    assert.equal(meteredExecutions({ executionsMonthly: { used: 4, limit: null } }), undefined);
  });

  it("does not meter while the limits are still unknown", () => {
    assert.equal(meteredExecutions(undefined), undefined);
  });
});
