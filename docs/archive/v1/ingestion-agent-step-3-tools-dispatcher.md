# Ingestion Agent Step 3: Read Tools and Dispatcher

Status: completed (2026-04-29)

Scope: AGENT-3 from `docs/TASKS.md`.

## Goal

Add the read-only tool layer needed by the ingestion agent explore phase:

- `search_pages`
- `read_page`
- `list_folder`
- `find_related_entities`
- `list_recent_pages`

The dispatcher owns validation, quota, dedupe, and run-local observation state.
Mutating tools are intentionally out of scope for this step.

## Interface Decisions

- Tool input schemas live in `packages/shared/src/schemas/agent.ts` so later API,
  worker, and UI trace code share one contract.
- Tool implementations receive `workspaceId` only from dispatcher context. Tool
  schemas do not include `workspaceId`; any LLM-supplied field by that name is
  stripped by Zod before execution.
- `search_pages` mirrors the classic classifier search order: title match, FTS,
  trigram title similarity, then entity overlap. It returns page metadata and
  short excerpts only; full content comes from `read_page`.
- `read_page(format="markdown")` returns full current revision Markdown.
  `format="summary"` is deterministic and SQL/local-code only. `format="blocks"`
  returns stable per-run block IDs based on block index + content hash.
- Dispatcher quota defaults: `search_pages <= 8`, `read_page <= 20`,
  `list_folder <= 20`, `find_related_entities <= 8`, `list_recent_pages <= 8`,
  and at most 5 tool calls per turn.

## Verification

- Unit tests cover dispatcher workspace closure, unknown/invalid calls, per-turn
  limit, per-tool quota, dedupe, and seen page/block tracking.
- Unit tests cover Markdown block splitting and stable block IDs for
  `read_page(format="blocks")`.
- Verified with `corepack pnpm --filter @wekiflow/worker test`.
- Verified repository type safety with `corepack pnpm typecheck`.
