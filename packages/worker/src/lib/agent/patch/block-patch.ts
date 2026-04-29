import type { EditPageBlockOp } from "@wekiflow/shared";
import { parseMarkdownBlocks } from "../tools/read.js";
import { AgentToolError } from "../types.js";

export interface BlockPatchResult {
  contentMd: string;
  changedBlocks: number;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function normalizeBlockContent(content: string): string {
  return content.replace(/^\n+|\n+$/g, "");
}

function applyReplacements(markdown: string, replacements: Replacement[]): string {
  let next = markdown;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    next =
      next.slice(0, replacement.start) +
      replacement.text +
      next.slice(replacement.end);
  }
  return next;
}

export function applyBlockPatch(
  markdown: string,
  ops: EditPageBlockOp[],
): BlockPatchResult {
  const blocks = parseMarkdownBlocks(markdown);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const touched = new Set<string>();
  const replacements: Replacement[] = [];

  for (const op of ops) {
    if (touched.has(op.blockId)) {
      throw new AgentToolError(
        "conflict",
        `Multiple block operations target ${op.blockId}`,
        { blockId: op.blockId },
      );
    }
    touched.add(op.blockId);

    const block = byId.get(op.blockId);
    if (!block) {
      const availableBlocks = blocks.slice(0, 80).map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        headingLevel: candidate.headingLevel,
        excerpt: candidate.content.slice(0, 160),
      }));
      throw new AgentToolError(
        "patch_mismatch",
        `Block ${op.blockId} no longer exists in the current page`,
        { blockId: op.blockId, availableBlocks },
        {
          hint:
            "Use a blockId from the current read_page(format='blocks') result. Re-read the page if the block list is stale.",
          candidates: availableBlocks,
        },
      );
    }

    const content = op.content == null ? "" : normalizeBlockContent(op.content);
    if (op.op === "replace") {
      replacements.push({
        start: block.charStart,
        end: block.charEnd,
        text: content,
      });
    } else if (op.op === "delete") {
      replacements.push({ start: block.charStart, end: block.charEnd, text: "" });
    } else if (op.op === "insert_after") {
      replacements.push({
        start: block.charEnd,
        end: block.charEnd,
        text: `\n\n${content}`,
      });
    } else {
      replacements.push({
        start: block.charStart,
        end: block.charStart,
        text: `${content}\n\n`,
      });
    }
  }

  const contentMd = applyReplacements(markdown, replacements)
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd();

  return {
    contentMd: contentMd ? `${contentMd}\n` : "",
    changedBlocks: touched.size,
  };
}
