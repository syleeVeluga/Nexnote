import { AgentToolError } from "../types.js";

export interface ReplaceInPagePatchInput {
  find: string;
  replace: string;
  occurrence?: number;
}

export interface ReplaceInPagePatchResult {
  contentMd: string;
  matchCount: number;
  occurrence: number;
}

interface MatchPosition {
  index: number;
  line: number;
  column: number;
  snippet: string;
}

function findAllOccurrences(markdown: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= markdown.length) {
    const index = markdown.indexOf(needle, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + Math.max(needle.length, 1);
  }
  return indexes;
}

function positionForIndex(markdown: string, index: number): MatchPosition {
  const before = markdown.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const lineStart = Math.max(before.lastIndexOf("\n") + 1, 0);
  const column = index - lineStart + 1;
  return {
    index,
    line,
    column,
    snippet: markdown
      .slice(Math.max(0, index - 120), Math.min(markdown.length, index + 240))
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 30);
}

function closestTextMatches(
  markdown: string,
  needle: string,
): Array<MatchPosition & { score: number }> {
  const needleTokens = new Set(tokenize(needle));
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  const scored: Array<MatchPosition & { score: number }> = [];

  for (const [index, line] of lines.entries()) {
    const lineTokens = tokenize(line);
    const overlap = lineTokens.filter((token) => needleTokens.has(token)).length;
    const prefixBonus = line
      .toLowerCase()
      .includes(needle.toLowerCase().slice(0, 24))
      ? 5
      : 0;
    const score = overlap * 10 + prefixBonus - Math.abs(line.length - needle.length) / 200;
    if (line.trim()) {
      scored.push({
        index: offset,
        line: index + 1,
        column: 1,
        snippet: line.trim().slice(0, 300),
        score,
      });
    }
    offset += line.length + 1;
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

export function applyReplaceInPagePatch(
  markdown: string,
  input: ReplaceInPagePatchInput,
): ReplaceInPagePatchResult {
  const matches = findAllOccurrences(markdown, input.find);
  if (matches.length === 0) {
    throw new AgentToolError(
      "patch_mismatch",
      "replace_in_page find text did not match the current page",
      { find: input.find.slice(0, 500) },
      {
        hint:
          "Use an exact, unique substring from the current page. The nearest candidate snippets below include line/column positions.",
        candidates: closestTextMatches(markdown, input.find),
      },
    );
  }

  const occurrence = input.occurrence ?? 1;
  if (!input.occurrence && matches.length !== 1) {
    throw new AgentToolError(
      "ambiguous_match",
      "replace_in_page find text matched multiple times; pass occurrence",
      {
        matchCount: matches.length,
        matches: matches.slice(0, 10).map((index) => positionForIndex(markdown, index)),
      },
      {
        hint:
          "The find text must be unique unless occurrence is provided. Pick a longer exact substring or pass occurrence using the listed positions.",
        candidates: matches.slice(0, 10).map((index) => positionForIndex(markdown, index)),
      },
    );
  }
  if (occurrence > matches.length) {
    throw new AgentToolError(
      "patch_mismatch",
      "replace_in_page occurrence exceeds match count",
      {
        occurrence,
        matchCount: matches.length,
        matches: matches.slice(0, 10).map((index) => positionForIndex(markdown, index)),
      },
      {
        hint:
          "Choose an occurrence that exists, or use one of the listed exact snippets as find.",
        candidates: matches.slice(0, 10).map((index) => positionForIndex(markdown, index)),
      },
    );
  }

  const start = matches[occurrence - 1];
  const contentMd =
    markdown.slice(0, start) +
    input.replace +
    markdown.slice(start + input.find.length);

  return {
    contentMd,
    matchCount: matches.length,
    occurrence,
  };
}
