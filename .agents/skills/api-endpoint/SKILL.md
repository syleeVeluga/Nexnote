---
name: api-endpoint
description: Scaffold a new Fastify API endpoint for NexNote
argument-hint: "<HTTP-method> <path> [description]"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

Create a new Fastify API endpoint for NexNote.

## Arguments
- `$0` — HTTP method (GET, POST, PUT, PATCH, DELETE)
- `$1` — Route path (e.g., `/api/v1/pages/:pageId/revisions`)
- Remaining — Description of what the endpoint does

## Existing routes
```!
find packages/api/src/routes -name "*.ts" 2>/dev/null | head -20 || echo "No routes yet"
```

## Instructions

1. Read the PRD (`PRD — AI 보조 Markdown 지식 위키문서 서비스.md`) for the API contract if this is a defined endpoint
2. Create or update the appropriate route file in `packages/api/src/routes/`
3. For each endpoint, create:
   - Zod request schema in `packages/shared/` (if not already present)
   - Zod response schema in `packages/shared/`
   - Route handler as a Fastify plugin
   - Proper auth middleware attachment
4. Follow conventions:
   - External API routes: Bearer token auth
   - Internal routes: session auth
   - Ingestion endpoints return 202 and queue async work
   - All mutations create audit log entries
   - All page mutations go through revision system
   - Error shape: `{ error: string, code: string, details?: unknown }`
5. Add a basic test file for the endpoint
