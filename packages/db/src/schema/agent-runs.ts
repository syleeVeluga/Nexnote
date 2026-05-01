import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // FK to ingestions is enforced in migration SQL to avoid a schema module
    // cycle with ingestion_decisions.agent_run_id.
    // Scheduled agent runs do not have an ingestion row, so this is nullable.
    ingestionId: uuid("ingestion_id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    planJson: jsonb("plan_json"),
    stepsJson: jsonb("steps_json").notNull().default([]),
    decisionsCount: integer("decisions_count").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    totalLatencyMs: integer("total_latency_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "agent_runs_status_chk",
      sql`${t.status} IN ('running','completed','failed','timeout','shadow')`,
    ),
    check("agent_runs_decisions_count_chk", sql`${t.decisionsCount} >= 0`),
    check("agent_runs_total_tokens_chk", sql`${t.totalTokens} >= 0`),
    check(
      "agent_runs_total_latency_ms_chk",
      sql`${t.totalLatencyMs} >= 0`,
    ),
    index("agent_runs_ingestion_idx").on(t.ingestionId),
    index("agent_runs_workspace_started_idx").on(t.workspaceId, t.startedAt),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [agentRuns.workspaceId],
    references: [workspaces.id],
  }),
}));
