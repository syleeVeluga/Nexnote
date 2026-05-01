import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  primaryKey,
  boolean,
  integer,
  numeric,
  check,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    defaultAiPolicy: text("default_ai_policy"),
    agentInstructions: text("agent_instructions"),
    agentProvider: text("agent_provider"),
    agentModelFast: text("agent_model_fast"),
    agentModelLargeContext: text("agent_model_large_context"),
    agentFastThresholdTokens: integer("agent_fast_threshold_tokens"),
    agentDailyTokenCap: integer("agent_daily_token_cap"),
    agentParityMinObservedDays: integer("agent_parity_min_observed_days"),
    agentParityMinComparableCount: integer("agent_parity_min_comparable_count"),
    agentParityMinActionAgreementRate: numeric(
      "agent_parity_min_action_agreement_rate",
      { precision: 4, scale: 3 },
    ),
    agentParityMinTargetPageAgreementRate: numeric(
      "agent_parity_min_target_page_agreement_rate",
      { precision: 4, scale: 3 },
    ),
    scheduledEnabled: boolean("scheduled_enabled").notNull().default(false),
    scheduledAutoApply: boolean("scheduled_auto_apply")
      .notNull()
      .default(false),
    scheduledDailyTokenCap: integer("scheduled_daily_token_cap"),
    scheduledPerRunPageLimit: integer("scheduled_per_run_page_limit")
      .notNull()
      .default(50),
    useReconciliationDefault: boolean("use_reconciliation_default")
      .notNull()
      .default(true),
    ingestionMode: text("ingestion_mode").notNull().default("classic"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "workspaces_ingestion_mode_chk",
      sql`${t.ingestionMode} IN ('classic','shadow','agent')`,
    ),
    check(
      "workspaces_agent_provider_chk",
      sql`${t.agentProvider} IS NULL OR ${t.agentProvider} IN ('openai','gemini')`,
    ),
    check(
      "workspaces_agent_fast_threshold_tokens_chk",
      sql`${t.agentFastThresholdTokens} IS NULL OR ${t.agentFastThresholdTokens} > 0`,
    ),
    check(
      "workspaces_agent_daily_token_cap_chk",
      sql`${t.agentDailyTokenCap} IS NULL OR ${t.agentDailyTokenCap} > 0`,
    ),
    check(
      "workspaces_agent_parity_min_observed_days_chk",
      sql`${t.agentParityMinObservedDays} IS NULL OR (${t.agentParityMinObservedDays} BETWEEN 1 AND 30)`,
    ),
    check(
      "workspaces_agent_parity_min_comparable_count_chk",
      sql`${t.agentParityMinComparableCount} IS NULL OR (${t.agentParityMinComparableCount} BETWEEN 1 AND 1000)`,
    ),
    check(
      "workspaces_agent_parity_min_action_agreement_rate_chk",
      sql`${t.agentParityMinActionAgreementRate} IS NULL OR (${t.agentParityMinActionAgreementRate} BETWEEN 0 AND 1)`,
    ),
    check(
      "workspaces_agent_parity_min_target_page_agreement_rate_chk",
      sql`${t.agentParityMinTargetPageAgreementRate} IS NULL OR (${t.agentParityMinTargetPageAgreementRate} BETWEEN 0 AND 1)`,
    ),
    check(
      "workspaces_scheduled_daily_token_cap_chk",
      sql`${t.scheduledDailyTokenCap} IS NULL OR ${t.scheduledDailyTokenCap} > 0`,
    ),
    check(
      "workspaces_scheduled_per_run_page_limit_chk",
      sql`${t.scheduledPerRunPageLimit} BETWEEN 1 AND 500`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

export const usersRelations = relations(users, ({ many }) => ({
  workspaceMembers: many(workspaceMembers),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  workspaceMembers: many(workspaceMembers),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  }),
);
