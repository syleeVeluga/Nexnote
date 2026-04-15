import { createTwoFilesPatch } from "diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockDiffOp {
  type: "add" | "remove" | "modify" | "keep";
  index: number;
  oldBlock?: unknown;
  newBlock?: unknown;
}

export interface BlockDiffResult {
  ops: BlockDiffOp[];
  changedBlocks: number;
}

export interface DiffResult {
  diffMd: string;
  diffOpsJson: BlockDiffOp[];
  changedBlocks: number;
}

/**
 * Number of header lines that `createTwoFilesPatch` always emits
 * (file names + --- / +++ lines). A diff with only these lines has no changes.
 */
export const UNIFIED_DIFF_HEADER_LINES = 4;

// ---------------------------------------------------------------------------
// Markdown diff — unified format
// ---------------------------------------------------------------------------

export function computeMarkdownDiff(oldMd: string, newMd: string): string {
  return createTwoFilesPatch("a.md", "b.md", oldMd, newMd, "", "", {
    context: 3,
  });
}

// ---------------------------------------------------------------------------
// Block diff — top-level ProseMirror block comparison
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function extractBlocks(json: Record<string, unknown> | null): unknown[] {
  if (!json) return [];
  const content = json.content;
  if (Array.isArray(content)) return content;
  return [];
}

export function computeBlockDiff(
  oldJson: Record<string, unknown> | null,
  newJson: Record<string, unknown> | null,
): BlockDiffResult {
  const oldBlocks = extractBlocks(oldJson);
  const newBlocks = extractBlocks(newJson);

  const ops: BlockDiffOp[] = [];
  let changed = 0;
  const maxLen = Math.max(oldBlocks.length, newBlocks.length);

  for (let i = 0; i < maxLen; i++) {
    const oldB = i < oldBlocks.length ? oldBlocks[i] : undefined;
    const newB = i < newBlocks.length ? newBlocks[i] : undefined;

    if (oldB === undefined) {
      ops.push({ type: "add", index: i, newBlock: newB });
      changed++;
    } else if (newB === undefined) {
      ops.push({ type: "remove", index: i, oldBlock: oldB });
      changed++;
    } else if (canonicalize(oldB) !== canonicalize(newB)) {
      ops.push({ type: "modify", index: i, oldBlock: oldB, newBlock: newB });
      changed++;
    } else {
      ops.push({ type: "keep", index: i });
    }
  }

  return { ops, changedBlocks: changed };
}

// ---------------------------------------------------------------------------
// Combined diff
// ---------------------------------------------------------------------------

export function computeDiff(
  oldMd: string,
  newMd: string,
  oldJson: Record<string, unknown> | null,
  newJson: Record<string, unknown> | null,
): DiffResult {
  const diffMd = computeMarkdownDiff(oldMd, newMd);
  const { ops, changedBlocks } = computeBlockDiff(oldJson, newJson);
  return { diffMd, diffOpsJson: ops, changedBlocks };
}
