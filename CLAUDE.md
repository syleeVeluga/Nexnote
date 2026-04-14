# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NexNote is an AI-assisted Markdown knowledge wiki platform where external AI agents and humans collaboratively create, edit, connect, and publish documents. The canonical format is **Markdown + frontmatter**; the editor also stores a block-editor JSON snapshot alongside it.

Key design invariants:
- Markdown is the source of truth for every page
- Every change (human, AI, or system) creates a revision — no hard overwrites
- Triples (subject/predicate/object) are stored in PostgreSQL with provenance, not in a Graph DB
- Published docs are immutable snapshots separate from drafts
- External AI ingestion always persists the raw payload before processing

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
