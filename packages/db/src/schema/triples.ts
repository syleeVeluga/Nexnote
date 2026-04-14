import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  real,
  index,
  check,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";
import { pages } from "./pages.js";
import { pageRevisions } from "./revisions.js";
import { entities } from "./entities.js";
import { modelRuns } from "./audit.js";

export const triples = pgTable(
  "triples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectEntityId: uuid("subject_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    objectEntityId: uuid("object_entity_id").references(() => entities.id, {
      onDelete: "cascade",
    }),
    objectLiteral: text("object_literal"),
    confidence: real("confidence").notNull(),
    sourcePageId: uuid("source_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    sourceRevisionId: uuid("source_revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "cascade" }),
    extractionModelRunId: uuid("extraction_model_run_id").references(
      () => modelRuns.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "triples_object_xor_check",
      sql`(${t.objectEntityId} IS NOT NULL AND ${t.objectLiteral} IS NULL) OR (${t.objectEntityId} IS NULL AND ${t.objectLiteral} IS NOT NULL)`,
    ),
    index("triples_workspace_subject_idx").on(
      t.workspaceId,
      t.subjectEntityId,
    ),
    index("triples_workspace_object_idx").on(
      t.workspaceId,
      t.objectEntityId,
    ),
    index("triples_source_page_idx").on(t.sourcePageId),
    index("triples_source_revision_idx").on(t.sourceRevisionId),
  ],
);

export const tripleMentions = pgTable(
  "triple_mentions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tripleId: uuid("triple_id")
      .notNull()
      .references(() => triples.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "cascade" }),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    excerpt: text("excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("triple_mentions_triple_idx").on(t.tripleId),
    index("triple_mentions_revision_idx").on(t.revisionId),
  ],
);

export type Triple = typeof triples.$inferSelect;
export type NewTriple = typeof triples.$inferInsert;
export type TripleMention = typeof tripleMentions.$inferSelect;
export type NewTripleMention = typeof tripleMentions.$inferInsert;

export const triplesRelations = relations(triples, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [triples.workspaceId],
    references: [workspaces.id],
  }),
  subjectEntity: one(entities, {
    fields: [triples.subjectEntityId],
    references: [entities.id],
    relationName: "subjectTriples",
  }),
  objectEntity: one(entities, {
    fields: [triples.objectEntityId],
    references: [entities.id],
    relationName: "objectTriples",
  }),
  sourcePage: one(pages, {
    fields: [triples.sourcePageId],
    references: [pages.id],
  }),
  sourceRevision: one(pageRevisions, {
    fields: [triples.sourceRevisionId],
    references: [pageRevisions.id],
  }),
  extractionModelRun: one(modelRuns, {
    fields: [triples.extractionModelRunId],
    references: [modelRuns.id],
  }),
  mentions: many(tripleMentions),
}));

export const tripleMentionsRelations = relations(
  tripleMentions,
  ({ one }) => ({
    triple: one(triples, {
      fields: [tripleMentions.tripleId],
      references: [triples.id],
    }),
    page: one(pages, {
      fields: [tripleMentions.pageId],
      references: [pages.id],
    }),
    revision: one(pageRevisions, {
      fields: [tripleMentions.revisionId],
      references: [pageRevisions.id],
    }),
  }),
);
