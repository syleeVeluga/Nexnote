// Post-extraction entity reconciliation.
//
// The triple-extractor never sees existing-entity hints in its prompt
// (anchoring bias is a hard veto). After the LLM returns triples, this module
// looks at the page's destination — its parent folder closure or parent-page
// subtree — gathers the entities already mentioned there, and decides whether
// each freshly extracted entity name should be REUSED against an existing
// entity (and an alias logged) or CREATED fresh.
//
// All operations are additive: `entities` and `triples` rows are never updated
// or deleted from this path. Reconciliation only:
//   1. redirects the FK choice for triples about to be inserted, and
//   2. inserts an `entity_aliases` row recording the match.
//
// Match order (short-circuit on first hit):
//   1. exact normalizedKey inside the candidate set
//   2. existing alias hit (entity_aliases.normalized_alias) on a candidate
//   3. honorific stop-list strip → exact normalizedKey
//   4. pg_trgm similarity ≥ SIM_THRESHOLD with a length-difference guard

import { and, eq, inArray, sql } from "drizzle-orm";
import { entityAliases } from "@wekiflow/db";
import { normalizeKey } from "@wekiflow/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DestinationDescriptor =
  | { folderId: string; parentPageId?: never }
  | { folderId?: never; parentPageId: string }
  | { folderId?: never; parentPageId?: never };

export interface EntityCandidate {
  id: string;
  normalizedKey: string;
  canonicalName: string;
  mentionCount: number;
}

export const MATCH_METHODS = {
  EXACT: "exact",
  HONORIFIC: "honorific",
  TRIGRAM: "trigram",
} as const;
export type MatchMethod = (typeof MATCH_METHODS)[keyof typeof MATCH_METHODS];

export type ReconcileResult =
  | {
      action: "reuse";
      entityId: string;
      matchMethod: MatchMethod;
      similarity: number;
      matchedCanonicalName: string;
    }
  | { action: "create" };

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const VOCAB_LIMIT = 500;
const SIM_THRESHOLD = 0.55;
const LENGTH_DIFF_GUARD = 0.5; // reject if |a-b|/max > 0.5

// Korean + English business honorifics. Tokens are matched against the
// normalized form (lowercased, non-alphanumeric runs collapsed to underscores)
// so spelling variants like "(주)" (already collapsed to "주") and "주식회사"
// both reduce to the company-name core. Exact-equality after stripping these
// is treated as a confident "same entity" signal.
const HONORIFIC_TOKENS = [
  "주식회사",
  "유한회사",
  "재단법인",
  "사단법인",
  "주",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "llc",
  "co",
  "company",
  "gmbh",
  "ag",
  "sa",
];

// ---------------------------------------------------------------------------
// Destination vocabulary
// ---------------------------------------------------------------------------

/**
 * Collect the top-K active-triple entities mentioned in pages that share the
 * destination. The destination is one of:
 *   - { folderId }: the folder + every nested folder, then every page that
 *     hangs under any folder in that closure.
 *   - { parentPageId }: the page + every descendant page (recursive on
 *     pages.parent_page_id).
 *   - {} (root): no context — empty array, callers should skip reconciliation.
 *
 * The vocabulary is bounded at VOCAB_LIMIT; reconciliation is intentionally
 * scoped — workspace-wide matching would re-introduce cross-context false
 * merges (e.g. a "벨루가" whale page and the "벨루가" company).
 */
export async function buildDestinationVocabulary(
  tx: any,
  workspaceId: string,
  destination: DestinationDescriptor,
): Promise<EntityCandidate[]> {
  if (destination.folderId) {
    const result = await tx.execute(sql`
      WITH RECURSIVE folder_closure AS (
        SELECT id FROM folders WHERE id = ${destination.folderId}
        UNION ALL
        SELECT f.id FROM folders f
        JOIN folder_closure fc ON f.parent_folder_id = fc.id
      ),
      context_pages AS (
        SELECT id FROM pages
        WHERE workspace_id = ${workspaceId}
          AND deleted_at IS NULL
          AND parent_folder_id IN (SELECT id FROM folder_closure)
      )
      SELECT e.id::text AS id,
             e.normalized_key AS "normalizedKey",
             e.canonical_name AS "canonicalName",
             COUNT(*)::int AS "mentionCount"
        FROM entities e
        JOIN triples t
          ON (t.subject_entity_id = e.id OR t.object_entity_id = e.id)
       WHERE e.workspace_id = ${workspaceId}
         AND t.status = 'active'
         AND t.source_page_id IN (SELECT id FROM context_pages)
       GROUP BY e.id
       ORDER BY COUNT(*) DESC, e.created_at ASC
       LIMIT ${VOCAB_LIMIT}
    `);
    return result as unknown as EntityCandidate[];
  }

  if (destination.parentPageId) {
    const result = await tx.execute(sql`
      WITH RECURSIVE page_subtree AS (
        SELECT id FROM pages WHERE id = ${destination.parentPageId}
        UNION ALL
        SELECT p.id FROM pages p
        JOIN page_subtree ps ON p.parent_page_id = ps.id
      )
      SELECT e.id::text AS id,
             e.normalized_key AS "normalizedKey",
             e.canonical_name AS "canonicalName",
             COUNT(*)::int AS "mentionCount"
        FROM entities e
        JOIN triples t
          ON (t.subject_entity_id = e.id OR t.object_entity_id = e.id)
       WHERE e.workspace_id = ${workspaceId}
         AND t.status = 'active'
         AND t.source_page_id IN (SELECT id FROM page_subtree)
       GROUP BY e.id
       ORDER BY COUNT(*) DESC, e.created_at ASC
       LIMIT ${VOCAB_LIMIT}
    `);
    return result as unknown as EntityCandidate[];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Honorific strip helper
// ---------------------------------------------------------------------------

const honorificSet = new Set(HONORIFIC_TOKENS.map((t) => t.toLowerCase()));

/**
 * Drop any honorific tokens (delimited by underscores in the normalized key)
 * from the head and tail of the string. Returns null if the result is empty
 * or identical to the input (no honorific found), so callers can short-circuit.
 */
export function stripHonorificTokens(normalizedKey: string): string | null {
  if (!normalizedKey) return null;
  const parts = normalizedKey.split("_").filter(Boolean);
  if (parts.length <= 1) return null;
  let start = 0;
  let end = parts.length;
  while (start < end && honorificSet.has(parts[start])) start++;
  while (end > start && honorificSet.has(parts[end - 1])) end--;
  if (start === 0 && end === parts.length) return null;
  if (start >= end) return null;
  const stripped = parts.slice(start, end).join("_");
  return stripped === normalizedKey ? null : stripped;
}

// ---------------------------------------------------------------------------
// Match logic for a single extracted entity
// ---------------------------------------------------------------------------

/** Vocabulary candidate with its honorific-stripped key cached once at build time. */
interface CandidateView extends EntityCandidate {
  /** stripped form, or null when the canonical key has no honorific tokens. */
  strippedKey: string | null;
}

interface MatchArgs {
  /** Already-normalized key of the freshly extracted entity name. */
  normalizedKey: string;
  contextEntities: CandidateView[];
  /** Map from candidate.id → candidate, for O(1) lookup. */
  contextById: Map<string, CandidateView>;
  /** All known aliases scoped to the candidate set, keyed by normalized_alias. */
  contextAliasIndex: Map<string, string>;
}

/**
 * Decide what to do with a single extracted entity using only in-memory state.
 * The trigram fallback is async and lives in {@link findTrigramMatchesBatch}
 * because pg_trgm has no faithful JS equivalent.
 */
export function matchAgainstVocabulary(
  args: MatchArgs,
): { result: ReconcileResult } | null {
  const { normalizedKey, contextEntities, contextAliasIndex } = args;
  if (!normalizedKey) return null;

  const exact = contextEntities.find((c) => c.normalizedKey === normalizedKey);
  if (exact) {
    return {
      result: {
        action: "reuse",
        entityId: exact.id,
        matchMethod: MATCH_METHODS.EXACT,
        similarity: 1,
        matchedCanonicalName: exact.canonicalName,
      },
    };
  }

  const aliasEntityId = contextAliasIndex.get(normalizedKey);
  if (aliasEntityId) {
    const candidate = args.contextById.get(aliasEntityId);
    if (candidate) {
      return {
        result: {
          action: "reuse",
          entityId: candidate.id,
          matchMethod: MATCH_METHODS.EXACT,
          similarity: 1,
          matchedCanonicalName: candidate.canonicalName,
        },
      };
    }
  }

  const stripped = stripHonorificTokens(normalizedKey);
  if (stripped) {
    const honorificHit = contextEntities.find(
      (c) =>
        c.normalizedKey === stripped ||
        (c.strippedKey !== null && c.strippedKey === stripped),
    );
    if (honorificHit) {
      return {
        result: {
          action: "reuse",
          entityId: honorificHit.id,
          matchMethod: MATCH_METHODS.HONORIFIC,
          similarity: 1,
          matchedCanonicalName: honorificHit.canonicalName,
        },
      };
    }
  }

  return null;
}

/**
 * Length guard rejects pairs whose string lengths differ by more than half of
 * the longer one. This kills "apple" ≈ "applemarketingcorp" while leaving
 * "벨루가" ≈ "주식회사_벨루가" alone (rare since honorific strip catches the
 * latter first, but the guard still applies on the trigram-only path).
 */
function passesLengthGuard(a: string, b: string): boolean {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return false;
  return Math.abs(a.length - b.length) / longer <= LENGTH_DIFF_GUARD;
}

/**
 * Batched trigram probe — for every probe key, fetch the top-3 candidates above
 * SIM_THRESHOLD scoped to the destination vocabulary in a single query.
 * Replaces an N+1 loop with one round-trip; per-probe ranking and the
 * length-difference guard are applied in JS.
 */
export async function findTrigramMatchesBatch(
  tx: any,
  workspaceId: string,
  probes: string[],
  candidateIds: string[],
): Promise<
  Map<
    string,
    {
      id: string;
      normalizedKey: string;
      canonicalName: string;
      similarity: number;
    }
  >
> {
  const out = new Map<
    string,
    {
      id: string;
      normalizedKey: string;
      canonicalName: string;
      similarity: number;
    }
  >();
  const filteredProbes = probes.filter((p) => p.length >= 2);
  if (filteredProbes.length === 0 || candidateIds.length === 0) return out;

  // postgres-js sends `${array}` as a row literal, so the original
  // `unnest(${arr}::text[])` / `id = ANY(${arr}::uuid[])` patterns produce
  // "cannot cast type record to ...". Build the array constructors with
  // sql.join so each value goes as its own parameter.
  const probeList = sql.join(
    filteredProbes.map((p) => sql`${p}`),
    sql`, `,
  );
  const candidateList = sql.join(
    candidateIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const rows = (await tx.execute(sql`
    WITH probes(probe) AS (SELECT unnest(ARRAY[${probeList}]::text[])),
         candidate_set AS (
           SELECT id, normalized_key, canonical_name
             FROM entities
            WHERE workspace_id = ${workspaceId}
              AND id IN (${candidateList})
         ),
         scored AS (
           SELECT p.probe,
                  c.id::text AS id,
                  c.normalized_key,
                  c.canonical_name,
                  similarity(c.normalized_key, p.probe) AS sim,
                  ROW_NUMBER() OVER (
                    PARTITION BY p.probe
                    ORDER BY similarity(c.normalized_key, p.probe) DESC
                  ) AS rn
             FROM probes p
             JOIN candidate_set c
               ON c.normalized_key % p.probe
         )
    SELECT probe,
           id,
           normalized_key AS "normalizedKey",
           canonical_name AS "canonicalName",
           sim AS "similarity"
      FROM scored
     WHERE rn <= 5
       AND sim >= ${SIM_THRESHOLD}
     ORDER BY probe, sim DESC, rn
  `)) as unknown as Array<{
    probe: string;
    id: string;
    normalizedKey: string;
    canonicalName: string;
    similarity: number;
  }>;

  for (const row of rows) {
    if (out.has(row.probe)) continue;
    if (!passesLengthGuard(row.probe, row.normalizedKey)) continue;
    out.set(row.probe, {
      id: row.id,
      normalizedKey: row.normalizedKey,
      canonicalName: row.canonicalName,
      similarity: row.similarity,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public bulk API used by the triple-extractor
// ---------------------------------------------------------------------------

interface ReconcileBulkArgs {
  /** Map of normalizedKey → display name as collected by the worker. */
  entityNames: Map<string, { name: string; type: string }>;
  destination: DestinationDescriptor;
  modelRunId: string | null;
  sourcePageId: string;
}

export interface ReconcileBulkResult {
  /** normalizedKey → existing entity_id, ready to merge into entityIdMap. */
  reuseMap: Map<string, string>;
  /** Per-key telemetry — used to insert entity_aliases rows after entity insert. */
  aliasInserts: Array<{
    entityId: string;
    alias: string;
    normalizedAlias: string;
    createdByExtractionId: string | null;
    sourcePageId: string;
    similarityScore: number;
    matchMethod: MatchMethod;
  }>;
  /** Vocabulary size for telemetry/logging. */
  vocabularySize: number;
}

/**
 * Run the full reconciliation pipeline over a batch of extracted entity
 * names. Idempotent: alias rows are written with a UNIQUE on
 * (entity_id, normalized_alias) and `ON CONFLICT DO NOTHING`.
 *
 * No DB writes happen here — callers append `aliasInserts` to their own
 * insert batch after the entity upsert step.
 */
export async function reconcileEntitiesBulk(
  tx: any,
  workspaceId: string,
  args: ReconcileBulkArgs,
): Promise<ReconcileBulkResult> {
  const reuseMap = new Map<string, string>();
  const aliasInserts: ReconcileBulkResult["aliasInserts"] = [];

  const rawVocab = await buildDestinationVocabulary(
    tx,
    workspaceId,
    args.destination,
  );
  if (rawVocab.length === 0) {
    return { reuseMap, aliasInserts, vocabularySize: 0 };
  }

  // Cache the honorific-stripped form of every candidate so the inner match
  // loop runs in O(vocab) per extracted entity instead of O(vocab) split-and-
  // strip each time.
  const vocabulary: CandidateView[] = rawVocab.map((c) => ({
    ...c,
    strippedKey: stripHonorificTokens(c.normalizedKey),
  }));
  const contextById = new Map(vocabulary.map((c) => [c.id, c]));
  const candidateIds = vocabulary.map((c) => c.id);

  const aliasRows = await tx
    .select({
      entityId: entityAliases.entityId,
      normalizedAlias: entityAliases.normalizedAlias,
    })
    .from(entityAliases)
    .where(
      and(
        inArray(entityAliases.entityId, candidateIds),
        eq(entityAliases.status, "active"),
      ),
    );
  const contextAliasIndex = new Map<string, string>();
  for (const r of aliasRows) contextAliasIndex.set(r.normalizedAlias, r.entityId);

  // Pass 1 — synchronous matchers (exact / alias / honorific). Names that
  // miss are queued for the batched trigram probe.
  const trigramQueue: string[] = [];
  const syncResults = new Map<string, ReconcileResult>();
  for (const normalizedKey of args.entityNames.keys()) {
    const sync = matchAgainstVocabulary({
      normalizedKey,
      contextEntities: vocabulary,
      contextById,
      contextAliasIndex,
    });
    if (sync) {
      syncResults.set(normalizedKey, sync.result);
    } else {
      trigramQueue.push(normalizedKey);
    }
  }

  // Pass 2 — single batched trigram round-trip for everything that didn't hit
  // a sync matcher. Replaces an N-per-page query loop.
  const trigramHits = await findTrigramMatchesBatch(
    tx,
    workspaceId,
    trigramQueue,
    candidateIds,
  );

  for (const [normalizedKey, val] of args.entityNames.entries()) {
    let result: ReconcileResult | undefined = syncResults.get(normalizedKey);
    if (!result) {
      const trigram = trigramHits.get(normalizedKey);
      if (trigram) {
        result = {
          action: "reuse",
          entityId: trigram.id,
          matchMethod: MATCH_METHODS.TRIGRAM,
          similarity: trigram.similarity,
          matchedCanonicalName: trigram.canonicalName,
        };
      }
    }
    if (!result || result.action === "create") continue;

    reuseMap.set(normalizedKey, result.entityId);
    aliasInserts.push({
      entityId: result.entityId,
      alias: val.name,
      normalizedAlias: normalizedKey,
      createdByExtractionId: args.modelRunId,
      sourcePageId: args.sourcePageId,
      similarityScore: result.similarity,
      matchMethod: result.matchMethod,
    });
  }

  return { reuseMap, aliasInserts, vocabularySize: vocabulary.length };
}

/**
 * Build a destination descriptor from a row that carries `parent_*_id` fields.
 * Folder takes precedence over page (mirrors the DB CHECK constraint that
 * forbids both). Returns the empty/root marker when neither is set.
 */
export function buildDestinationFromPage(row: {
  parentFolderId?: string | null;
  parentPageId?: string | null;
}): DestinationDescriptor {
  if (row.parentFolderId) return { folderId: row.parentFolderId };
  if (row.parentPageId) return { parentPageId: row.parentPageId };
  return {};
}

/**
 * Insert the alias rows produced by reconciliation. Safe to call repeatedly:
 * the UNIQUE (entity_id, normalized_alias) index makes this idempotent.
 */
export async function persistAliasInserts(
  tx: any,
  rows: ReconcileBulkResult["aliasInserts"],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(entityAliases)
    .values(rows)
    .onConflictDoNothing({
      target: [entityAliases.entityId, entityAliases.normalizedAlias],
    });
}

// Re-export normalizeKey so the integration in triple-extractor.ts can rely
// on a single import path during the rewrite.
export { normalizeKey };
