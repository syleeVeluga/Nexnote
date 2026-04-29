import { slugify } from "@wekiflow/shared";
import { AgentToolError } from "../types.js";

export type SectionPatchOp = "replace" | "append" | "prepend" | "delete";

export interface SectionPatchInput {
  sectionAnchor: string;
  op: SectionPatchOp;
  content?: string;
}

export interface SectionPatchResult {
  contentMd: string;
  headingText: string;
  headingLevel: number;
}

interface MarkdownHeading {
  level: number;
  text: string;
  anchor: string;
  start: number;
  lineEnd: number;
  sectionEnd: number;
}

function collectHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const linePattern = /.*(?:\r\n|\n|\r|$)/g;
  const headingPattern = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  let inFence = false;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(markdown)) !== null) {
    const raw = match[0];
    if (raw === "" && match.index >= markdown.length) break;
    const textLine = raw.replace(/(?:\r\n|\n|\r)$/, "");
    const trimmed = textLine.trim();
    const fenceLine = /^(```|~~~)/.test(trimmed);

    if (!inFence) {
      const headingMatch = headingPattern.exec(textLine);
      if (headingMatch) {
        const text = headingMatch[2].trim();
        headings.push({
          level: headingMatch[1].length,
          text,
          anchor: slugify(text),
          start: match.index,
          lineEnd: match.index + raw.length,
          sectionEnd: markdown.length,
        });
      }
    }

    if (fenceLine) {
      inFence = !inFence;
    }
    if (match.index + raw.length >= markdown.length) break;
  }

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const nextPeer = headings
      .slice(i + 1)
      .find((heading) => heading.level <= current.level);
    current.sectionEnd = nextPeer?.start ?? markdown.length;
  }

  return headings;
}

function normalizeContent(content: string | undefined): string {
  return (content ?? "").replace(/^\n+|\n+$/g, "");
}

export function applySectionPatch(
  markdown: string,
  input: SectionPatchInput,
): SectionPatchResult {
  const requested = slugify(input.sectionAnchor);
  const matches = collectHeadings(markdown).filter(
    (heading) =>
      heading.anchor === requested ||
      heading.text.trim().toLowerCase() === input.sectionAnchor.trim().toLowerCase(),
  );
  const availableHeadings = collectHeadings(markdown).map((heading) => ({
    anchor: heading.anchor,
    text: heading.text,
    level: heading.level,
    start: heading.start,
  }));

  if (matches.length === 0) {
    throw new AgentToolError(
      "patch_mismatch",
      `Heading section ${input.sectionAnchor} was not found`,
      { sectionAnchor: input.sectionAnchor, availableHeadings },
      {
        hint:
          "Use a sectionAnchor matching one current heading anchor or exact heading text. Re-read the page if headings changed.",
        candidates: availableHeadings.slice(0, 80),
      },
    );
  }
  if (matches.length > 1) {
    throw new AgentToolError(
      "ambiguous_match",
      `Heading section ${input.sectionAnchor} matched multiple headings`,
      {
        sectionAnchor: input.sectionAnchor,
        matchCount: matches.length,
        matches: matches.map((heading) => ({
          anchor: heading.anchor,
          text: heading.text,
          level: heading.level,
          start: heading.start,
        })),
      },
      {
        hint:
          "The section anchor must identify exactly one heading. Use exact heading text or a more specific anchor.",
        candidates: matches.map((heading) => ({
          anchor: heading.anchor,
          text: heading.text,
          level: heading.level,
          start: heading.start,
        })),
      },
    );
  }

  const heading = matches[0];
  const content = normalizeContent(input.content);
  let next: string;

  if (input.op === "delete") {
    next = markdown.slice(0, heading.start) + markdown.slice(heading.sectionEnd);
  } else if (input.op === "replace") {
    const headingLine = markdown.slice(heading.start, heading.lineEnd).trimEnd();
    next =
      markdown.slice(0, heading.start) +
      `${headingLine}\n\n${content}\n` +
      markdown.slice(heading.sectionEnd);
  } else if (input.op === "append") {
    const prefix = markdown.slice(0, heading.sectionEnd).trimEnd();
    next = `${prefix}\n\n${content}\n` + markdown.slice(heading.sectionEnd);
  } else {
    next =
      markdown.slice(0, heading.lineEnd).trimEnd() +
      `\n\n${content}\n\n` +
      markdown.slice(heading.lineEnd);
  }

  return {
    contentMd: next.replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n",
    headingText: heading.text,
    headingLevel: heading.level,
  };
}
