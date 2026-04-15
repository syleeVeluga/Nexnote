/**
 * Generate a URL-safe slug from a title string.
 * Output matches the `slugSchema` validation pattern.
 */
export function slugify(title: string, maxLength = 200): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, maxLength) || "untitled"
  );
}
