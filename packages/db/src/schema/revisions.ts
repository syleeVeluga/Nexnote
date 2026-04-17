import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { pages } from "./pages.js";

export const pageRevisions = pgTable(
  "page_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    baseRevisionId: uuid("base_revision_id").references(
      (): AnyPgColumn => pageRevisions.id,
      { onDelete: "set null" },
    ),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    modelRunId: uuid("model_run_id"),
    actorType: text("actor_type").notNull(),
    source: text("source").notNull(),
    // FK references deferred to migration SQL to avoid circular imports with ingestions.ts
    sourceIngestionId: uuid("source_ingestion_id"),
    sourceDecisionId: uuid("source_decision_id"),
    contentMd: text("content_md").notNull(),
    contentJson: jsonb("content_json"),
    revisionNote: text("revision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("page_revisions_page_created_idx").on(t.pageId, t.createdAt),
    index("page_revisions_source_ingestion_idx").on(t.sourceIngestionId),
  ],
);

export const revisionDiffs = pgTable("revision_diffs", {
  revisionId: uuid("revision_id")
    .primaryKey()
    .references(() => pageRevisions.id, { onDelete: "cascade" }),
  diffMd: text("diff_md"),
  diffOpsJson: jsonb("diff_ops_json"),
  changedBlocks: integer("changed_blocks"),
});

export type PageRevision = typeof pageRevisions.$inferSelect;
export type NewPageRevision = typeof pageRevisions.$inferInsert;
export type RevisionDiff = typeof revisionDiffs.$inferSelect;
export type NewRevisionDiff = typeof revisionDiffs.$inferInsert;

export const pageRevisionsRelations = relations(
  pageRevisions,
  ({ one }) => ({
    page: one(pages, {
      fields: [pageRevisions.pageId],
      references: [pages.id],
    }),
    baseRevision: one(pageRevisions, {
      fields: [pageRevisions.baseRevisionId],
      references: [pageRevisions.id],
      relationName: "revisionLineage",
    }),
    actorUser: one(users, {
      fields: [pageRevisions.actorUserId],
      references: [users.id],
    }),
    diff: one(revisionDiffs, {
      fields: [pageRevisions.id],
      references: [revisionDiffs.revisionId],
    }),
  }),
);

export const revisionDiffsRelations = relations(revisionDiffs, ({ one }) => ({
  revision: one(pageRevisions, {
    fields: [revisionDiffs.revisionId],
    references: [pageRevisions.id],
  }),
}));
