---
name: migration
description: Create a new database migration for WekiFlow's PostgreSQL schema
argument-hint: "<description>"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

Create a new database migration for WekiFlow.

## Arguments
- `$ARGUMENTS` — a description of what this migration does (e.g., "add review_items table", "add index on triples source_page_id")

## Current migrations
```!
ls packages/db/migrations/ 2>/dev/null || echo "No migrations directory yet"
```

## ERD Reference

Read the ERD file at the repo root (`ERD 초안 — AI 기반 Markdown 지식 위키 서비스.md`) before writing any migration. Ensure your schema matches the ERD's column definitions, types, and constraints.

## Instructions

1. Determine the next sequential migration number from existing files
2. Create `packages/db/migrations/NNNN_<snake_case_description>.sql`
3. Include both `-- migrate:up` and `-- migrate:down` sections
4. Follow these rules:
   - UUIDs for all PKs: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   - `timestamptz` for all time columns with `DEFAULT now()` where appropriate
   - Text-based enums with CHECK constraints (not PG enum)
   - Include all relevant indexes from ERD section 7
   - Include CHECK constraints from ERD section 6
   - Define ON DELETE behavior for all foreign keys
5. After writing, validate SQL syntax if possible
