import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";
import { pages } from "./pages.js";
import { pageRevisions } from "./revisions.js";

export const pageLinks = pgTable(
  "page_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourcePageId: uuid("source_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    sourceRevisionId: uuid("source_revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "cascade" }),
    targetPageId: uuid("target_page_id").references(() => pages.id, {
      onDelete: "set null",
    }),
    targetSlug: text("target_slug").notNull(),
    linkText: text("link_text"),
    linkType: text("link_type").notNull(),
    positionInMd: integer("position_in_md"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("page_links_type_chk", sql`${t.linkType} IN ('wikilink', 'markdown')`),
    check(
      "page_links_position_chk",
      sql`${t.positionInMd} IS NULL OR ${t.positionInMd} >= 0`,
    ),
    index("page_links_target_idx")
      .on(t.workspaceId, t.targetPageId)
      .where(sql`${t.targetPageId} IS NOT NULL`),
    index("page_links_source_revision_idx").on(t.sourceRevisionId),
    uniqueIndex("page_links_revision_position_uk").on(
      t.sourceRevisionId,
      t.positionInMd,
      t.linkType,
      t.targetSlug,
    ),
    index("page_links_broken_idx")
      .on(t.workspaceId, t.targetSlug)
      .where(sql`${t.targetPageId} IS NULL`),
  ],
);

export type PageLink = typeof pageLinks.$inferSelect;
export type NewPageLink = typeof pageLinks.$inferInsert;

export const pageLinksRelations = relations(pageLinks, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [pageLinks.workspaceId],
    references: [workspaces.id],
  }),
  sourcePage: one(pages, {
    fields: [pageLinks.sourcePageId],
    references: [pages.id],
    relationName: "sourcePageLinks",
  }),
  targetPage: one(pages, {
    fields: [pageLinks.targetPageId],
    references: [pages.id],
    relationName: "targetPageLinks",
  }),
  sourceRevision: one(pageRevisions, {
    fields: [pageLinks.sourceRevisionId],
    references: [pageRevisions.id],
  }),
}));
