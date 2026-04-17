import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workspaces } from "./users.js";

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentFolderId: uuid("parent_folder_id").references(
      (): AnyPgColumn => folders.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("folders_workspace_parent_slug_uk").on(
      t.workspaceId,
      t.parentFolderId,
      t.slug,
    ),
  ],
);

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentPageId: uuid("parent_page_id").references(
      (): AnyPgColumn => pages.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    // FK references deferred to migration SQL to avoid circular imports
    currentRevisionId: uuid("current_revision_id"),
    latestPublishedSnapshotId: uuid("latest_published_snapshot_id"),
    lastAiUpdatedAt: timestamp("last_ai_updated_at", { withTimezone: true }),
    lastHumanEditedAt: timestamp("last_human_edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pages_workspace_slug_uk").on(t.workspaceId, t.slug),
    index("pages_workspace_parent_idx").on(
      t.workspaceId,
      t.parentPageId,
      t.sortOrder,
    ),
  ],
);

export const pagePaths = pgTable(
  "page_paths",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("page_paths_current_path_uk")
      .on(t.workspaceId, t.path)
      .where(sql`${t.isCurrent} = true`),
  ],
);

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type PagePath = typeof pagePaths.$inferSelect;
export type NewPagePath = typeof pagePaths.$inferInsert;

export const foldersRelations = relations(folders, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [folders.workspaceId],
    references: [workspaces.id],
  }),
  parentFolder: one(folders, {
    fields: [folders.parentFolderId],
    references: [folders.id],
    relationName: "parentChild",
  }),
  childFolders: many(folders, { relationName: "parentChild" }),
  pages: many(pages),
}));

export const pagesRelations = relations(pages, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [pages.workspaceId],
    references: [workspaces.id],
  }),
  parentPage: one(pages, {
    fields: [pages.parentPageId],
    references: [pages.id],
    relationName: "parentChild",
  }),
  childPages: many(pages, { relationName: "parentChild" }),
  pagePaths: many(pagePaths),
}));

export const pagePathsRelations = relations(pagePaths, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [pagePaths.workspaceId],
    references: [workspaces.id],
  }),
  page: one(pages, {
    fields: [pagePaths.pageId],
    references: [pages.id],
  }),
}));
