import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  real,
  bigint,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./users.js";
import { pages, folders } from "./pages.js";
import { pageRevisions } from "./revisions.js";
import { modelRuns } from "./audit.js";
import { agentRuns } from "./agent-runs.js";
import { scheduledRuns } from "./scheduled.js";

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  sourceNameHint: text("source_name_hint"),
  scopes: text("scopes")
    .array()
    .notNull()
    .default(sql`ARRAY['ingestions:write']::text[]`),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ingestions = pgTable(
  "ingestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    apiTokenId: uuid("api_token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "restrict" }),
    sourceName: text("source_name").notNull(),
    externalRef: text("external_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    contentType: text("content_type").notNull(),
    titleHint: text("title_hint"),
    rawPayload: jsonb("raw_payload").notNull(),
    normalizedText: text("normalized_text"),
    storageKey: text("storage_key"),
    storageBytes: bigint("storage_bytes", { mode: "number" }),
    storageSha256: text("storage_sha256"),
    targetFolderId: uuid("target_folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    targetParentPageId: uuid("target_parent_page_id").references(
      () => pages.id,
      { onDelete: "set null" },
    ),
    useReconciliation: boolean("use_reconciliation").notNull().default(true),
    status: text("status").notNull().default("pending"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ingestions_workspace_idempotency_uk").on(
      t.workspaceId,
      t.idempotencyKey,
    ),
    index("ingestions_workspace_status_idx").on(
      t.workspaceId,
      t.status,
      t.receivedAt,
    ),
  ],
);

export const ingestionDecisions = pgTable(
  "ingestion_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ingestionId: uuid("ingestion_id")
      .notNull()
      .references(() => ingestions.id, { onDelete: "cascade" }),
    targetPageId: uuid("target_page_id").references(() => pages.id, {
      onDelete: "set null",
    }),
    proposedRevisionId: uuid("proposed_revision_id").references(
      () => pageRevisions.id,
      { onDelete: "set null" },
    ),
    modelRunId: uuid("model_run_id")
      .notNull()
      .references(() => modelRuns.id, { onDelete: "restrict" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    scheduledRunId: uuid("scheduled_run_id").references(
      () => scheduledRuns.id,
      { onDelete: "set null" },
    ),
    action: text("action").notNull(),
    status: text("status").notNull().default("suggested"),
    proposedPageTitle: text("proposed_page_title"),
    confidence: real("confidence").notNull(),
    rationaleJson: jsonb("rationale_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ingestion_decisions_ingestion_idx").on(t.ingestionId, t.createdAt),
    index("ingestion_decisions_status_idx").on(t.status, t.createdAt),
    index("ingestion_decisions_target_page_idx").on(t.targetPageId),
    index("ingestion_decisions_agent_run_idx").on(t.agentRunId),
    index("ingestion_decisions_scheduled_run_idx").on(t.scheduledRunId),
  ],
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
export type Ingestion = typeof ingestions.$inferSelect;
export type NewIngestion = typeof ingestions.$inferInsert;
export type IngestionDecision = typeof ingestionDecisions.$inferSelect;
export type NewIngestionDecision = typeof ingestionDecisions.$inferInsert;

export const apiTokensRelations = relations(apiTokens, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [apiTokens.workspaceId],
    references: [workspaces.id],
  }),
  createdByUser: one(users, {
    fields: [apiTokens.createdByUserId],
    references: [users.id],
  }),
  ingestions: many(ingestions),
}));

export const ingestionsRelations = relations(ingestions, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [ingestions.workspaceId],
    references: [workspaces.id],
  }),
  apiToken: one(apiTokens, {
    fields: [ingestions.apiTokenId],
    references: [apiTokens.id],
  }),
  decisions: many(ingestionDecisions),
}));

export const ingestionDecisionsRelations = relations(
  ingestionDecisions,
  ({ one }) => ({
    ingestion: one(ingestions, {
      fields: [ingestionDecisions.ingestionId],
      references: [ingestions.id],
    }),
    targetPage: one(pages, {
      fields: [ingestionDecisions.targetPageId],
      references: [pages.id],
    }),
    proposedRevision: one(pageRevisions, {
      fields: [ingestionDecisions.proposedRevisionId],
      references: [pageRevisions.id],
    }),
    modelRun: one(modelRuns, {
      fields: [ingestionDecisions.modelRunId],
      references: [modelRuns.id],
    }),
    agentRun: one(agentRuns, {
      fields: [ingestionDecisions.agentRunId],
      references: [agentRuns.id],
    }),
    scheduledRun: one(scheduledRuns, {
      fields: [ingestionDecisions.scheduledRunId],
      references: [scheduledRuns.id],
    }),
  }),
);
