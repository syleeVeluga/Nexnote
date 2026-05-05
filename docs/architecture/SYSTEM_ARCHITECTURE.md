# WekiFlow System Architecture

> **Last Updated:** 2026-05-05

## 1. Overview

WekiFlow is an AI-assisted Markdown knowledge wiki. External signals flow in continuously, and the wiki stays automatically up-to-date under human supervision.

WekiFlow also supports user-directed knowledge work. A user can select existing pages, folders, meeting notes, policy fragments, personal notes, or data documents and ask the agent to write, edit, append, merge, reorganize, or create Markdown pages from that material. This is a first-class workflow alongside autonomous ingestion and scheduled maintenance.

## 2. Core Knowledge-Refresh Loop

1. **Ingest:** Webhook / API / external AI / human-provided material.
2. **Classify or interpret:** Route to `create`, `update`, `append`, `merge`, `noop`, or `needs_review`.
3. **Apply:** Auto-apply high-confidence draft changes, create suggestions, or flag for human review.
4. **Human review:** Approve, edit, reject, merge, or reroute.
5. **Provenance:** Persist origin, actor, model run, source material, and freshness data.
6. **Publish:** Create immutable snapshots for readers.

Historical autonomous-agent RFCs live under `docs/archive/v1` and `docs/archive/v2`.

## 3. Agent Workflows

### External Ingestion

API, webhook, and external AI payloads are persisted as raw ingestions, normalized, explored with read tools, and applied through the confidence gates.

### User-Directed Wiki Edit

Selected pages and user-provided material are treated as source material, edit targets, or both. The user instruction is the primary task. The agent should create or edit Markdown pages when requested, preserve selected source pages unless deletion or destructive merge is explicit, and request human review only when it cannot execute safely.

For the detailed contract, see [User-Directed Agent Workflow](./USER_DIRECTED_AGENT_WORKFLOW.md).

### Scheduled Maintenance

Scheduled/manual runs reuse the same agent loop for recurring wiki hygiene, stale-page cleanup, dedupe, folder-scoped restructuring, and other workspace maintenance. These runs remain traceable through `scheduled_runs`, `agent_runs`, internal ingestion rows, and `ingestion_decisions.scheduled_run_id`.

## 4. High-Level Components

* **Frontend:** React 19.x, Vite 8.x, Tiptap.
* **Backend:** Node.js 24.x, Fastify 5.x.
* **Database:** PostgreSQL 18.x with Drizzle/Kysely.
* **Queue:** BullMQ 5.x + Redis.
* **AI Gateway:** OpenAI / Gemini behind a common adapter.
* **Worker agents:** ingestion agent, scheduled/user-directed agent, patch generator, triple extractor, publish renderer, search/link workers.

## 5. Useful Links

* [ERD](./ERD%20%EC%B4%88%EC%95%88%20%E2%80%94%20AI%20%EA%B8%B0%EB%B0%98%20Markdown%20%EC%A7%80%EC%8B%9D%20%EC%9C%84%ED%82%A4%20%EC%84%9C%EB%B9%84%EC%8A%A4.md)
* [Knowledge Connectivity Plan](./KNOWLEDGE_CONNECTIVITY_PLAN.md)
* [Chunking Plan](./CHUNKING_PLAN.md)
* [User-Directed Agent Workflow](./USER_DIRECTED_AGENT_WORKFLOW.md)
