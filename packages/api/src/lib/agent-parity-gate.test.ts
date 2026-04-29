import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  evaluateAgentParityGate,
  readAgentParityGateCriteria,
  type AgentParityDailyRow,
} from "./agent-parity-gate.js";

const criteria = {
  minObservedDays: 3,
  minComparableCount: 6,
  minActionAgreementRate: 0.9,
  minTargetPageAgreementRate: 0.8,
};

function day(
  date: string,
  overrides: Partial<AgentParityDailyRow> = {},
): AgentParityDailyRow {
  return {
    day: date,
    agentRunCount: 2,
    comparableCount: 2,
    actionMatchCount: 2,
    targetPageMatchCount: 2,
    fullMatchCount: 2,
    actionAgreementRate: 1,
    targetPageAgreementRate: 1,
    fullAgreementRate: 1,
    totalAgentTokens: 1200,
    ...overrides,
  };
}

describe("evaluateAgentParityGate", () => {
  it("waits for comparable shadow data before promotion", () => {
    const status = evaluateAgentParityGate([], criteria);

    assert.equal(status.status, "not_started");
    assert.equal(status.canPromote, false);
    assert.deepEqual(status.failedChecks, ["no_comparable_shadow_runs"]);
  });

  it("keeps collecting until the window and sample size are large enough", () => {
    const status = evaluateAgentParityGate(
      [day("2026-04-27"), day("2026-04-28")],
      criteria,
    );

    assert.equal(status.status, "collecting");
    assert.equal(status.canPromote, false);
    assert.ok(status.failedChecks.includes("min_observed_days"));
    assert.ok(status.failedChecks.includes("min_comparable_count"));
  });

  it("blocks promotion when aggregate agreement is below threshold", () => {
    const status = evaluateAgentParityGate(
      [
        day("2026-04-26"),
        day("2026-04-27", { actionMatchCount: 1 }),
        day("2026-04-28"),
      ],
      criteria,
    );

    assert.equal(status.status, "blocked");
    assert.equal(status.canPromote, false);
    assert.ok(status.failedChecks.includes("min_action_agreement_rate"));
  });

  it("passes after enough observed days and agreement", () => {
    const status = evaluateAgentParityGate(
      [day("2026-04-26"), day("2026-04-27"), day("2026-04-28")],
      criteria,
    );

    assert.equal(status.status, "passed");
    assert.equal(status.canPromote, true);
    assert.equal(status.comparableCount, 6);
    assert.equal(status.actionAgreementRate, 1);
  });
});

describe("readAgentParityGateCriteria", () => {
  it("reads bounded environment overrides", () => {
    const parsed = readAgentParityGateCriteria({
      AGENT_PARITY_GATE_MIN_OBSERVED_DAYS: "5",
      AGENT_PARITY_GATE_MIN_COMPARABLE_COUNT: "50",
      AGENT_PARITY_GATE_MIN_ACTION_AGREEMENT_RATE: "0.95",
      AGENT_PARITY_GATE_MIN_TARGET_PAGE_AGREEMENT_RATE: "2",
    });

    assert.equal(parsed.minObservedDays, 5);
    assert.equal(parsed.minComparableCount, 50);
    assert.equal(parsed.minActionAgreementRate, 0.95);
    assert.equal(parsed.minTargetPageAgreementRate, 1);
  });
});
