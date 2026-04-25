import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  real,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";
import { pages } from "./pages.js";
import { pageRevisions } from "./revisions.js";

export const revisionChunks = pgTable(
  "revision_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "cascade" }),
    parentChunkId: uuid("parent_chunk_id").references(
      (): AnyPgColumn => revisionChunks.id,
      { onDelete: "cascade" },
    ),
    chunkIndex: integer("chunk_index").notNull(),
    chunkKind: text("chunk_kind").notNull(),
    headingPath: jsonb("heading_path").notNull().default([]),
    contentMd: text("content_md").notNull(),
    digestText: text("digest_text").notNull(),
    contentHash: text("content_hash").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    structureConfidence: real("structure_confidence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "revision_chunks_kind_check",
      sql`${t.chunkKind} IN ('document', 'section', 'leaf')`,
    ),
    check(
      "revision_chunks_offsets_check",
      sql`${t.charStart} >= 0 AND ${t.charEnd} >= ${t.charStart}`,
    ),
    uniqueIndex("revision_chunks_revision_index_uk").on(
      t.revisionId,
      t.chunkIndex,
    ),
    index("revision_chunks_revision_kind_idx").on(
      t.revisionId,
      t.chunkKind,
      t.chunkIndex,
    ),
    index("revision_chunks_workspace_hash_idx").on(
      t.workspaceId,
      t.contentHash,
    ),
    index("revision_chunks_page_revision_idx").on(t.pageId, t.revisionId),
  ],
);

export type RevisionChunk = typeof revisionChunks.$inferSelect;
export type NewRevisionChunk = typeof revisionChunks.$inferInsert;

export const revisionChunksRelations = relations(
  revisionChunks,
  ({ one, many }) => ({
    workspace: one(workspaces, {
      fields: [revisionChunks.workspaceId],
      references: [workspaces.id],
    }),
    page: one(pages, {
      fields: [revisionChunks.pageId],
      references: [pages.id],
    }),
    revision: one(pageRevisions, {
      fields: [revisionChunks.revisionId],
      references: [pageRevisions.id],
    }),
    parent: one(revisionChunks, {
      fields: [revisionChunks.parentChunkId],
      references: [revisionChunks.id],
      relationName: "chunkHierarchy",
    }),
    children: many(revisionChunks, { relationName: "chunkHierarchy" }),
  }),
);
