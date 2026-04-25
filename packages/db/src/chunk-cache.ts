import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { revisionChunks } from "./schema/chunks.js";
import { buildRevisionChunks, type BuiltRevisionChunk } from "./chunk-builder.js";

export type CachedRevisionChunk = {
  id: string;
  chunkIndex: number;
  chunkKind: "document" | "section" | "leaf";
  parentChunkId: string | null;
  headingPath: string[];
  contentMd: string;
  digestText: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  structureConfidence: number;
};

async function selectChunks(
  db: Database,
  revisionId: string,
): Promise<CachedRevisionChunk[]> {
  const rows = await db
    .select({
      id: revisionChunks.id,
      chunkIndex: revisionChunks.chunkIndex,
      chunkKind: revisionChunks.chunkKind,
      parentChunkId: revisionChunks.parentChunkId,
      headingPath: revisionChunks.headingPath,
      contentMd: revisionChunks.contentMd,
      digestText: revisionChunks.digestText,
      contentHash: revisionChunks.contentHash,
      charStart: revisionChunks.charStart,
      charEnd: revisionChunks.charEnd,
      tokenEstimate: revisionChunks.tokenEstimate,
      structureConfidence: revisionChunks.structureConfidence,
    })
    .from(revisionChunks)
    .where(eq(revisionChunks.revisionId, revisionId))
    .orderBy(revisionChunks.chunkIndex);

  return rows.map((row) => ({
    id: row.id,
    chunkIndex: row.chunkIndex,
    chunkKind: row.chunkKind as "document" | "section" | "leaf",
    parentChunkId: row.parentChunkId,
    headingPath: Array.isArray(row.headingPath)
      ? (row.headingPath as string[])
      : [],
    contentMd: row.contentMd,
    digestText: row.digestText,
    contentHash: row.contentHash,
    charStart: row.charStart,
    charEnd: row.charEnd,
    tokenEstimate: row.tokenEstimate,
    structureConfidence: row.structureConfidence,
  }));
}

async function insertBuiltChunks(
  db: Database,
  params: {
    workspaceId: string;
    pageId: string;
    revisionId: string;
    built: BuiltRevisionChunk[];
  },
): Promise<void> {
  if (params.built.length === 0) return;

  // Pre-allocate UUIDs client-side so we can resolve `parentChunkId` without
  // round-tripping. This collapses what was an N+1 INSERT loop into a single
  // batched INSERT — large documents (30+ leaves + sections) used to take
  // 30+ round-trips on first touch.
  const idByIndex = new Map<number, string>();
  for (const chunk of params.built) {
    idByIndex.set(chunk.chunkIndex, randomUUID());
  }

  const rows = params.built.map((chunk) => ({
    id: idByIndex.get(chunk.chunkIndex)!,
    workspaceId: params.workspaceId,
    pageId: params.pageId,
    revisionId: params.revisionId,
    parentChunkId:
      chunk.parentChunkIndex == null
        ? null
        : (idByIndex.get(chunk.parentChunkIndex) ?? null),
    chunkIndex: chunk.chunkIndex,
    chunkKind: chunk.chunkKind,
    headingPath: chunk.headingPath,
    contentMd: chunk.contentMd,
    digestText: chunk.digestText,
    contentHash: chunk.contentHash,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenEstimate: chunk.tokenEstimate,
    structureConfidence: chunk.structureConfidence,
  }));

  await db.insert(revisionChunks).values(rows).onConflictDoNothing();
}

/**
 * Returns the persisted chunks for a revision, building and inserting them
 * on the first call for that revision. Subsequent calls short-circuit to a
 * single indexed SELECT, so repeat workers (triple-extractor, synthesis-
 * generator, future embedders) don't re-parse the same markdown.
 *
 * Concurrent callers race via the `(revision_id, chunk_index)` unique index:
 * `onConflictDoNothing` swallows duplicates, then the final SELECT returns
 * whichever writer's rows landed.
 */
export async function getOrBuildRevisionChunks(
  db: Database,
  params: {
    workspaceId: string;
    pageId: string;
    revisionId: string;
    contentMd: string;
  },
): Promise<CachedRevisionChunk[]> {
  const existing = await selectChunks(db, params.revisionId);
  if (existing.length > 0) return existing;

  const built = buildRevisionChunks(params.contentMd);
  await insertBuiltChunks(db, {
    workspaceId: params.workspaceId,
    pageId: params.pageId,
    revisionId: params.revisionId,
    built,
  });

  return selectChunks(db, params.revisionId);
}
