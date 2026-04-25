import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  real,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";
import { pages } from "./pages.js";
import { modelRuns } from "./audit.js";

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entity_aliases_entity_norm_uk").on(
      t.entityId,
      t.normalizedAlias,
    ),
  ],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;

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
