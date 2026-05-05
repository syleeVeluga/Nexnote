# AGENT-5 - Mutate Tiers

Status: in progress (2026-04-29)

## Goal

Move the ingestion agent from shadow planning to agent-mode decision ownership.
In `shadow` mode the loop still records `agent_runs.plan_json` only. In `agent`
mode the planned mutations fan out into `ingestion_decisions` rows.

## Interface Decisions

- Keep the existing shadow plan shape backwards-compatible.
- Add typed mutate-tool plans with `{ tool, args }` for exact execution.
- Legacy `{ action, targetPageId, ... }` plan items are still accepted and mapped
  to conservative mutate tools:
  - `create` -> `create_page` using the ingestion text.
  - `append` -> `append_to_page` using the ingestion text.
  - `update` -> `update_page` using the ingestion text as fallback merge input.
  - `noop` -> `noop`.
  - `needs_review` -> `request_human_review`.
- Direct patch tiers create revisions without another LLM call:
  - `replace_in_page`
  - `edit_page_blocks`
  - `edit_page_section`
- `update_page` and `append_to_page` create decisions and enqueue the existing
  patch-generator for high-confidence auto-apply.

## Safety Rules

- Tool dispatcher keeps workspaceId closed over; model-provided workspace IDs are
  ignored by Zod stripping.
- Mutating an existing page requires a page id observed earlier in the run.
- `edit_page_blocks` requires block ids observed from `read_page(format="blocks")`.
- A run can mutate a given page at most once.
- Direct patch tools re-read the current revision at mutation time and fail if
  exact anchors no longer match.
- Context compaction follows the Claude Code pattern: when explore/plan context
  approaches 80% of the model budget, oldest tool results are replaced with a
  deterministic summary plus a system notice; the compacted read cache entry is
  invalidated so the agent can re-fetch exact content on demand.
- Mutate tool failures include self-correction hints. Exact text misses return
  nearest snippets with line/column positions; block ID misses return observed
  block IDs. Agent mode gets one repair turn before recording a failed decision.

## Verification Targets

- Patch primitive tests for exact find/replace, block ops, and heading-section
  boundaries.
- Loop test for agent-mode execution against a fake mutate tool.
- Budgeter tests for oldest-first compaction and re-read notice insertion.
- Dispatcher/loop tests for cache invalidation and mutation repair retry.
- Worker typecheck and worker unit tests.
