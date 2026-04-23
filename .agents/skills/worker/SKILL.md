---
name: worker
description: Create a new BullMQ worker job for WekiFlow's async processing pipeline
argument-hint: "<job-name> [queue-name]"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

Create a new BullMQ worker job for WekiFlow.

## Arguments
- `$0` — Job name (e.g., `triple-extractor`, `publish-renderer`)
- `$1` — Queue name (default: infer from job type). Queues: `ingestion`, `extraction`, `publish`, `search`

## Existing workers
```!
ls packages/worker/src/ 2>/dev/null || echo "No worker package yet"
```

## Instructions

1. Read the PRD section 14 for pipeline logic details
2. Create the worker in `packages/worker/src/jobs/<job-name>.ts`
3. Each worker must:
   - Define a typed job data interface (Zod-validated)
   - Create a `model_runs` record for any AI calls
   - Be idempotent — safe to retry on failure
   - Log progress via BullMQ's `job.progress()`
   - Handle errors with proper status updates
4. If the job calls an AI provider:
   - Use the common AI adapter interface
   - Pin model strings exactly (no `latest`)
   - Validate AI output against the appropriate Zod contract schema
   - Record token usage and latency in `model_runs`
5. Register the worker in the worker entry point
6. Add a test file with mocked AI responses
