import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-runs.js";
import { users, workspaces } from "./users.js";

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cronExpression: text("cron_expression").notNull(),
    targetPageIds: uuid("target_page_ids").array().notNull(),
    includeDescendants: boolean("include_descendants")
      .notNull()
      .default(true),
    instruction: text("instruction"),
    enabled: boolean("enabled").notNull().default(true),
    bullRepeatKey: text("bull_repeat_key"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("scheduled_tasks_name_not_empty_chk", sql`length(trim(${t.name})) > 0`),
    check(
      "scheduled_tasks_cron_not_empty_chk",
      sql`length(trim(${t.cronExpression})) > 0`,
    ),
    check(
      "scheduled_tasks_target_page_ids_not_empty_chk",
      sql`cardinality(${t.targetPageIds}) > 0`,
    ),
    index("scheduled_tasks_workspace_idx")
      .on(t.workspaceId)
      .where(sql`${t.enabled} = true`),
  ],
);

export const scheduledRuns = pgTable(
  "scheduled_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").references(() => scheduledTasks.id, {
      onDelete: "set null",
    }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    triggeredBy: text("triggered_by").notNull(),
    status: text("status").notNull(),
    decisionCount: integer("decision_count").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 })
      .notNull()
      .default(sql`0`),
    diagnosticsJson: jsonb("diagnostics_json"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "scheduled_runs_triggered_by_chk",
      sql`${t.triggeredBy} IN ('cron','manual')`,
    ),
    check(
      "scheduled_runs_status_chk",
      sql`${t.status} IN ('running','completed','partial','failed')`,
    ),
    check("scheduled_runs_decision_count_chk", sql`${t.decisionCount} >= 0`),
    check("scheduled_runs_tokens_in_chk", sql`${t.tokensIn} >= 0`),
    check("scheduled_runs_tokens_out_chk", sql`${t.tokensOut} >= 0`),
    check("scheduled_runs_cost_usd_chk", sql`${t.costUsd} >= 0`),
    index("scheduled_runs_workspace_started_idx").on(
      t.workspaceId,
      t.startedAt,
    ),
  ],
);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;
export type ScheduledRun = typeof scheduledRuns.$inferSelect;
export type NewScheduledRun = typeof scheduledRuns.$inferInsert;

export const scheduledTasksRelations = relations(
  scheduledTasks,
  ({ one, many }) => ({
    workspace: one(workspaces, {
      fields: [scheduledTasks.workspaceId],
      references: [workspaces.id],
    }),
    createdByUser: one(users, {
      fields: [scheduledTasks.createdBy],
      references: [users.id],
    }),
    runs: many(scheduledRuns),
  }),
);

export const scheduledRunsRelations = relations(
  scheduledRuns,
  ({ one }) => ({
    task: one(scheduledTasks, {
      fields: [scheduledRuns.taskId],
      references: [scheduledTasks.id],
    }),
    workspace: one(workspaces, {
      fields: [scheduledRuns.workspaceId],
      references: [workspaces.id],
    }),
    agentRun: one(agentRuns, {
      fields: [scheduledRuns.agentRunId],
      references: [agentRuns.id],
    }),
  }),
);
