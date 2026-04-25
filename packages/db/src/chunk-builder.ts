import { createHash } from "node:crypto";
import { estimateTokens } from "@wekiflow/shared";

export type BuiltRevisionChunk = {
  chunkIndex: number;
  chunkKind: "document" | "section" | "leaf";
  parentChunkIndex: number | null;
  headingPath: string[];
  contentMd: string;
  digestText: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  structureConfidence: number;
};

const LEAF_TARGET_CHARS = 3600;
const LEAF_MAX_CHARS = 5200;
const DIGEST_CHARS = 360;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function digest(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= DIGEST_CHARS) return collapsed;
  return `${collapsed.slice(0, DIGEST_CHARS).trim()}...`;
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? match[1].length : null;
}

function splitLeafRanges(content: string, absoluteStart: number) {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < content.length) {
    const remaining = content.length - cursor;
    if (remaining <= LEAF_MAX_CHARS) {
      ranges.push({
        start: absoluteStart + cursor,
        end: absoluteStart + content.length,
      });
      break;
    }

    const target = cursor + LEAF_TARGET_CHARS;
    const windowEnd = Math.min(content.length, cursor + LEAF_MAX_CHARS);
    const window = content.slice(cursor, windowEnd);
    const relativeBreaks = [
      window.lastIndexOf("\n\n", target - cursor),
      window.lastIndexOf(". ", target - cursor),
      window.lastIndexOf("\n", target - cursor),
    ].filter((idx) => idx > 0);
    const bestBreak =
      relativeBreaks.length > 0 ? Math.max(...relativeBreaks) + 1 : LEAF_TARGET_CHARS;
    const next = Math.min(content.length, cursor + bestBreak);

    ranges.push({ start: absoluteStart + cursor, end: absoluteStart + next });
    cursor = next;
  }

  return ranges;
}

type Section = {
  headingPath: string[];
  start: number;
  end: number;
  structureConfidence: number;
};

function findSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const headings: string[] = [];
  let active: Section | null = null;
  let offset = 0;

  const lines = markdown.split(/(?<=\n)/);
  for (const line of lines) {
    const level = headingLevel(line);
    if (level) {
      if (active) {
        active.end = offset;
        sections.push(active);
      }
      headings.splice(level - 1);
      headings[level - 1] = line.replace(/^#{1,6}\s+/, "").trim();
      active = {
        headingPath: headings.filter(Boolean),
        start: offset,
        end: markdown.length,
        structureConfidence: 1,
      };
    }
    offset += line.length;
  }

  if (active) sections.push(active);

  if (sections.length > 0) return sections;

  const paragraphs = markdown.split(/\n\s*\n/);
  let cursor = 0;
  let bucketStart = 0;
  let bucket = "";
  let index = 1;
  const pseudo: Section[] = [];
  for (const paragraph of paragraphs) {
    const paragraphStart = markdown.indexOf(paragraph, cursor);
    const paragraphEnd = paragraphStart + paragraph.length;
    if (bucket && bucket.length + paragraph.length > LEAF_MAX_CHARS * 2) {
      pseudo.push({
        headingPath: [`Section ${index++}`],
        start: bucketStart,
        end: cursor,
        structureConfidence: 0.45,
      });
      bucket = "";
    }
    if (!bucket) bucketStart = paragraphStart;
    bucket += `${paragraph}\n\n`;
    cursor = paragraphEnd + 2;
  }
  if (bucket) {
    pseudo.push({
      headingPath: [`Section ${index}`],
      start: bucketStart,
      end: markdown.length,
      structureConfidence: 0.45,
    });
  }

  return pseudo.length > 0
    ? pseudo
    : [
        {
          headingPath: ["Document"],
          start: 0,
          end: markdown.length,
          structureConfidence: 0.3,
        },
      ];
}

export function buildRevisionChunks(markdown: string): BuiltRevisionChunk[] {
  const chunks: BuiltRevisionChunk[] = [];
  const content = markdown || "";

  chunks.push({
    chunkIndex: 0,
    chunkKind: "document",
    parentChunkIndex: null,
    headingPath: [],
    contentMd: content.slice(0, Math.min(content.length, LEAF_MAX_CHARS)),
    digestText: digest(content),
    contentHash: sha256(content),
    charStart: 0,
    charEnd: content.length,
    tokenEstimate: estimateTokens(content),
    structureConfidence: headingLevel(content.split("\n", 1)[0] ?? "") ? 1 : 0.6,
  });

  let nextIndex = 1;
  for (const section of findSections(content)) {
    const sectionText = content.slice(section.start, section.end);
    const sectionIndex = nextIndex++;
    chunks.push({
      chunkIndex: sectionIndex,
      chunkKind: "section",
      parentChunkIndex: 0,
      headingPath: section.headingPath,
      contentMd: sectionText,
      digestText: digest(sectionText),
      contentHash: sha256(sectionText),
      charStart: section.start,
      charEnd: section.end,
      tokenEstimate: estimateTokens(sectionText),
      structureConfidence: section.structureConfidence,
    });

    for (const range of splitLeafRanges(sectionText, section.start)) {
      const leafText = content.slice(range.start, range.end);
      chunks.push({
        chunkIndex: nextIndex++,
        chunkKind: "leaf",
        parentChunkIndex: sectionIndex,
        headingPath: section.headingPath,
        contentMd: leafText,
        digestText: digest(leafText),
        contentHash: sha256(leafText),
        charStart: range.start,
        charEnd: range.end,
        tokenEstimate: estimateTokens(leafText),
        structureConfidence: section.structureConfidence,
      });
    }
  }

  return chunks;
}
