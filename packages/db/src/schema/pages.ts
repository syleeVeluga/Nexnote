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
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./users.js";

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
    parentFolderId: uuid("parent_folder_id").references(
      (): AnyPgColumn => folders.id,
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pages_workspace_slug_active_uk")
      .on(t.workspaceId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index("pages_workspace_parent_idx").on(
      t.workspaceId,
      t.parentPageId,
      t.sortOrder,
    ),
    index("pages_workspace_folder_idx").on(
      t.workspaceId,
      t.parentFolderId,
      t.sortOrder,
    ),
    index("pages_workspace_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.deletedAt} IS NULL`),
    index("pages_workspace_trashed_idx")
      .on(t.workspaceId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    check(
      "pages_single_parent_chk",
      sql`${t.parentPageId} IS NULL OR ${t.parentFolderId} IS NULL`,
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

export const pageRedirects = pgTable(
  "page_redirects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromPageId: uuid("from_page_id").references(() => pages.id, {
      onDelete: "set null",
    }),
    toPageId: uuid("to_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    fromPath: text("from_path").notNull(),
    // FK added in SQL migration to avoid a schema module cycle with ingestions.
    createdByDecisionId: uuid("created_by_decision_id"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("page_redirects_workspace_from_path_active_uk")
      .on(t.workspaceId, t.fromPath)
      .where(sql`${t.disabledAt} IS NULL`),
    index("page_redirects_to_page_idx").on(t.toPageId),
    index("page_redirects_decision_idx").on(t.createdByDecisionId),
  ],
);

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type PagePath = typeof pagePaths.$inferSelect;
export type NewPagePath = typeof pagePaths.$inferInsert;
export type PageRedirect = typeof pageRedirects.$inferSelect;
export type NewPageRedirect = typeof pageRedirects.$inferInsert;

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
  parentFolder: one(folders, {
    fields: [pages.parentFolderId],
    references: [folders.id],
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

export const pageRedirectsRelations = relations(pageRedirects, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [pageRedirects.workspaceId],
    references: [workspaces.id],
  }),
  fromPage: one(pages, {
    fields: [pageRedirects.fromPageId],
    references: [pages.id],
    relationName: "redirectFromPage",
  }),
  toPage: one(pages, {
    fields: [pageRedirects.toPageId],
    references: [pages.id],
    relationName: "redirectToPage",
  }),
}));
