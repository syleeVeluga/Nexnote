import { and, eq, inArray } from "drizzle-orm";
import { predicateDisplayLabels } from "@wekiflow/db";

export async function loadPredicateDisplayLabels(
  db: any,
  predicates: string[],
  locale?: "ko" | "en",
): Promise<Map<string, string>> {
  if (!locale || predicates.length === 0) {
    return new Map();
  }

  const uniquePredicates = [...new Set(predicates)];
  let rows: Array<{ predicate: string; displayLabel: string }>;
  try {
    rows = await db
      .select({
        predicate: predicateDisplayLabels.predicate,
        displayLabel: predicateDisplayLabels.displayLabel,
      })
      .from(predicateDisplayLabels)
      .where(
        and(
          eq(predicateDisplayLabels.locale, locale),
          inArray(predicateDisplayLabels.predicate, uniquePredicates),
        ),
      );
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42P01") {
      return new Map();
    }
    throw error;
  }

  return new Map(
    rows.map((row: { predicate: string; displayLabel: string }) => [
      row.predicate,
      row.displayLabel,
    ]),
  );
}
