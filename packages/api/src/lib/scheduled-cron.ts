import cronParser from "cron-parser";

export const SCHEDULED_TASK_MIN_INTERVAL_MS = 60 * 60 * 1000;

export interface CronValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateScheduledCronExpression(
  cronExpression: string,
): CronValidationResult {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, reason: "Cron expression must have exactly 5 fields" };
  }

  try {
    const interval = cronParser.parseExpression(cronExpression, {
      currentDate: "2026-01-01T00:00:00.000Z",
      utc: true,
    });
    let previous = interval.next().toDate().getTime();
    for (let i = 0; i < 8; i += 1) {
      const next = interval.next().toDate().getTime();
      if (next - previous < SCHEDULED_TASK_MIN_INTERVAL_MS) {
        return {
          ok: false,
          reason: "Cron expression must not run more than once per hour",
        };
      }
      previous = next;
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Invalid cron expression",
    };
  }

  return { ok: true };
}
