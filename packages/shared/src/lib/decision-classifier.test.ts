import { describe, expect, it } from "vitest";
import { classifyDecisionStatus } from "./decision-classifier.js";

describe("classifyDecisionStatus", () => {
  it("keeps confidence threshold behavior in supervised mode", () => {
    expect(classifyDecisionStatus("update", 0.9)).toBe("auto_applied");
    expect(classifyDecisionStatus("update", 0.7)).toBe("suggested");
    expect(classifyDecisionStatus("update", 0.5)).toBe("needs_review");
  });

  it("auto-applies mutable actions in autonomous mode regardless of confidence", () => {
    expect(
      classifyDecisionStatus("update", 0.1, { autonomous: true }),
    ).toBe("auto_applied");
    expect(
      classifyDecisionStatus("append", 0.1, { autonomous: true }),
    ).toBe("auto_applied");
  });

  it("keeps explicit noop and needs_review above autonomy", () => {
    expect(classifyDecisionStatus("noop", 0.99, { autonomous: true })).toBe(
      "noop",
    );
    expect(
      classifyDecisionStatus("needs_review", 0.99, { autonomous: true }),
    ).toBe("needs_review");
  });
});
