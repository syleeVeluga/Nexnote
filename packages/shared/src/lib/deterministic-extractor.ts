/**
 * Pulls out facts from a Markdown document using deterministic rules only —
 * no LLM. Runs before every downstream AI stage so the model sees less
 * boilerplate and so reviewers get structured evidence even when extraction
 * fails. Scope is intentionally conservative: structural elements only
 * (frontmatter, explicit links, wikilinks). Prose-level entity guessing is
 * left to the LLM.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n)+/;
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+?)\]\(([^)\s]+?)\)/g;

export interface ExtractedExternalLink {
  text: string;
  url: string;
}

export interface ExtractedWikilink {
  target: string;
  display: string | null;
}

export interface DeterministicFacts {
  /** Parsed frontmatter block as a flat record. Values are string | string[]. */
  frontmatter: Record<string, string | string[]>;
  /** Page title declared in frontmatter, if any. */
  title: string | null;
  /** `aliases:` array from frontmatter (empty if absent). */
  aliases: string[];
  /** `tags:` array from frontmatter (empty if absent). */
  tags: string[];
  /** Distinct `http(s)://` links in the body. Dedup by url. */
  externalLinks: ExtractedExternalLink[];
  /** `[[Page]]` / `[[Page|Label]]` references. Dedup by target. */
  wikilinks: ExtractedWikilink[];
  /** Body markdown with frontmatter removed. Safe to feed to downstream LLMs. */
  strippedMarkdown: string;
}

function parseFrontmatterBody(
  body: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = body.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const pushCurrent = () => {
    if (currentKey && currentList) {
      out[currentKey] = currentList;
    }
    currentKey = null;
    currentList = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey && currentList) {
      currentList.push(stripQuotes(listItem[1].trim()));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      pushCurrent();
      continue;
    }

    pushCurrent();
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (!value) {
      currentKey = key;
      currentList = [];
      continue;
    }

    const inlineArray = /^\[(.*)\]$/.exec(value);
    if (inlineArray) {
      out[key] = inlineArray[1]
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean);
      continue;
    }

    out[key] = stripQuotes(value);
  }

  pushCurrent();
  return out;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item.length > 0);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function extractDeterministicFacts(markdown: string): DeterministicFacts {
  const fmMatch = FRONTMATTER_RE.exec(markdown);
  const frontmatter = fmMatch ? parseFrontmatterBody(fmMatch[1]) : {};
  const strippedMarkdown = fmMatch
    ? markdown.slice(fmMatch[0].length)
    : markdown;

  const externalLinkByUrl = new Map<string, ExtractedExternalLink>();
  for (const match of strippedMarkdown.matchAll(MARKDOWN_LINK_RE)) {
    const text = match[1].trim();
    const url = match[2].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!externalLinkByUrl.has(url)) {
      externalLinkByUrl.set(url, { text, url });
    }
  }

  const wikilinkByTarget = new Map<string, ExtractedWikilink>();
  for (const match of strippedMarkdown.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    const display = match[2]?.trim() ?? null;
    if (!target) continue;
    if (!wikilinkByTarget.has(target)) {
      wikilinkByTarget.set(target, { target, display });
    }
  }

  const titleRaw = frontmatter["title"];
  const title = typeof titleRaw === "string" && titleRaw ? titleRaw : null;

  return {
    frontmatter,
    title,
    aliases: asStringArray(frontmatter["aliases"]),
    tags: asStringArray(frontmatter["tags"]),
    externalLinks: [...externalLinkByUrl.values()],
    wikilinks: [...wikilinkByTarget.values()],
    strippedMarkdown,
  };
}
