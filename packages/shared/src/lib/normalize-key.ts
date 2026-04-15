/**
 * Normalize an entity name to a deterministic lookup key.
 * Supports Korean (Hangul), CJK, and all Unicode letters/numbers.
 * Must stay in sync with the `normalized_key` column in the `entities` table.
 */
export function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_|_$/g, "");
}
