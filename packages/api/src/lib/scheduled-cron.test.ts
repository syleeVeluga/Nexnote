import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateScheduledCronExpression } from "./scheduled-cron.js";

describe("validateScheduledCronExpression", () => {
  it("rejects non-cron text", () => {
    const result = validateScheduledCronExpression("not a cron");
    assert.equal(result.ok, false);
  });

  it("rejects six-field cron expressions", () => {
    const result = validateScheduledCronExpression("0 */5 * * * *");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /5 fields/);
  });

  it("rejects schedules below the one-hour interval", () => {
    const result = validateScheduledCronExpression("*/30 * * * *");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /once per hour/);
  });

  it("accepts hourly schedules", () => {
    const result = validateScheduledCronExpression("0 * * * *");
    assert.equal(result.ok, true);
  });

  it("accepts slower schedules", () => {
    const result = validateScheduledCronExpression("0 2 * * *");
    assert.equal(result.ok, true);
  });
});
