/**
 * Normalize an entity name to a deterministic lookup key.
 * Must stay in sync with the `normalized_key` column in the `entities` table.
 */
export function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
