import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./users.js";

export const modelRuns = pgTable("model_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  mode: text("mode").notNull(),
  promptVersion: text("prompt_version").notNull(),
  tokenInput: integer("token_input"),
  tokenOutput: integer("token_output"),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull(),
  requestMetaJson: jsonb("request_meta_json"),
  responseMetaJson: jsonb("response_meta_json"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    modelRunId: uuid("model_run_id").references(() => modelRuns.id, {
      onDelete: "set null",
    }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
  ],
);

export type ModelRun = typeof modelRuns.$inferSelect;
export type NewModelRun = typeof modelRuns.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export const modelRunsRelations = relations(modelRuns, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [modelRuns.workspaceId],
    references: [workspaces.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [auditLogs.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
  }),
  modelRun: one(modelRuns, {
    fields: [auditLogs.modelRunId],
    references: [modelRuns.id],
  }),
}));
