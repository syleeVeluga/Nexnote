import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  real,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./users.js";
import { pages } from "./pages.js";
import { modelRuns } from "./audit.js";
import { users } from "./users.js";

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    entityType: text("entity_type").notNull(),
    metadataJson: jsonb("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entities_workspace_normalized_key_uk").on(
      t.workspaceId,
      t.normalizedKey,
    ),
  ],
);

export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdByExtractionId: uuid("created_by_extraction_id").references(
      () => modelRuns.id,
      { onDelete: "set null" },
    ),
    sourcePageId: uuid("source_page_id").references(() => pages.id, {
      onDelete: "set null",
    }),
    similarityScore: real("similarity_score"),
    matchMethod: text("match_method"),
    status: text("status").notNull().default("active"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedByUserId: uuid("rejected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entity_aliases_entity_norm_uk").on(
      t.entityId,
      t.normalizedAlias,
    ),
    index("entity_aliases_entity_status_idx").on(
      t.entityId,
      t.status,
      t.createdAt,
    ),
    check(
      "entity_aliases_status_chk",
      sql`${t.status} IN ('active','rejected')`,
    ),
  ],
);

export const entityReconciliationSuggestions = pgTable(
  "entity_reconciliation_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    aliasText: text("alias_text").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    method: text("method").notNull(),
    confidence: real("confidence").notNull(),
    reason: text("reason").notNull(),
    evidenceJson: jsonb("evidence_json"),
    modelRunId: uuid("model_run_id").references(() => modelRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: uuid("rejected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("entity_reconciliation_suggestions_workspace_status_idx").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    index("entity_reconciliation_suggestions_source_idx").on(t.sourceEntityId),
    index("entity_reconciliation_suggestions_target_idx").on(t.targetEntityId),
    check(
      "entity_reconciliation_suggestions_method_chk",
      sql`${t.method} IN ('llm_judge')`,
    ),
    check(
      "entity_reconciliation_suggestions_status_chk",
      sql`${t.status} IN ('pending','approved','rejected')`,
    ),
    check(
      "entity_reconciliation_suggestions_confidence_chk",
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
  ],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type EntityReconciliationSuggestion =
  typeof entityReconciliationSuggestions.$inferSelect;
export type NewEntityReconciliationSuggestion =
  typeof entityReconciliationSuggestions.$inferInsert;

export const entitiesRelations = relations(entities, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [entities.workspaceId],
    references: [workspaces.id],
  }),
  aliases: many(entityAliases),
}));

export const entityAliasesRelations = relations(entityAliases, ({ one }) => ({
  entity: one(entities, {
    fields: [entityAliases.entityId],
    references: [entities.id],
  }),
}));

export const entityReconciliationSuggestionsRelations = relations(
  entityReconciliationSuggestions,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [entityReconciliationSuggestions.workspaceId],
      references: [workspaces.id],
    }),
    sourceEntity: one(entities, {
      fields: [entityReconciliationSuggestions.sourceEntityId],
      references: [entities.id],
      relationName: "sourceReconciliationSuggestions",
    }),
    targetEntity: one(entities, {
      fields: [entityReconciliationSuggestions.targetEntityId],
      references: [entities.id],
      relationName: "targetReconciliationSuggestions",
    }),
    modelRun: one(modelRuns, {
      fields: [entityReconciliationSuggestions.modelRunId],
      references: [modelRuns.id],
    }),
  }),
);
