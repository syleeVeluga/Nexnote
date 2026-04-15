/**
 * Generate a URL-safe slug from a title string.
 * Supports Korean (Hangul), CJK, and all Unicode letters/numbers.
 * Output matches the `slugSchema` validation pattern.
 */
export function slugify(title: string, maxLength = 200): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .slice(0, maxLength)
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}
