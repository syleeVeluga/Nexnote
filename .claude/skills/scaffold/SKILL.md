---
name: scaffold
description: Scaffold a new package or module in the NexNote monorepo
argument-hint: "<package-name> [web|api|worker|shared|db]"
allowed-tools: Read, Glob, Bash, Write, Edit
---

Scaffold a new module or package for NexNote.

## Arguments
- `$0` — the name of the module/feature (e.g., `ingestion-router`, `graph-panel`)
- `$1` — the target package: `web`, `api`, `worker`, `shared`, or `db` (default: infer from name)

## Current project state
```!
ls packages/ 2>/dev/null || echo "No packages/ directory yet — scaffold the monorepo first"
```

## Instructions

1. If `packages/` doesn't exist yet, scaffold the full monorepo structure first:
   - `packages/web/` — React/Vite frontend
   - `packages/api/` — Fastify backend
   - `packages/worker/` — BullMQ processors
   - `packages/shared/` — Zod schemas, types, constants
   - `packages/db/` — migrations and query helpers
   - Root `package.json` with pnpm workspaces
   - Root `tsconfig.json` with project references
   - Root `pnpm-workspace.yaml`

2. If scaffolding a module within an existing package, create the appropriate directory structure with:
   - An index.ts barrel export
   - A basic TypeScript file with the module's boilerplate
   - A test file stub

3. Follow the conventions in CLAUDE.md for the tech stack.
