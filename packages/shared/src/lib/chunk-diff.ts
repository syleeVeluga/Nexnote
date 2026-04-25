/**
 * Compares two revisions' leaf-chunk lists by content hash and splits the
 * new revision's leaves into "changed" vs "unchanged" relative to a
 * reference prior revision. Content-hashing gives us byte-exact reuse:
 * identical leaves can keep their triples across a save without another
 * LLM call.
 *
 * Pure + deterministic. The triple-extractor worker uses this to decide
 * whether to send the full document to the model or only the delta.
 */

export interface ChunkPartitionResult<Prev, Next> {
  /** New leaves that appear verbatim in a prior revision, paired with that prior chunk. */
  unchanged: Array<{ next: Next; prev: Prev }>;
  /** New leaves whose content is new or edited since the prior revision. */
  changed: Next[];
}

export function partitionLeafChunksByHash<
  Prev extends { contentHash: string },
  Next extends { contentHash: string },
>(prev: Prev[], next: Next[]): ChunkPartitionResult<Prev, Next> {
  const prevByHash = new Map<string, Prev>();
  for (const chunk of prev) {
    if (!prevByHash.has(chunk.contentHash)) {
      prevByHash.set(chunk.contentHash, chunk);
    }
  }

  const unchanged: Array<{ next: Next; prev: Prev }> = [];
  const changed: Next[] = [];
  for (const chunk of next) {
    const match = prevByHash.get(chunk.contentHash);
    if (match) {
      unchanged.push({ next: chunk, prev: match });
    } else {
      changed.push(chunk);
    }
  }

  return { unchanged, changed };
}

export interface FocusedInputEntry {
  /** Chunk's position in the original `contentMd`. */
  originalStart: number;
  originalEnd: number;
  /** Chunk's position in the concatenated LLM input. */
  inputStart: number;
  inputEnd: number;
  headingPath: string[];
}

export interface FocusedInputResult {
  /** Concatenated text to send to the model. */
  inputText: string;
  /** Per-chunk map used to translate LLM-returned spans back to `contentMd` coords. */
  index: FocusedInputEntry[];
}

const CHUNK_SEPARATOR = "\n\n";

/**
 * Concatenates chunk contents for the LLM and tracks the offset of each
 * chunk in both the original `contentMd` and the concatenated input, so the
 * caller can translate span offsets returned by the model.
 *
 * Chunks are inserted in the order given separated by `CHUNK_SEPARATOR`.
 * `headingPath` is carried in the index for callers that want to surface
 * structural context, but is NOT prepended to the input string today —
 * `inputStart`/`inputEnd` track only the chunk's content. If a heading-path
 * prefix is ever added, the offset accounting in this function and in
 * `remapFocusedSpan` must move in lockstep.
 */
export function buildFocusedInput(
  chunks: Array<{
    contentMd: string;
    charStart: number;
    charEnd: number;
    headingPath: string[];
  }>,
): FocusedInputResult {
  const index: FocusedInputEntry[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      parts.push(CHUNK_SEPARATOR);
      cursor += CHUNK_SEPARATOR.length;
    }
    const chunk = chunks[i];
    const contentStart = cursor;
    parts.push(chunk.contentMd);
    cursor += chunk.contentMd.length;

    index.push({
      originalStart: chunk.charStart,
      originalEnd: chunk.charEnd,
      inputStart: contentStart,
      inputEnd: cursor,
      headingPath: chunk.headingPath,
    });
  }

  return { inputText: parts.join(""), index };
}

/**
 * Translates a span expressed in "focused input" coordinates back to the
 * original `contentMd`. Returns null when the span straddles a chunk
 * boundary (which means the model made an impossible claim — the caller
 * should drop it rather than corrupt a mention).
 */
export function remapFocusedSpan(
  index: FocusedInputEntry[],
  span: { start: number; end: number },
): { start: number; end: number } | null {
  if (span.start < 0 || span.end < span.start) return null;
  for (const entry of index) {
    if (span.start >= entry.inputStart && span.end <= entry.inputEnd) {
      const offset = entry.originalStart - entry.inputStart;
      return { start: span.start + offset, end: span.end + offset };
    }
  }
  return null;
}
