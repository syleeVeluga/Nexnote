# WekiFlow Chunking Plan

> Status: Draft proposal
> Last updated: 2026-04-21
> Scope: Design only, no implementation in this document

## 0. Phase 0 — Large-context-first pre-chunk rollout (shipped)

Before any chunk persistence or vector layer, the hardcoded `slice(0, N)` cutoffs inside `route-classifier`, `patch-generator` (update merge), and `triple-extractor` were replaced with provider-aware budgeted prompt assembly. No schema changes, no new worker, no embeddings — this tranche only lets the existing pipeline actually use the large-context windows of the configured models.

Delivered building blocks that the later chunking stages will reuse:

- `MODEL_CONTEXT_BUDGETS` + `MODE_OUTPUT_RESERVE` + `getModelContextBudget()` in [packages/shared/src/constants/index.ts](packages/shared/src/constants/index.ts) — per-model input budget + safety margin, and per-mode output reserve matching each worker's `maxTokens`.
- `estimateTokens`, `sliceWithinTokenBudget` (structure-preserving, cuts on blank-line → sentence → char boundaries), and `allocateBudgets` (multi-slot weighted allocation with slack redistribution) in [packages/shared/src/lib/token-budget.ts](packages/shared/src/lib/token-budget.ts).
- Optional `AIRequest.budgetMeta` read-through field ([packages/shared/src/types/ai-gateway.ts](packages/shared/src/types/ai-gateway.ts)) so every worker records `inputTokenBudget`, `estimatedInputTokens`, `truncated`, `strategy`, and per-slot allocations on `model_runs.requestMetaJson`.

Where the old cutoffs used to live (allocation policy is **incoming-priority**, not fair-split — the ingestion payload is treated as the source of truth and given a large floor before any other slot):

- [route-classifier.ts](packages/worker/src/workers/route-classifier.ts) — candidate excerpts are no longer pre-sliced inside the worker; the DB query applies a `SUBSTRING` cap of 50k chars per candidate for bandwidth, and only the top 3 candidates by search rank are rendered in the prompt. `incoming` gets `minTokens: 80_000, weight: 10` and absorbs almost all slack; each prompted candidate gets `minTokens: 100, weight: 1` — enough to identify the page, not to rewrite it. Remaining matches from `findCandidatePages` stay DB-side for recall statistics.
- [patch-generator.ts](packages/worker/src/workers/patch-generator.ts) — update merge uses `incoming { minTokens: 100_000, weight: 1 }` and `existing { minTokens: 10_000, weight: 0 }`. Incoming is guaranteed up to 100k tokens and gets the entire remainder; existing only receives its floor plus any slack incoming can't use. `append` remains a plain concat.
- [triple-extractor.ts](packages/worker/src/workers/triple-extractor.ts) — the 6000-char cap is gone; the full `revision.contentMd` is sent up to the per-model budget. Output reserve tightened from 8k to 4k tokens (actual triple output rarely exceeds 2k), freeing ~4k more input tokens. `MODEL_RUNS` now logs truncation stats so the actual need for sub-page chunking can be measured instead of assumed.

Out of scope for Phase 0 and still owned by the remaining sections of this plan:

- Persisted `chunks` / `chunk_embeddings` tables, revision-scoped splitting, and retrieval-aware triple extraction.
- Any Claude adapter (only a `TODO(claude)` marker was left in [ai-gateway.ts](packages/worker/src/ai-gateway.ts)).
- Workspace-wide vector search, cross-page dedup, and conflict detection.

The signal that Phase 0 has done its job (and that the full chunking plan below needs to land) is `model_runs.requestMetaJson.budget.truncated = true` for a non-trivial fraction of large ingests — especially `triple_extraction`, where any truncation is a direct recall loss.

## 1. Background

WekiFlow aims to solve the long-term maintenance problem of knowledge systems whose content continuously changes. The operating model is:

1. External signals and human inputs flow into the system.
2. AI agents classify, merge, deduplicate, and extract structure.
3. Humans review or approve where needed.
4. Published knowledge remains traceable and trustworthy.

This creates a direct requirement for a chunking strategy.

Without chunking, long or weakly structured inputs create four problems:

1. AI classification becomes front-biased and overweights the beginning of the document.
2. Triple extraction misses facts that appear later in long documents.
3. Graph provenance becomes coarse because facts can only be tied to a page/revision, not a more precise source region.
4. Future vector indexing becomes expensive or inconsistent because there is no stable unit of retrieval.

WekiFlow already preserves full raw input and full page revisions. That is a strong starting point. The missing layer is a derived, revision-scoped chunk structure that can support AI processing, graph provenance, and future retrieval without replacing the canonical Markdown revision model.

## 2. Problem Statement

The current pipeline stores the full source and full page revision, but AI processing is effectively truncated to fixed prefixes at several stages. This means the system preserves source data, yet many downstream AI behaviors do not fully see it.

This becomes more serious because inputs are heterogeneous:

1. Markdown uploads and web imports can preserve useful structure.
2. PDF and Office formats often collapse into plain text after extraction.
3. OCR-like plain text may have weak or missing paragraph and heading boundaries.
4. Large pages may contain important facts far beyond the first several thousand characters.

Therefore, the chunking solution must satisfy both of these constraints:

1. It must work after extraction across multiple input formats.
2. It must preserve local and sectional context well enough for long-page AI processing.

## 3. Current State

At a high level, the repository already has the right backbone for a derived chunking layer:

1. `ingestions` stores raw payloads, content type, and normalized text.
2. `page_revisions` stores the full Markdown snapshot as the source of truth.
3. `triples` and `triple_mentions` already preserve page/revision-level provenance.
4. `pages.parentPageId` already provides a topic-level page hierarchy.
5. Search indexing currently materializes a page-level full-text vector from the full revision content.

The current weakness is not source preservation. The weakness is downstream AI context handling.

## 4. Design Goals

The chunking design should satisfy the following goals.

### 4.1 Primary goals

1. Preserve `page_revisions.contentMd` as the only canonical page content.
2. Add chunking as a derived artifact, not a replacement for pages or revisions.
3. Support graph extraction and provenance first.
4. Support long-document routing and later merge quality improvements.
5. Provide a stable seam for future vector embeddings.

### 4.2 Format goals

1. Work uniformly after extraction for Markdown, URL imports, PDF, Office formats, and plain text.
2. Preserve native structure when it exists.
3. Recover minimal structure heuristically when it does not exist.

### 4.3 Context goals

1. Avoid front-biased understanding of long documents.
2. Avoid chunk boundaries that destroy semantic continuity.
3. Preserve enough local context for triple extraction and downstream graph evidence.
4. Preserve enough sectional context for route classification and future AI edits.

## 5. Non-Goals for V1

This proposal does not aim to do the following in the first tranche:

1. Replace page hierarchy with chunk hierarchy.
2. Auto-create child pages from chunks.
3. Ship vector embeddings immediately.
4. Redesign the publish pipeline around chunks.
5. Make chunks first-class user-editable documents.

## 6. Core Design Decision

The recommended approach is:

**Keep full Markdown revisions as the source of truth, and create revision-scoped derived chunks as an indexing, AI-processing, and provenance layer.**

This means:

1. The system still stores the full original revision text in `page_revisions`.
2. Chunk rows are generated from a revision after that revision exists.
3. Chunks are versioned implicitly through their owning revision.
4. Rollback remains coherent because chunk lineage follows revision lineage.
5. Graph facts can later be tied to a specific chunk while still preserving page and revision provenance.

This is preferable to page-scoped chunks because page-scoped chunks would blur history, rollback, and provenance semantics.

## 7. Format Strategy

Chunking should happen **after extraction**, not at the raw binary input layer.

The pipeline already converges multiple formats into textual content. The chunk builder should therefore be format-aware at the normalization stage, then use a common structured splitter.

### 7.1 Markdown and web imports

These are the best-case inputs.

1. Native Markdown can be chunked with minimal preprocessing.
2. Web imports already pass through Readability and Turndown, so they typically arrive as structure-preserving Markdown.
3. Headings, lists, code fences, and tables can be used directly as chunk boundaries.

### 7.2 PDF

PDF extraction is usually good enough for text recovery, but structure may be weakened.

Expected behavior:

1. Paragraphs often survive.
2. Heading markers may be missing.
3. Tables may flatten.
4. Page breaks may be noisy.

Minimal strategy:

1. Infer headings from short standalone lines, capitalization patterns, numbering, or repeated page-level title patterns.
2. Remove obvious page-number or header/footer noise when detected reliably.
3. Fall back to paragraph or pseudo-section chunking where structure remains weak.

### 7.3 DOCX

DOCX extraction is often relatively structured, but not always perfectly.

Minimal strategy:

1. Trust line and paragraph boundaries more than for PDF.
2. Use heading-like lines, list blocks, and table-like regions as chunk cues.
3. Preserve local order and avoid over-aggressive normalization.

### 7.4 PPTX

PPTX usually loses explicit slide boundaries in raw text extraction.

Minimal strategy:

1. Infer slide boundaries when there are obvious title-style line resets or repeated bullet clusters.
2. If reliable slide separation cannot be recovered, group into pseudo-sections by bullet clusters and spacing.
3. Mark these chunks as weakly structured so downstream consumers know the context boundary is soft.

### 7.5 XLSX

Spreadsheet extraction is the weakest case structurally because rows and columns may flatten into plain text.

Minimal strategy:

1. Detect repeated delimiter or row-like patterns.
2. Preserve row groups as local units when possible.
3. Do not force a fake narrative hierarchy when the source is tabular.
4. Treat these chunks as evidence regions rather than prose sections.

### 7.6 Plain text and OCR-like text

This is another weak-structure case.

Minimal strategy:

1. Recover paragraph-like groups from blank lines, punctuation density, indentation, and line-length heuristics.
2. Detect list-like prefixes such as `-`, `*`, numbering, or repeated short lines.
3. Create pseudo-sections when headings are not present.
4. Mark chunk boundaries as soft unless there is strong structural evidence.

## 8. Recommended Chunk Model

The chunk model should be hierarchical, but only as a derived indexing structure.

### 8.1 Chunk levels

V1 should support three logical levels.

1. **Document digest**: a compact representation of the full revision used for routing and overview.
2. **Section chunks**: heading-based or pseudo-section-based containers.
3. **Leaf chunks**: bounded windows used for extraction, provenance, and later retrieval.

### 8.2 Why hierarchy matters

If the system only stores flat chunks, it loses the relationship between a local fact and its larger topic.

A section-aware hierarchy provides:

1. Better route classification because the document can be summarized by section.
2. Better graph provenance because a fact can be tied to both a local chunk and a section path.
3. Better future navigation because a top-level chunk can later be surfaced as a virtual section or promoted to a child page if needed.

## 9. Context Preservation Strategy

This is the most important part of the design.

Naive chunking is not enough.

If we simply split by heading or paragraph and add a little overlap, long-document semantics will still degrade. V1 should preserve context through a small but explicit context capsule.

### 9.1 Context capsule per chunk

Every chunk should carry:

1. `headingPath`: the current section breadcrumb if available.
2. `precedingContextDigest`: a short digest of the immediately previous chunk tail and its heading.
3. `absoluteStart` and `absoluteEnd`: offsets into the full revision text.
4. `boundaryStrength`: whether the chunk begins at a hard structural boundary or a soft inferred one.

### 9.2 Why this matters

This allows a chunk-processing worker to understand both:

1. what this chunk says locally, and
2. what section or context frame it belongs to.

This is better than relying on overlap alone.

### 9.3 Overlap policy

Overlap should be used sparingly and intentionally.

Recommended policy:

1. No mandatory overlap when a clean heading boundary exists.
2. Limited overlap when a single logical section must be subdivided.
3. Small overlap only for local continuity, not as the sole context mechanism.

### 9.4 Weakly structured documents

When headings are missing or unreliable:

1. Create pseudo-sections from paragraph clusters or row/list clusters.
2. Treat boundary strength as soft.
3. Preserve a stronger preceding-context digest because chunk identity is less obvious.
4. Build routing digests from multiple representative chunks, not just the lead chunk.

## 10. Recommended Chunk Sizing

The design needs two complementary sizing rules.

### 10.1 Semantic sizing target

For general chunk quality, target approximately:

1. 400-700 tokens per leaf chunk for durable reuse.
2. Section-aware grouping rather than blind size cuts.

### 10.2 Practical worker window limit

For current pipeline compatibility, use a practical ceiling of roughly:

1. 2k-5.5k characters per leaf processing window.
2. Small overlap only when a long logical section must be split.
3. Preceding context digest in addition to overlap.

This gives a workable compromise:

1. Small enough for reliable AI processing.
2. Large enough to preserve local semantic cohesion.
3. Stable enough for later vector embedding reuse.

## 11. Proposed Data Model

The exact schema can be refined later, but the shape should be close to this.

### 11.1 New derived chunk table

Recommended direction:

`revision_chunks`

Suggested fields:

1. `id`
2. `workspaceId`
3. `pageId`
4. `revisionId`
5. `chunkIndex`
6. `parentChunkId`
7. `chunkLevel`
8. `headingPath`
9. `boundaryStrength`
10. `absoluteStart`
11. `absoluteEnd`
12. `contentText`
13. `normalizedText`
14. `precedingContextDigest`
15. `tokenEstimate`
16. `checksum`
17. `status`
18. timestamps

### 11.2 Triple provenance extension

`triples` and possibly `triple_mentions` should later be extended with chunk linkage such as:

1. `sourceChunkId`
2. optional chunk-level metadata for provenance reads

Important rule:

Absolute offsets should remain offsets into the full revision content where possible. That keeps backward compatibility with existing provenance and UI logic.

### 11.3 Model run traceability

`model_runs` should eventually log chunk context as well, for example:

1. chunk index
2. total chunk count
3. digest or section metadata

This keeps AI processing auditable.

## 12. Pipeline Changes

The plan does not require replacing the existing ingestion or revision flow. It adds a derived step after revision creation.

### 12.1 Ingestion

No conceptual change to the ingestion contract:

1. Store raw payload.
2. Preserve content type.
3. Extract text.
4. Keep normalized text for downstream processing.

### 12.2 Chunk indexing worker

Add a dedicated worker that:

1. reads the full revision content,
2. applies format-aware normalization if needed,
3. builds the chunk hierarchy,
4. stores or replaces derived chunk rows idempotently,
5. becomes the fan-out point for chunk-aware extraction.

This worker should run after auto-create, update, or append revision creation.

### 12.3 Route classification

Current route classification is front-biased. The improved approach should use a document digest derived from chunks.

That digest should include:

1. lead chunk,
2. heading map if available,
3. representative early, middle, and late chunks,
4. keyword union across multiple chunks,
5. pseudo-section summaries for weakly structured formats.

### 12.4 Triple extraction

Current triple extraction should be replaced with chunk iteration.

Each extraction call should see:

1. the chunk body,
2. heading path,
3. short preceding-context digest.

Then the system should:

1. extract triples per chunk,
2. deduplicate within the revision,
3. preserve page and revision provenance,
4. add chunk provenance for more precise graph evidence.

### 12.5 Patch generation

Patch generation does not need to change in V1, but the chunk model should prepare for a future improvement where the model receives relevant merge windows instead of only fixed prefixes.

### 12.6 Search indexing

V1 should keep page-level search indexing unchanged.

That means:

1. keep the existing `pages.search_vector` behavior,
2. do not weaken current page-level search,
3. add chunk-level retrieval later as a separate capability.

## 13. Graph and Page-Hierarchy Relationship

Chunks should not replace the existing page hierarchy.

Instead:

1. `pages.parentPageId` remains the user-managed topic/document hierarchy,
2. chunk hierarchy remains internal and revision-scoped,
3. graph provenance can later show both topic-level and chunk-level lineage.

This supports the product goal well:

1. people can keep using page hierarchy as a semantic knowledge structure,
2. AI can work at chunk granularity internally,
3. later, a top-level chunk may be promoted into a real child page only when product needs justify it.

## 14. Vector-Ready Design

Vector embeddings are not in scope for the first implementation, but the chunk design should explicitly prepare for them.

To do that, chunks should be:

1. stable enough to reuse across re-indexing,
2. revision-scoped for provenance correctness,
3. checksummed so unchanged chunks can be skipped later,
4. rich enough in metadata to support retrieval context.

This avoids a second chunk redesign when vector indexing is introduced.

## 15. Recommended Implementation Phases

### Phase 1. Data model and contracts

1. Add revision-scoped chunk schema.
2. Add shared contracts for chunk metadata.
3. Extend provenance surfaces to allow chunk identity.

### Phase 2. Format-aware chunk builder

1. Add lightweight normalization for weakly structured extracted text.
2. Add structured splitting logic.
3. Emit document digest, section chunks, and leaf chunks.
4. Preserve offsets, heading path, and preceding-context digest.

### Phase 3. Chunk indexing worker

1. Generate chunks after revision creation.
2. Store or replace chunk rows idempotently.
3. Make this the fan-out point for chunk-aware downstream tasks.

### Phase 4. Chunk-aware triple extraction and graph provenance

1. Iterate chunks instead of truncating the first prefix of the revision.
2. Consume context capsule per chunk.
3. Deduplicate within revision.
4. Preserve precise chunk provenance.

### Phase 5. Chunk-aware routing

1. Replace front-biased route prompts with document digests.
2. Support both structured and weakly structured inputs.
3. Ensure long documents are represented beyond their opening section.

### Phase 6. Merge-window improvements

1. Keep the full-document revision model.
2. Later replace prefix-based merge context with chunk-derived merge windows.

### Phase 7. Vector indexing and optional virtual section navigation

1. Add chunk-level embeddings later.
2. Optionally surface top-level chunks as virtual section routes.
3. Keep real child-page promotion out of the first tranche.

## 16. Verification and Evaluation

Any implementation should be considered incomplete unless it is verified against multiple input types and long-document cases.

### 16.1 Unit tests

The chunk builder should be tested against:

1. long Markdown with nested headings,
2. code fences, tables, and list-heavy sections,
3. web-imported Markdown,
4. PDF-like extracted plain text,
5. Office-derived plain text,
6. OCR-like weakly structured text,
7. mixed Korean and English content,
8. stable absolute offsets and heading-path metadata.

### 16.2 Worker tests

1. chunk indexing should be idempotent,
2. unchanged revisions should produce stable chunk ordering and checksums,
3. chunk-aware triple extraction should recover facts beyond the current first-window limit,
4. page-level APIs should remain backward-compatible when chunk metadata is missing.

### 16.3 Manual validation set

At minimum, validate:

1. one long Markdown spec,
2. one scraped web article,
3. one OCR-like plain text sample,
4. one PDF or PPTX/XLSX sample.

Check:

1. chunk hierarchy quality,
2. section or pseudo-section coherence,
3. triple evidence quality,
4. long-document late-section recall,
5. graph provenance readability.

## 17. Risks and Open Questions

### 17.1 Format normalization risk

Weakly structured formats can only be normalized heuristically. V1 should therefore avoid pretending that all boundaries are equally trustworthy.

Recommendation:

1. explicitly mark boundary strength,
2. keep normalization conservative,
3. prefer traceability over overfitted structure inference.

### 17.2 Triple deduplication risk

The same fact may appear in multiple chunks. Deduplication must happen at the revision level, not only the chunk level.

### 17.3 Publish/UI complexity risk

If chunks are surfaced too early as full navigation entities, publish and revision semantics get more complex quickly.

Recommendation:

1. keep chunks internal first,
2. expose them later as virtual sections if needed,
3. avoid auto-generating real child pages in V1.

### 17.4 Merge behavior risk

Even after chunking exists, merge quality will not improve automatically until patch generation is changed to consume chunk-aware windows.

This should be acknowledged as a later tranche rather than assumed solved by chunking alone.

## 18. Final Recommendation

The recommended direction is to proceed with a **revision-scoped derived chunk layer** that is:

1. format-agnostic after extraction,
2. structure-preserving when possible,
3. conservative and heuristic when structure is weak,
4. explicit about context through heading paths and preceding-context digests,
5. aligned first with graph provenance and long-document AI processing,
6. ready for later vector embeddings.

In short:

**Do not replace pages with chunks. Keep the original revision whole, derive chunks from it, and use those derived chunks as the internal unit for AI understanding, graph evidence, and future retrieval.**

This gives WekiFlow the smallest design that can credibly support long heterogeneous documents while preserving the product's existing strengths: canonical Markdown revisions, strong provenance, and a graph-first knowledge layer.