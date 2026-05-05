export const PAGE_LINK_TYPES = ["wikilink", "markdown"] as const;
export type PageLinkType = (typeof PAGE_LINK_TYPES)[number];

export interface ExtractedPageLink {
  targetSlug: string;
  linkText: string | null;
  linkType: PageLinkType;
  positionInMd: number;
}

interface Range {
  start: number;
  end: number;
}

function fencedCodeRanges(markdown: string): Range[] {
  const ranges: Range[] = [];
  const linePattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  let fenceStart: number | null = null;
  let fenceMarker: string | null = null;

  while ((match = linePattern.exec(markdown)) !== null) {
    const raw = match[0];
    if (raw === "" && match.index >= markdown.length) break;
    const trimmed = raw.trimStart();
    const fence = /^(```+|~~~+)/.exec(trimmed);
    if (fence) {
      const marker = fence[1][0];
      if (fenceStart === null) {
        fenceStart = match.index;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        ranges.push({ start: fenceStart, end: match.index + raw.length });
        fenceStart = null;
        fenceMarker = null;
      }
    }
    if (match.index + raw.length >= markdown.length) break;
  }

  if (fenceStart !== null) {
    ranges.push({ start: fenceStart, end: markdown.length });
  }
  return ranges;
}

function inRanges(index: number, ranges: Range[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isProbablyExternalTarget(target: string): boolean {
  return (
    target === "" ||
    target.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith("//")
  );
}

export function normalizePageLinkTarget(target: string): string | null {
  const trimmed = target.trim();
  if (isProbablyExternalTarget(trimmed)) return null;

  const withoutHash = trimmed.split("#", 1)[0] ?? "";
  const withoutQuery = withoutHash.split("?", 1)[0] ?? "";
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }

  const normalized = decoded
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function addLookupKey(keys: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  const normalized = normalizePageLinkTarget(value) ?? value.trim();
  if (!normalized) return;
  keys.add(normalized.toLowerCase());
}

export function pageLinkTargetLookupKeys(target: string): string[] {
  const normalized = normalizePageLinkTarget(target);
  if (!normalized) return [];

  const keys = new Set<string>();
  addLookupKey(keys, normalized);

  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts.at(-1);
  addLookupKey(keys, leaf);

  if (parts[0]?.toLowerCase() === "docs") {
    addLookupKey(keys, parts.slice(1).join("/"));
    addLookupKey(keys, parts.slice(2).join("/"));
  }

  return [...keys];
}

function pushUnique(
  links: ExtractedPageLink[],
  seen: Set<string>,
  link: ExtractedPageLink,
): void {
  const key = [
    link.linkType,
    link.positionInMd,
    link.targetSlug.toLocaleLowerCase(),
    link.linkText ?? "",
  ].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  links.push(link);
}

export function extractPageLinks(markdown: string): ExtractedPageLink[] {
  const codeRanges = fencedCodeRanges(markdown);
  const links: ExtractedPageLink[] = [];
  const seen = new Set<string>();

  const wikilinkPattern = /\[\[([^\]\n]+)\]\]/g;
  let wikiMatch: RegExpExecArray | null;
  while ((wikiMatch = wikilinkPattern.exec(markdown)) !== null) {
    if (inRanges(wikiMatch.index, codeRanges)) continue;
    const raw = wikiMatch[1].trim();
    const [targetRaw, labelRaw] = raw.split("|", 2);
    const targetSlug = normalizePageLinkTarget(targetRaw);
    if (!targetSlug) continue;
    const label = labelRaw?.trim() || null;
    pushUnique(links, seen, {
      targetSlug,
      linkText: label ?? targetSlug,
      linkType: "wikilink",
      positionInMd: wikiMatch.index,
    });
  }

  const markdownLinkPattern = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownLinkPattern.exec(markdown)) !== null) {
    if (inRanges(markdownMatch.index, codeRanges)) continue;
    const targetSlug = normalizePageLinkTarget(markdownMatch[2]);
    if (!targetSlug) continue;
    pushUnique(links, seen, {
      targetSlug,
      linkText: markdownMatch[1].trim() || null,
      linkType: "markdown",
      positionInMd: markdownMatch.index,
    });
  }

  return links.sort((a, b) => a.positionInMd - b.positionInMd);
}
