import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./users.js";
import { pages } from "./pages.js";
import { pageRevisions } from "./revisions.js";

export const publishedSnapshots = pgTable(
  "published_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    sourceRevisionId: uuid("source_revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "restrict" }),
    publishedByUserId: uuid("published_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    publicPath: text("public_path").notNull(),
    title: text("title").notNull(),
    snapshotMd: text("snapshot_md").notNull(),
    snapshotHtml: text("snapshot_html").notNull(),
    tocJson: jsonb("toc_json"),
    isLive: boolean("is_live").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("published_snapshots_page_live_uk")
      .on(t.pageId)
      .where(sql`${t.isLive} = true`),
  ],
);

export type PublishedSnapshot = typeof publishedSnapshots.$inferSelect;
export type NewPublishedSnapshot = typeof publishedSnapshots.$inferInsert;

export const publishedSnapshotsRelations = relations(
  publishedSnapshots,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [publishedSnapshots.workspaceId],
      references: [workspaces.id],
    }),
    page: one(pages, {
      fields: [publishedSnapshots.pageId],
      references: [pages.id],
    }),
    sourceRevision: one(pageRevisions, {
      fields: [publishedSnapshots.sourceRevisionId],
      references: [pageRevisions.id],
    }),
    publishedByUser: one(users, {
      fields: [publishedSnapshots.publishedByUserId],
      references: [users.id],
    }),
  }),
);
