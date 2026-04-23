import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { modelRuns } from "./audit.js";

export const predicateDisplayLabels = pgTable(
  "predicate_display_labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    predicate: text("predicate").notNull(),
    locale: text("locale").notNull(),
    displayLabel: text("display_label").notNull(),
    source: text("source").notNull().default("ai"),
    modelRunId: uuid("model_run_id").references(() => modelRuns.id, {
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
    uniqueIndex("predicate_display_labels_locale_predicate_uk").on(
      t.locale,
      t.predicate,
    ),
    index("predicate_display_labels_predicate_idx").on(t.predicate),
  ],
);

export type PredicateDisplayLabel = typeof predicateDisplayLabels.$inferSelect;
export type NewPredicateDisplayLabel = typeof predicateDisplayLabels.$inferInsert;

export const predicateDisplayLabelsRelations = relations(
  predicateDisplayLabels,
  ({ one }) => ({
    modelRun: one(modelRuns, {
      fields: [predicateDisplayLabels.modelRunId],
      references: [modelRuns.id],
    }),
  }),
);
