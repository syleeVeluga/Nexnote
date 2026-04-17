# NexNote — Task Backlog

> **Snapshot:** 2026-04-17
> **North-star goal:** External signals flow in continuously; the wiki stays automatically up-to-date under human supervision. AI classifies/merges/deduplicates; humans review/correct/approve.
>
> **Status of the core loop** — see [CLAUDE.md](CLAUDE.md#current-implementation-status-snapshot-2026-04-17). Backend pipeline (①→②→③-auto) works. The human-supervision half (④ review, ⑤ provenance/freshness) is largely missing in the UI. Closing those gaps is the priority.

Tasks are grouped by **loop stage**, not by package. Within each stage, **[HIGH] / [MED] / [LOW]** marks urgency toward the goal.

> **Tranche 1 landed (2026-04-17):** migration `0003_supervision_loop_foundations` (search_vector column + GIN index, `page_revisions.source_ingestion_id` + `source_decision_id` FKs, `ingestion_decisions.status`); route-classifier now does three-band routing and tags decisions `auto_applied` / `suggested` / `needs_review` / `noop`; patch-generator populates provenance FKs and sets status on success/failure; the `POST /ingestions/:id/apply` endpoint transitions decision status to `approved` / `rejected` on human action.
>
> **Tranche 2 landed (2026-04-17):** dedicated `/workspaces/:id/decisions` API (list with joined ingestion/page context, per-status counts, detail with proposed diff, `approve` / `reject` / `PATCH` endpoints writing `audit_logs`); `apply-decision.ts` helper shared between the old apply endpoint and the new approve flow; `api-client.ts` gains `ingestions` + `decisions` surfaces; `/review` page with tabs (suggested / needs review / failed / recent), j/k/a/r keyboard shortcuts, and a detail panel that renders the proposed diff and reject-with-reason form; sidebar shows a pending-review badge. Next up: S4-2 (ingestion detail drill-down), S5-1/S5-2 (freshness + per-revision source attribution in the history panel).

---

## Stage ③ — Remaining follow-ups

### S3-3 · [MED] Retry / dead-letter path for failed patch-generator jobs
Currently a failed patch-generator sets `ingestions.status="failed"` and logs — no retry UI, no dead-letter queue.
- Expose failed ingestions in the review queue with an error excerpt
- "Retry" button re-enqueues; "Abandon" marks it closed with audit entry

---

## Stage ④ — Human review UI

The primary review surface shipped in Tranche 2: [/review](packages/web/src/pages/ReviewQueuePage.tsx) with tabs, list + detail panes, keyboard shortcuts, and a sidebar badge. Remaining work drills deeper into individual ingestions and makes onboarding of new ingestion sources self-serve.

### S4-2 · [HIGH] Ingestion detail view
- Route: `/workspaces/:slug/ingestions/:id`
- Shows raw payload, normalized text, all classification candidates the AI considered, the chosen decision, and the resulting revision (if any)
- From the detail view, reviewer can re-run classification with a different LLM / override the target page

### S4-4 · [MED] API token management UI (prerequisite for onboarding external AI sources)
`api_tokens` table exists; the only way to mint one is via DB seed. Without this, onboarding a new ingestion source requires a DBA.
- `/workspaces/:slug/settings/tokens` — list, create (one-time reveal), revoke, scopes, last-used-at

---

## Stage ⑤ — Provenance, freshness, conflicts (the "trust" layer)

If users can't tell what's current, where a sentence came from, or whether AI is about to overwrite their edit, they won't trust the system to run autonomously.

### S5-1 · [HIGH] Per-page freshness indicators
- Add `pages.last_ai_updated_at`, `pages.last_human_edited_at` (updated by a trigger or in the revision-insert path)
- Page header shows: "Last AI update: 3h ago (from *Slack-ingest*)" / "Last human edit: 2d ago by Alice"
- Page list view: sort/filter by staleness

### S5-2 · [HIGH] Per-revision source attribution in the history panel
Depends on P0-2. With `source_ingestion_id` populated:
- [RevisionHistoryPanel.tsx](packages/web/src/components/revisions/RevisionHistoryPanel.tsx) shows a link "from ingestion #abc (Slack webhook)" when actor_type=ai
- Clicking drills into the ingestion detail view (S4-2)

### S5-3 · [MED] Concurrent-edit guard
When a patch-generator job runs, verify no human session has modified the page since `base_revision_id`. If so:
- Do NOT auto-apply; downgrade the decision to `"suggested"` with reason `"conflict_with_human_edit"`
- Review UI surfaces these prominently

### S5-4 · [MED] Contradicting-triple detection
When triple-extractor produces a triple `(S, P, O1)` but `(S, P, O2)` already exists with different object and overlapping time window, mark both as `conflict=true` and surface in a workspace "Contradictions" view. Do not auto-delete — let a human resolve.

### S5-5 · [LOW] Stale-knowledge sweep
Cron job: flag pages with no AI update in N days AND no human edit in M days as `stale`. Surface on workspace dashboard.

---

## Stage ⑥ — Activity feed & notifications (the "what just happened" layer)

Reviewers and workspace owners need to see the AI's work in aggregate, not just by clicking into individual pages.

### S6-1 · [HIGH] Workspace activity feed
- `/workspaces/:slug/activity` — paginated list of `audit_logs` joined with `model_runs`, rendered as "AI updated *Foo* from ingestion *Slack*", "Alice approved suggestion for *Bar*"
- Filters: actor_type, entity_type, action, date range

### S6-2 · [MED] Sidebar badges & in-app notifications
- Sidebar shows counts: pending decisions, conflicts, failed jobs
- Optional: webhook / email digest for reviewers

---

## In-editor AI interaction

### E-1 · [MED] Accept/reject UI for `POST /pages/:id/ai-edit` output
Current SSE result streams into the editor but there's no explicit "Accept this rewrite" / "Reject" step. Users lose track of what changed.
- Render AI output in a side-by-side proposal pane
- Accept = apply as new revision with `source="ai_edit_command"`, `actor_type="ai"`
- Reject = stored as `ai_edit_rejections` for future prompt improvement

### E-2 · [LOW] Inline highlight of recent AI changes
For N minutes after an AI edit, highlight the affected blocks in the editor so human collaborators see what AI touched.

---

## Notion-like UX — layout & editor (UX-N)

The platform's credibility as a knowledge wiki depends on the editor feeling native. Current state: hierarchical sidebar + slash menu + autosave are in; most of what makes Notion *feel* like Notion is not.

### UX-N1 · [HIGH] Page metadata: icon (emoji) + cover image
Without these, pages look like filesystem entries rather than living documents — users can't create visual landmarks in a large wiki.
- Schema: add `pages.icon TEXT NULL` (emoji shortcode or file-ref), `pages.cover_url TEXT NULL`, `pages.cover_position SMALLINT`
- Sidebar: render icon next to title
- Editor header: click icon to pick from emoji picker; hover cover to change / remove / reposition
- Public docs: render icon + cover in list and detail pages

### UX-N2 · [HIGH] Drag-and-drop reparent + reorder
Hierarchy exists in `pages.parent_page_id` + `sort_order` but there's no way to reorganize without edit-title-style workflows.
- Sidebar: dnd-kit (or similar) for tree reordering
- Drop zones: "before", "after", "as child of"
- API: `PATCH /pages/:id { parentPageId, sortOrder }` with sibling reshuffling
- Guard against circular parentage

### UX-N3 · [HIGH] Block drag handle + "+" button
Each block needs the hover affordances that make Notion's editor feel tactile: `⋮⋮` drag handle on the left, `+` button to insert below.
- Tiptap: custom `NodeView` or global handle extension
- Operations: move up/down, duplicate, delete, convert block type
- Keyboard: `Opt+Shift+↑/↓` to move, `Cmd+D` to duplicate

### UX-N4 · [HIGH] Page links & mentions (`@`, `[[…]]`)
A knowledge wiki without internal linking is not a wiki.
- Slash/`@`/`[[` triggers an inline search across workspace pages
- Inserts a Tiptap `pageLink` mark/node with `pageId`; renders as a live, click-through pill
- Backlinks panel at page bottom: "Referenced by: *Foo*, *Bar*" — query `page_links` edge table (new) updated on revision save
- Public docs: resolve internal links to `/docs/:ws/:path`

### UX-N5 · [MED] Missing block types
PRD calls for a rich editor. Add progressively:
- **Callout** (with icon + color): info/warn/success/error presets
- **Toggle** (collapsible children blocks)
- **Math** (inline `$…$` and block `$$…$$` via KaTeX)
- **Embed** (YouTube, Loom, Figma — URL-sniffing with allowlist)
- **Database/Table view** — defer unless clearly demanded
- Each new type must round-trip cleanly to Markdown (custom directive syntax); add round-trip tests

### UX-N6 · [MED] Breadcrumb + in-editor TOC
Public docs already render a TOC ([PublicDocPage.tsx](packages/web/src/pages/PublicDocPage.tsx)); editors get nothing.
- Breadcrumb above title: `Workspace / Parent / Current` with click-through
- Right rail: sticky TOC built from the editor's heading tree; active-section highlighting on scroll

### UX-N7 · [MED] Inline title + slug editing
[PageEditorPage.tsx](packages/web/src/pages/PageEditorPage.tsx) separates title from body; Notion makes title an H1 atop the document.
- Merge title into the editor as a locked first block or a styled input directly above
- Slug auto-derives from title; manual override available in page settings

### UX-N8 · [MED] Cmd+K command palette
Global keyboard-first navigation is table-stakes for a wiki of any size.
- `Cmd+K` — search pages, jump, recent, "create new page under current"
- `Cmd+P` — quick-open
- `Cmd+/` — toggle slash menu help
- Reuse the FTS search API (once P0-1 lands) + recency from `audit_logs`

### UX-N9 · [LOW] Keyboard shortcut surface
Document and expose: Cmd+B/I/U, Cmd+K link, Cmd+Shift+1/2/3 headings, Cmd+Enter toggle task, Tab/Shift+Tab list nesting. Help sheet behind `?`.

---

## Triple quality & graph exploration (G)

The knowledge graph is the payoff of the whole pipeline but currently produces low-fidelity triples and offers almost no exploration UX beyond a per-page BFS.

### G-1 · [HIGH] Audit triple-extractor quality & entity typing
Spot-check: entities get typed almost entirely as `concept`. Without meaningful types (person/org/product/event/place), the graph's color legend is noise and filters are useless.
- Review the LLM prompt in [triple-extractor.ts](packages/worker/src/workers/triple-extractor.ts) — does it explicitly ask for entity type? Add an enum with definitions
- Run extraction on a 20-page seed corpus, manually label, measure precision/recall
- Gate merges: if type confidence < 0.5, fall back to `concept` but flag for review

### G-2 · [HIGH] Entity alias / merge handling
`entity_aliases` table exists but confirm the worker actually writes to it and reuses aliases before creating a new entity. Without this, the graph fragments ("GPT-5.4", "gpt5.4-pro", "GPT 5.4" become three nodes).
- On extraction, match incoming subject/object against `entities.normalized_key` AND `entity_aliases.alias`
- Merge UI: "Entity *X* and *Y* look like duplicates — merge?" in a workspace admin view

### G-3 · [HIGH] Deduplicate triples on re-extraction
Same page re-extracted (after edit) should update confidence / span on existing triples, not insert duplicates. Verify current behavior; add a uniqueness constraint on `(subject_entity_id, predicate, object_entity_id_or_literal_hash, revision_id)` if missing.

### G-4 · [HIGH] Workspace-wide graph view
Per-page BFS is good for focus; users also need the big picture.
- `GET /workspaces/:id/graph?predicate=&minConfidence=&type=&limit=` — density-aware sampling (cap nodes, prefer high-degree)
- `/workspaces/:slug/graph` page (not a side panel) with full-screen force-graph
- Stats: total entities, top predicates, orphaned pages

### G-5 · [HIGH] Entity detail panel
Clicking a node currently doesn't open anything meaningful.
- Side panel: entity label, type, aliases, all triples where it appears (in/out), pages that mention it (via `triple_mentions`), confidence distribution
- Actions: rename, merge with another entity, change type, delete

### G-6 · [MED] Graph filters + confidence encoding
The force-graph renders all edges at equal weight, which hides signal.
- Filters: predicate multiselect, confidence slider, entity-type toggles, time range (based on `triples.created_at`)
- Visual encoding: edge opacity/width ∝ confidence; dashed edges for `conflict=true` triples (from S5-4)

### G-7 · [MED] Node search + focus
- Search box above graph — fuzzy match on entity label + aliases
- Match → highlight node, pan camera, dim others
- "Find path between X and Y" — shortest-path query over triples

### G-8 · [MED] 3D toggle UX surface
The 3D renderer is lazy-loaded in [GraphPanel.tsx](packages/web/src/components/graph/GraphPanel.tsx) but there's no toggle in the UI. Add a segmented control (2D / 3D) and persist the choice per user.

### G-9 · [LOW] Graph export
`.graphml` / `.json` export for external tooling (Gephi, Cytoscape).

### G-10 · [LOW] Time-lapse / "what changed this week"
Overlay recent triple additions (last 7d) with a pulse animation so users see the graph growing.

---

## Cross-cutting infra (not tied to a loop stage but blocks confident iteration)

### X-1 · [HIGH] CI workflow (`.github/workflows/ci.yml`)
Install, lint, typecheck, unit tests, migration sanity. Services: Postgres + Redis. Every PR runs this.

### X-2 · [HIGH] Pipeline integration test
End-to-end test: synthetic ingestion → route-classifier → patch-generator → triple-extractor. Assert decision row, revision row, triples row, audit entries all chain with correct FKs. Use testcontainers or a docker-compose.test.yml. Mock the AI adapter with deterministic responses.

### X-3 · [MED] API route integration tests
`packages/api` has zero test files. Cover at minimum: auth flows, role guards, ingestion intake, decision approve/reject, graph endpoint, ai-edit SSE.

### X-4 · [MED] Observability: queue depth + job duration metrics
`prom-client` endpoint on api + worker. Surface: queue depth per stage, job duration histogram, AI latency + cost. Without this, pipeline stalls are invisible.

### X-5 · [LOW] pgvector-based candidate search (gated by flag)
Currently route-classifier uses FTS + trigram. pgvector would help when incoming text uses different vocabulary than the page.

### X-6 · [LOW] Yjs/Hocuspocus collaboration
PRD calls for it; not installed. Until concurrent-edit guard (S5-3) is in place, this is risky to add.

---

## How to work this list

1. **P0 first** — they corrupt data or break the trust story.
2. **Close the supervision loop next: S3 → S4 → S5.** Fix routing, then the UI that consumes it, then the trust layer.
3. **In parallel, run two tracks:**
   - **UX-N (Notion-like polish)** — can be worked by a frontend-focused contributor without blocking the backend loop work. UX-N1 through UX-N4 are what visitors notice first.
   - **G (graph & triple quality)** — G-1/G-2/G-3 are backend/prompt work; G-4/G-5/G-6 are frontend. G-1 should land before G-4/G-5 or the big graph view will be full of `concept`-typed noise.
4. **[HIGH] within each section** before anything lower.
5. Do NOT start S4 tasks before P0-2 and S3-1 — the review UI depends on decisions being correctly banded and revisions being linked to ingestions.
6. When a task completes, delete it from this file in the same PR. The goal is for this file to shrink.

Avoid:
- Adding more AI capabilities (better prompts, more models, smarter extraction) before the supervision loop is closed. AI quality doesn't matter if nobody can review its output.
- Building the workspace-wide graph (G-4) before G-1/G-2 — a dense graph of `concept` nodes with fragmented duplicates is worse than no graph.
- Reviving "Yjs collaboration" (X-6) until S5-3 conflict handling exists.
