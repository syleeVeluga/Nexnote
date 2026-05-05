# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Documentation map

루트에는 오케스트레이터 가이드(이 파일과 [`CLAUDE.md`](CLAUDE.md))만 둔다. 제품·설계·구현 문서는 모두 [`docs/`](docs/) 아래로 이동했다.

| 분류 | 폴더/파일 위치 |
|---|---|
| **아키텍처 및 데이터 모델** | [`docs/architecture/`](docs/architecture/) (ERD, KNOWLEDGE_CONNECTIVITY_PLAN, SYSTEM_ARCHITECTURE 등) |
| **제품 기획 및 UI 문서** | [`docs/product/`](docs/product/) (PRD, UI_REFERENCE_IMPLEMENTATION_PLAN) |
| **개발 백로그 및 진행 상태** | [`docs/backlog/`](docs/backlog/) (TASKS.md, page-link-extraction-rfc 등) |
| **운영 가이드** | [`docs/guides/`](docs/guides/) (slack-webhook 등) |
| **보관 문서 (Archive 완료된 RFC)** | [`docs/archive/`](docs/archive/) (v1, v2 에이전트 구현 및 RFC 히스토리) |

새로운 시스템 아키텍처는 [`docs/architecture/SYSTEM_ARCHITECTURE.md`](docs/architecture/SYSTEM_ARCHITECTURE.md)를 참고한다. 과거에 진행된 Ingestion Agent 및 Agent Autonomy (v1, v2) 작업 내역은 모두 목표를 달성하여 `archive/` 로 이동되었다.

## Project Overview

WekiFlow is an AI-assisted Markdown knowledge wiki. Its single north-star goal: **external signals (AI agents, scrapers, webhooks, humans) flow in continuously, and the wiki stays automatically up-to-date under human supervision.** AI does the drudgery of classifying, merging, deduplicating, and extracting structure; humans act as reviewers, correctors, and final approvers.

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
| Graph UI | react-force-graph-2d (3D toggle planned, not shipped) |

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
  entities, audit_logs    ingestion-agent (shadow),
                          patch-generator,
                          triple-extractor,
                          publish-renderer,
                          search-index-updater,
                          content-reformatter,
                          scheduled-agent
                               │
                               ▼
                         [AI Gateway]
                          ├─ OpenAI adapter
                          └─ Gemini adapter
```

## Data Model (core tables)

The full ERD is in [`docs/architecture/ERD — AI 기반 Markdown 지식 위키 서비스.md`](docs/architecture/ERD%20%EC%B4%88%EC%95%88%20%E2%80%94%20AI%20%EA%B8%B0%EB%B0%98%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%20%EC%84%9C%EB%B9%84%EC%8A%A4.md). Key relationships:

- **pages** → container pointing to `current_revision_id`; actual content lives in **page_revisions**
- **page_revisions** → full markdown snapshot + JSON; linked to **revision_diffs** (line diff + block ops diff)
- **published_snapshots** → immutable snapshot from a specific revision; one `is_live` per page
- **ingestions** → raw external payload → **ingestion_decisions** (create/update/append/noop/needs_review)
- **scheduled_tasks** / **scheduled_runs** → cron/manual wiki-maintenance runs that reuse the ingestion-agent loop
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
A tool-calling **ingestion agent** explores → plans → executes across multiple pages per ingestion (1→N decision fan-out), using VS-Code-style tier-1/2/3 patches (`replace_in_page` / `edit_page_blocks` / `edit_page_section`) instead of full rewrites, and exploits 800k-token context windows. The loop lives in [`packages/worker/src/lib/agent/`](packages/worker/src/lib/agent/) (`loop.ts`, `dispatcher.ts`, `tools/read.ts`, `tools/mutate.ts`).

Rollout is workspace-scoped via `workspaces.ingestion_mode = classic | shadow | agent`. Promotion to `agent` is server-gated by a parity check (≥0.90 action / ≥0.85 target-page agreement over 7 days × 20 ingestions; thresholds env-tunable). Confidence routing inside the loop:
- ≥ 0.85 → auto-apply to draft
- 0.60–0.84 → suggestion queue
- < 0.60 → needs_review

The legacy single-shot classifier ([`packages/worker/src/workers/route-classifier.ts`](packages/worker/src/workers/route-classifier.ts)) still owns decisions in `classic`/`shadow` modes. Full agent design in [`docs/archive/v1/ingestion-agent-plan.md`](docs/archive/v1/ingestion-agent-plan.md).

### Scheduled Agent
Scheduled Agent reuses the ingestion-agent loop for both recurring wiki maintenance and user-directed selected-page editing without an external payload. A user can select pages/folders and ask the agent to write a new Markdown document, edit an existing page, append meeting notes, consolidate policy fragments, move/rename pages, or merge duplicates. In this mode the user instruction is the primary task; selected pages may be source material, edit targets, or both. Small selected scopes are prefetched with `read_page(format="markdown")` before planning, and selected source pages must be preserved unless deletion/archive/destructive merge is explicitly requested. Admins enable it in `/settings/ai`, manage cron tasks and recent runs in `/settings/scheduled-agent`, or trigger a folder-scoped run from the folder page. Runs are traceable through `scheduled_runs`, `agent_runs`, an internal ingestion row, and `ingestion_decisions.scheduled_run_id`. See [`docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md`](docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md) and [`docs/archive/v1/scheduled-agent-plan.md`](docs/archive/v1/scheduled-agent-plan.md).

### Editor round-trip
Block editor (Tiptap/ProseMirror) and Markdown source mode must represent the same document. The canonical store is Markdown. Custom blocks that can't be expressed in standard Markdown use a documented directive syntax. **Round-trip regression tests are essential.**

### AI provider adapter
OpenAI and Gemini sit behind a common interface. Model strings must be pinned exactly (no `latest` aliases). All calls logged to `model_runs`.

### Triple constraints
`triples.object_entity_id` and `triples.object_literal` are mutually exclusive (exactly one must be non-null via CHECK constraint).

### Publish flow
Publish creates an immutable snapshot with rendered HTML, TOC JSON, internal link map, and search index entry. Public URL pattern: `/docs/:workspaceSlug/:pagePath`.

## AI Output Contracts

The ingestion agent uses a normalized **Tool-Call** contract:
- **Read tools**: `search_pages` / `read_page` / `list_folder` / `find_related_entities` / `list_recent_pages` / `read_page_metadata` / `find_backlinks` / `read_revision_history` / `read_revision`
- **Mutate tools**: `replace_in_page` / `edit_page_blocks` / `edit_page_section` / `update_page` / `append_to_page` / `create_page` / `move_page` / `rename_page` / `create_folder` / `delete_page` / `merge_pages` / `rollback_to_revision` / `noop` / `request_human_review`
- Explore → plan → execute trace persisted in `agent_runs`. Full schemas in [`docs/archive/v1/ingestion-agent-plan.md`](docs/archive/v1/ingestion-agent-plan.md).

> The `INGESTION_ACTIONS` enum is intentionally **not** extended for newer tool names; tool names are tracked separately and cascade through parity gate, classifier, audit renderer, trace UI, and i18n. Historical v2 design notes are in [`docs/archive/v2/`](docs/archive/v2/).

The classic single-shot path (alive in `classic`/`shadow` modes) emits three structured contracts defined in PRD section 13:
- **Route Decision**: `{ action, targetPageId, confidence, reason, proposedTitle }`
- **Patch Proposal**: `{ targetPageId, baseRevisionId, editType, ops[], summary }`
- **Triple Extraction**: `{ triples[]: { subject, predicate, object, objectType, confidence, spans[] } }`

## Current state & next direction

The knowledge-refresh loop is closed end-to-end. Ingestion-agent and Scheduled Agent shipped behind a server-side parity gate (`workspaces.ingestion_mode = classic | shadow | agent`). Review queue, ingestion drill-down, activity feed, freshness badges, conflict downgrade (concurrent human-edit guard), and graph provenance are all live.

**Recent Completion (v2 Agent Autonomy):** Full agent autonomy on top of the existing loop (formerly the v2 RFC bundle) is now fully implemented and active in the system. The agent operates with robust safety nets, multi-turn replanning, rollback capabilities, and extended tools suite (`rollback_to_revision`, `move_page`, `rename_page`, `create_folder`, etc.). Historical RFCs and design discussions for these features are preserved in the `docs/archive/` folder.

**Recent Direction (user-directed knowledge editing):** Scheduled/manual agent runs now treat selected pages as source material, edit targets, or both, and the user instruction as the primary task. This makes "write a new page from these 9 pages", "merge these meeting notes into a policy summary", and similar knowledge-management requests first-class behavior rather than incidental maintenance. See [`docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md`](docs/architecture/USER_DIRECTED_AGENT_WORKFLOW.md).

**Active direction:**
Future improvements, missing features, and new goals are tracked primarily in [`docs/backlog/TASKS.md`](docs/backlog/TASKS.md). When starting a new effort, refer to the architecture documentation (`docs/architecture/`) to understand existing constraints, and document any substantial system changes with a new RFC in the `docs/architecture/` or `docs/product/` directories appropriately.
