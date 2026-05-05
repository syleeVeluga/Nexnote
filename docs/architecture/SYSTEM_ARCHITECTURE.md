# WekiFlow System Architecture

> **Last Updated**: 2026-05-05

## 1. Overview
WekiFlow is an AI-assisted Markdown knowledge wiki. External signals flow in continuously, and the wiki stays automatically up-to-date under human supervision.

## 2. Core Knowledge-Refresh Loop
1. **Ingest**: Webhook / API / External AI
2. **Classify**: Route to `create`, `update`, `append` or `noop`
3. **Apply**: Auto-apply (confidence ≥ 0.85), create suggestion (0.60–0.84), or flag for review (< 0.60)
4. **Human Review**: Approve, edit, reject, merge
5. **Provenance**: Persist origin and freshness data
6. **Publish**: Immutable snapshot for readers

*For historical context on the autonomous pipeline, see the `docs/archive/v2` and `docs/archive/v1` directories.*

## 3. High-level Components
* **Frontend**: React 19.x, Vite 8.x, Tiptap
* **Backend**: Node.js 24.x, Fastify 5.x
* **Database**: PostgreSQL 18.x with Drizzle/Kysely
* **Queue**: BullMQ 5.x + Redis
* **AI Adapter**: OpenAI (gpt-5.4) / Gemini 3.1 Pro

## 4. Useful Links
* [ERD](./ERD%20—%20AI%20기반%20Markdown%20지식%20위키%20서비스.md)
* [Knowledge Connectivity Plan](./KNOWLEDGE_CONNECTIVITY_PLAN.md)
* [Chunking Plan](./CHUNKING_PLAN.md)
