# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NexNote is an AI-assisted Markdown knowledge wiki. Its single north-star goal: **external signals (AI agents, scrapers, webhooks, humans) flow in continuously, and the wiki stays automatically up-to-date under human supervision.** AI does the drudgery of classifying, merging, deduplicating, and extracting structure; humans act as reviewers, correctors, and final approvers.

The canonical format is **Markdown + frontmatter**; the editor also stores a block-editor JSON snapshot alongside it.

### Core knowledge-refresh loop

Every feature should be evaluated against this loop. If it doesn't serve a stage, it's scope creep.

```
   ① Ingest              ② Classify           ③ Apply
   ─────────             ──────────           ────────
   External AI      →    route-classifier →   auto-apply  (confidence ≥ 0.85)
   Webhook / API         (create/update/        ↓
   Human paste           append/noop/         suggestion  (0.60–0.84)
                         needs_review)          ↓
                                              needs_review (< 0.60)
                                                ↓
                                     ┌──────────┴──────────┐
                                     ▼                     ▼
                              ④ Human review        ④' Patch-generator
                              (approve / edit /      writes new revision
                               reject / merge)       + triple extractor
                                     │                     │
                                     └──────────┬──────────┘
                                                ▼
                                       ⑤ Provenance & freshness
                                       (who / when / from which source;
                                        staleness signals, conflicts)
                                                ▼
                                       ⑥ Publish / expose
                                       (immutable snapshot for readers)
```

Key design invariants (derived from the loop):
- Markdown is the source of truth for every page
- Every change (human, AI, or system) creates a revision — no hard overwrites
- **Every revision must be traceable to its origin** (user action, specific ingestion, rollback, AI edit command)
- Triples (subject/predicate/object) are stored in PostgreSQL with provenance, not in a Graph DB
- Published docs are immutable snapshots separate from drafts
- External AI ingestion always persists the raw payload before processing
- **Auto-apply requires high confidence (≥ 0.85); the middle band (0.60–0.84) must land in a human-visible queue, never silently dropped**

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19.x, Vite 8.x, TypeScript 6.x |
| Editor | Tiptap 3.x (ProseMirror), Yjs + Hocuspocus for collab sync |
| Backend | Node.js 24.x LTS, Fastify 5.x |
| Validation | Zod 4.x |
| Database | PostgreSQL 18.x (pg_trgm, FTS, optional pgvector) |
| Queue | BullMQ 5.x + Redis |
| AI Providers | OpenAI (gpt-5.4 / gpt-5.4-pro), Google Gemini 3.1 Pro — behind a common adapter interface |
| Markdown pipeline | remark / rehype for publish rendering |
| Graph UI | react-force-graph (2D default, 3D toggle) |

## Architecture

```
[React/Vite SPA]
  ├─ Authoring UI (block editor + source mode)
  ├─ Public Docs UI (read-only, GitBook-style)
  ├─ Graph Panel (force-directed, depth 1-2)
  └─ AI Diff Viewer (block diff + line diff)
          │
          ▼
[Fastify API]
  ├─ Auth / Workspace / Page / Folder CRUD
  ├─ POST /api/v1/ingestions  (external AI intake, 202 async)
  ├─ POST /api/v1/pages/:id/ai-edit  (streaming patch)
  ├─ POST /api/v1/pages/:id/publish
  ├─ GET  /api/v1/pages/:id/graph?depth=1&limit=60
  ├─ GET  /api/v1/pages/:id/revisions
  └─ SSE/WS for AI streaming
          │
    ┌─────┴───────────────┐
    ▼                     ▼
[PostgreSQL]          [Redis + BullMQ]
  pages, revisions,       queue jobs:
  snapshots, triples,     route-classifier,
  entities, audit_logs    patch-generator,
                          triple-extractor,
                          publish-renderer,
                          search-index-updater
                               │
                               ▼
                         [AI Gateway]
                          ├─ OpenAI adapter
                          └─ Gemini adapter
```

## Data Model (core tables)

The full ERD is in `ERD 초안 — AI 기반 Markdown 지식 위키 서비스.md`. Key relationships:

- **pages** → container pointing to `current_revision_id`; actual content lives in **page_revisions**
- **page_revisions** → full markdown snapshot + JSON; linked to **revision_diffs** (line diff + block ops diff)
- **published_snapshots** → immutable snapshot from a specific revision; one `is_live` per page
- **ingestions** → raw external payload → **ingestion_decisions** (create/update/append/noop/needs_review)
- **entities** / **entity_aliases** / **triples** / **triple_mentions** → knowledge graph layer with provenance
- **model_runs** → tracks every AI call (provider, model, tokens, latency, prompt version)
- **audit_logs** → who did what, via which source

All PKs are UUID. Timestamps are `timestamptz`. Enums use CHECK + text (not PG enum) for flexibility.

## Monorepo Structure (planned)

```
packages/
  web/          — React/Vite frontend
  api/          — Fastify backend
  worker/       — BullMQ job processors
  shared/       — Zod schemas, types, constants shared across packages
  db/           — Drizzle/Kysely migrations and query helpers
```

## Build & Dev Commands

```bash
# Install dependencies (from root)
pnpm install

# Development
pnpm dev              # starts all services (web + api + worker)
pnpm --filter web dev
pnpm --filter api dev
pnpm --filter worker dev

# Build
pnpm build

# Lint & Format
pnpm lint
pnpm format

# Test
pnpm test                          # all packages
pnpm --filter api test             # single package
pnpm --filter api test -- --grep "ingestion"  # single test pattern

# Database
pnpm --filter db migrate           # run migrations
pnpm --filter db migrate:create    # create new migration
pnpm --filter db seed              # seed dev data
```

## Key Design Decisions

### Revision system
Every save creates a new `page_revision`. Rollback = creating a new revision from an older one's content. The `base_revision_id` field tracks lineage. `actor_type` is always one of `user`, `ai`, `system`.

### Ingestion routing pipeline
1. Raw payload saved to `ingestions` table immediately (202 response)
2. Text normalized
3. Candidate pages found via title match → FTS → trigram → entity overlap → optional vector similarity
4. LLM makes route decision (create/update/append/noop/needs_review) with confidence score
5. Confidence ≥ 0.85 → auto-apply to draft; 0.60–0.84 → suggestion queue; < 0.60 → needs_review

### Editor round-trip
Block editor (Tiptap/ProseMirror) and Markdown source mode must represent the same document. The canonical store is Markdown. Custom blocks that can't be expressed in standard Markdown use a documented directive syntax. **Round-trip regression tests are essential.**

### AI provider adapter
OpenAI and Gemini sit behind a common interface. Model strings must be pinned exactly (no `latest` aliases). All calls logged to `model_runs`.

### Triple constraints
`triples.object_entity_id` and `triples.object_literal` are mutually exclusive (exactly one must be non-null via CHECK constraint).

### Publish flow
Publish creates an immutable snapshot with rendered HTML, TOC JSON, internal link map, and search index entry. Public URL pattern: `/docs/:workspaceSlug/:pagePath`.

## AI Output Contracts

AI functions return structured JSON. The three core contracts are defined in the PRD (section 13):
- **Route Decision**: `{ action, targetPageId, confidence, reason, proposedTitle }`
- **Patch Proposal**: `{ targetPageId, baseRevisionId, editType, ops[], summary }`
- **Triple Extraction**: `{ triples[]: { subject, predicate, object, objectType, confidence, spans[] } }`

## Implementation Priority

1. Monorepo scaffold + shared types
2. Auth / workspace / page schema + CRUD
3. Editor + Markdown persistence + round-trip tests
4. Revisions + diff engine
5. Ingestion API + BullMQ queue
6. AI route decision + patch generation
7. Triple extraction + graph read API
8. Publish renderer + public docs
9. Observability + audit polish

## Current Implementation Status (snapshot: 2026-04-22, S4-2 shipped)

Evaluated against the **core knowledge-refresh loop**, not per-package. See [TASKS.md](TASKS.md) for the active backlog.

| Loop stage | Status | Evidence / gap |
|---|---|---|
| ① **Ingest** | ✅ DONE | `POST /workspaces/:id/ingestions` saves raw payload + enqueues route-classifier ([ingestions.ts](packages/api/src/routes/v1/ingestions.ts)). Idempotency key + API-token auth present. Hardening: per-user minute rate limit + per-workspace daily quota via Redis fixed-window [consumeRateLimit](packages/api/src/lib/rate-limit.ts) (429 with `Retry-After` + absolute-unix-timestamp `X-RateLimit-Reset`), configurable via `INGESTION_RATE_LIMIT_PER_MINUTE` / `INGESTION_QUOTA_PER_DAY`, fails open on Redis outage so a cache blip doesn't break ingest. Idempotent replays short-circuit before the limiter so retries don't consume budget. TTL refreshes on every increment and aligns with the window end (caps stale-key retention on the 24h daily-quota window). **JWT-only browser import paths** added via [/import](packages/web/src/pages/ImportPage.tsx) UI and [`POST /workspaces/:id/ingestions/{upload,url,text}`](packages/api/src/routes/v1/ingestions-import.ts): file upload (PDF/DOCX/PPTX/XLSX/MD via [officeparser extractor](packages/api/src/lib/extractors/office.ts)), URL scrape (Readability + turndown via [web extractor](packages/api/src/lib/extractors/web.ts), SSRF-guarded by [url-safety.ts](packages/api/src/lib/url-safety.ts)), and text paste — all flow into the same `enqueueIngestion()` helper → existing classify pipeline. Per-user minute rate limit (`IMPORT_RATE_LIMIT_PER_MINUTE`) plus the shared workspace daily quota. |
| ② **Classify** | ✅ DONE | [route-classifier.ts](packages/worker/src/workers/route-classifier.ts) (523L) does title + FTS + trigram + entity-overlap candidate search, LLM picks action + confidence. Writes `ingestion_decisions`. |
| ③ **Apply — auto (≥0.85)** | ✅ DONE | route-classifier creates page OR enqueues patch-generator → triple-extractor → search-index-updater. Chain verified. |
| ③ **Apply — suggest (0.60–0.84)** | ✅ DONE (backend) | Route-classifier now tags decisions `suggested` when `SUGGESTION_MIN ≤ confidence < AUTO_APPLY`. Still needs UI (S4-1) to surface them. |
| ③ **Apply — needs_review (<0.60)** | ✅ DONE (backend) | Route-classifier tags low-confidence decisions `needs_review`. Manual `POST /ingestions/:id/apply` now writes correct decision status. UI still missing (S4-1). |
| ④ **Human review UI** | 🟡 PARTIAL | [/review](packages/web/src/pages/ReviewQueuePage.tsx) landed with tabs (suggested / needs review / failed / recent), j/k/a/r shortcuts, list + detail panes, proposed-diff render, and sidebar pending-count badge. Backed by `/workspaces/:id/decisions` endpoints (approve / reject / PATCH) with shared [apply-decision helper](packages/api/src/lib/apply-decision.ts) and `audit_logs` trail. S4-2 drill-down shipped 2026-04-22: new [/ingestions/:id](packages/web/src/pages/IngestionDetailPage.tsx) route shows raw payload, normalized text, archived-original download, and per-decision panels with the **candidate pages the classifier considered** (title / FTS / trigram / entity-overlap chips + chosen-target indicator + cross-link to the page) plus inline proposed-diff + approve/reject. Route-classifier now persists its candidate snapshot into `ingestion_decisions.rationaleJson.candidates`; ReviewQueuePage detail pane links out to the full drill-down. Remaining gap: S4-2 follow-ups (re-run classification with a different LLM, in-UI target-page override — PATCH API exists) and S4-4 API-token management. |
| ⑤ **Provenance** | ✅ DONE | `page_revisions.actor_type` + `source` render as badges in [RevisionHistoryPanel.tsx](packages/web/src/components/revisions/RevisionHistoryPanel.tsx). S5-2 adds a "View source" button per revision that opens an [IngestionSourcePanel](packages/web/src/components/revisions/IngestionSourcePanel.tsx) drill-down showing raw payload, decision reason, confidence, and received time — backed by the existing `GET /workspaces/:id/decisions/:decisionId` endpoint. Revision summary DTO now returns `sourceIngestionId` + `sourceDecisionId`. Graph-layer provenance also in place: clicking a node opens [NodeInspector](packages/web/src/components/graph/NodeInspector.tsx) showing the entity's top source pages + per-triple evidence excerpts, backed by `GET /workspaces/:id/entities/:entityId/provenance` ([entities.ts](packages/api/src/routes/v1/entities.ts)). |
| ⑤ **Freshness** | 🟡 PARTIAL | Migration 0004 adds `pages.last_ai_updated_at` + `last_human_edited_at`, bumped by route-classifier/patch-generator/apply-decision on AI writes and by editor save/rollback on human writes. [FreshnessBadge](packages/web/src/components/editor/FreshnessBadge.tsx) renders in the editor status bar showing whichever is latest with a "stale >30d" tone. Still missing: "triples superseded" marker and a workspace-wide stale-pages view. |
| ⑤ **Conflicts** | 🟡 PARTIAL | **Concurrent human-edit guard (S5-3) landed 2026-04-22:** route-classifier snapshots `pages.current_revision_id` at enqueue time and passes it to the patch-generator as `baseRevisionId`; [patch-generator.ts](packages/worker/src/workers/patch-generator.ts) now runs `detectHumanConflict()` before applying — if any `page_revisions` row with `actor_type='user'` exists on the target page with `createdAt > base.createdAt`, the job still writes the proposed revision + diff but **downgrades the decision to `suggested`** (instead of `auto_applied`), stamps `rationaleJson.conflict = { type: 'conflict_with_human_edit', humanRevisionId, humanUserId, humanEditedAt, humanRevisionNote, baseRevisionId }`, and skips the promote-to-current + `lastAiUpdatedAt` bump + triple-extractor enqueue. The review queue + ingestion-detail page render a red "⚠ conflict" banner over the decision with the human's timestamp and revision note so the reviewer knows approval will stack a new AI revision on top of intervening human work. AI-to-AI drift is deliberately not treated as a conflict — the patch re-merges against current head regardless, so the output isn't stale. Still missing: (a) concurrent ingestions racing for the same page, (c) contradicting triple values (S5-4). |
| ⑥ **Publish** | ✅ DONE (API) / 🟡 PARTIAL (UI) | [publish-renderer.ts](packages/worker/src/workers/publish-renderer.ts) + [docs.ts](packages/api/src/routes/v1/docs.ts) work end-to-end. No publish button in the editor UI. |
| — **Activity feed / AI notifications** | 🔴 MISSING | `audit_logs` is populated but never rendered. Users have no "what did the AI do in my workspace today" view. |
| — **AI-edit (in-editor)** | 🟡 PARTIAL | `POST /pages/:id/ai-edit` streams via SSE and [api-client.aiEdit](packages/web/src/lib/api-client.ts) consumes it. **No accept/reject UI** — result is streamed to screen, user manually saves or discards. No suggestion history. |
| — **Notion-like editor/layout** | 🟡 PARTIAL | Hierarchical page tree + collapse/expand ✅; slash menu with 8 block types ✅; 2s debounced autosave ✅. **Missing:** page icon/cover (no DB column), block drag handles, page-link/mention, callout/toggle/math blocks, breadcrumb, backlinks panel, in-editor TOC, drag-and-drop reparent, Cmd+K palette. |
| — **Graph exploration** | 🟡 PARTIAL | Per-page BFS endpoint + force-graph-2d render + type-colored nodes + predicate edge labels + entity detail panel (NodeInspector with source pages + evidence excerpts, cross-page navigation) ✅. **Missing:** workspace-wide graph, predicate/confidence filters, node search/highlight, confidence visual encoding (edge width/opacity), 3D toggle UX surface. |
| — **Infra hygiene** | 🟡 PARTIAL | Health checks OK; `pages.search_vector` column + GIN index created by migration 0003; admin-only `/admin/queues` page (S3-4) surfaces BullMQ-level per-queue counts, failed/stalled job lists with retry/remove — no more silent DLQ; no CI; 12 unit test files total; no API integration tests; no Yjs/Hocuspocus. |

### What this means for the goal

With tranche S5 shipped, the loop surfaces its own signal: the editor header now tells a reader "this page was AI-updated 3h ago" or "stale · last change 40d ago" (FreshnessBadge), and every AI-authored revision exposes a "View source" drill-down showing the raw payload, decision reason, and confidence that produced it. Provenance (⑤) is now end-to-end, and freshness is readable per-page.

What remains on the path to "AI keeps the wiki continuously up-to-date under human supervision": concurrent-ingestion detection (two classifiers racing to the same page), triple-level contradictions (S5-4), and a workspace-wide activity feed rendered from `audit_logs` (S6-1). The S4-2 drill-down + S5-3 human-vs-AI edit race are now in: reviewers can trace any decision back to the candidate set the classifier chose from, and AI auto-apply no longer silently steps on top of a human save.
