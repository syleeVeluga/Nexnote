import { sql } from "drizzle-orm";
import type { Database } from "@wekiflow/db/client";

export interface AgentParityGateCriteria {
  minObservedDays: number;
  minComparableCount: number;
  minActionAgreementRate: number;
  minTargetPageAgreementRate: number;
}

export interface AgentParityDailyRow {
  day: string;
  agentRunCount: number;
  comparableCount: number;
  actionMatchCount: number;
  targetPageMatchCount: number;
  fullMatchCount: number;
  actionAgreementRate: number | null;
  targetPageAgreementRate: number | null;
  fullAgreementRate: number | null;
  totalAgentTokens: number;
}

export interface AgentParityGateStatus {
  status: "not_started" | "collecting" | "blocked" | "passed";
  canPromote: boolean;
  reason: string;
  observedDays: number;
  comparableCount: number;
  actionAgreementRate: number | null;
  targetPageAgreementRate: number | null;
  fullAgreementRate: number | null;
  criteria: AgentParityGateCriteria;
  failedChecks: string[];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function rowsArray<T extends Record<string, unknown>>(rows: unknown): T[] {
  const arr = (rows as { rows?: T[] }).rows ?? (rows as T[] | undefined) ?? [];
  return Array.isArray(arr) ? arr : [];
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toDayString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function readAgentParityGateCriteria(
  env: NodeJS.ProcessEnv = process.env,
): AgentParityGateCriteria {
  return {
    minObservedDays: parsePositiveInt(
      env["AGENT_PARITY_GATE_MIN_OBSERVED_DAYS"],
      7,
    ),
    minComparableCount: parsePositiveInt(
      env["AGENT_PARITY_GATE_MIN_COMPARABLE_COUNT"],
      20,
    ),
    minActionAgreementRate: parseRate(
      env["AGENT_PARITY_GATE_MIN_ACTION_AGREEMENT_RATE"],
      0.9,
    ),
    minTargetPageAgreementRate: parseRate(
      env["AGENT_PARITY_GATE_MIN_TARGET_PAGE_AGREEMENT_RATE"] ??
        env["AGENT_PARITY_GATE_MIN_TARGET_AGREEMENT_RATE"],
      0.85,
    ),
  };
}

export function evaluateAgentParityGate(
  dailyRows: AgentParityDailyRow[],
  criteria: AgentParityGateCriteria,
): AgentParityGateStatus {
  const observedRows = dailyRows.filter((row) => row.comparableCount > 0);
  const observedDays = observedRows.length;
  const comparableCount = observedRows.reduce(
    (sum, row) => sum + row.comparableCount,
    0,
  );
  const actionMatches = observedRows.reduce(
    (sum, row) => sum + row.actionMatchCount,
    0,
  );
  const targetMatches = observedRows.reduce(
    (sum, row) => sum + row.targetPageMatchCount,
    0,
  );
  const fullMatches = observedRows.reduce(
    (sum, row) => sum + row.fullMatchCount,
    0,
  );

  const actionAgreementRate =
    comparableCount === 0 ? null : actionMatches / comparableCount;
  const targetPageAgreementRate =
    comparableCount === 0 ? null : targetMatches / comparableCount;
  const fullAgreementRate =
    comparableCount === 0 ? null : fullMatches / comparableCount;

  const base = {
    observedDays,
    comparableCount,
    actionAgreementRate,
    targetPageAgreementRate,
    fullAgreementRate,
    criteria,
  };

  if (observedDays === 0) {
    return {
      ...base,
      status: "not_started",
      canPromote: false,
      reason: "Shadow parity has not collected comparable ingestions yet.",
      failedChecks: ["no_comparable_shadow_runs"],
    };
  }

  const collectionFailures: string[] = [];
  if (observedDays < criteria.minObservedDays) {
    collectionFailures.push("min_observed_days");
  }
  if (comparableCount < criteria.minComparableCount) {
    collectionFailures.push("min_comparable_count");
  }
  if (collectionFailures.length > 0) {
    return {
      ...base,
      status: "collecting",
      canPromote: false,
      reason: "Shadow parity is still collecting enough comparison data.",
      failedChecks: collectionFailures,
    };
  }

  const qualityFailures: string[] = [];
  if (
    actionAgreementRate == null ||
    actionAgreementRate < criteria.minActionAgreementRate
  ) {
    qualityFailures.push("min_action_agreement_rate");
  }
  if (
    targetPageAgreementRate == null ||
    targetPageAgreementRate < criteria.minTargetPageAgreementRate
  ) {
    qualityFailures.push("min_target_page_agreement_rate");
  }
  if (qualityFailures.length > 0) {
    return {
      ...base,
      status: "blocked",
      canPromote: false,
      reason: "Shadow parity is below the promotion threshold.",
      failedChecks: qualityFailures,
    };
  }

  return {
    ...base,
    status: "passed",
    canPromote: true,
    reason: "Shadow parity meets the promotion threshold.",
    failedChecks: [],
  };
}

export async function listAgentParityDailyRows(
  db: Database,
  workspaceId: string,
  sinceDays: number,
): Promise<AgentParityDailyRow[]> {
  const rows = rowsArray<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        day::text AS "day",
        agent_run_count AS "agentRunCount",
        comparable_count AS "comparableCount",
        action_match_count AS "actionMatchCount",
        target_page_match_count AS "targetPageMatchCount",
        full_match_count AS "fullMatchCount",
        action_agreement_rate AS "actionAgreementRate",
        target_page_agreement_rate AS "targetPageAgreementRate",
        full_agreement_rate AS "fullAgreementRate",
        total_agent_tokens AS "totalAgentTokens"
      FROM agent_vs_classic_agreement_rate
      WHERE workspace_id = ${workspaceId}
        AND day >= (current_date - ((${sinceDays}::int - 1) * interval '1 day'))::date
      ORDER BY day DESC
    `),
  );

  return rows.map((row) => ({
    day: toDayString(row.day),
    agentRunCount: toNumber(row.agentRunCount),
    comparableCount: toNumber(row.comparableCount),
    actionMatchCount: toNumber(row.actionMatchCount),
    targetPageMatchCount: toNumber(row.targetPageMatchCount),
    fullMatchCount: toNumber(row.fullMatchCount),
    actionAgreementRate: toNullableNumber(row.actionAgreementRate),
    targetPageAgreementRate: toNullableNumber(row.targetPageAgreementRate),
    fullAgreementRate: toNullableNumber(row.fullAgreementRate),
    totalAgentTokens: toNumber(row.totalAgentTokens),
  }));
}

export async function readAgentParityGateStatus(
  db: Database,
  workspaceId: string,
): Promise<AgentParityGateStatus> {
  const criteria = readAgentParityGateCriteria();
  const dailyRows = await listAgentParityDailyRows(
    db,
    workspaceId,
    criteria.minObservedDays,
  );
  return evaluateAgentParityGate(dailyRows, criteria);
}
