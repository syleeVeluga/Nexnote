---
name: test-gen
description: Generate tests for a WekiFlow module or file
argument-hint: "<file-path>"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

Generate tests for the specified WekiFlow file or module.

## Arguments
- `$ARGUMENTS` — path to the file or module to test (e.g., `packages/api/src/routes/ingestions.ts`)

## Instructions

1. Read the target file thoroughly
2. Identify testable units: functions, route handlers, class methods, hooks
3. Create a test file colocated with the source (e.g., `ingestions.test.ts` next to `ingestions.ts`)
4. Write tests covering:
   - Happy path for each public function/endpoint
   - Edge cases (empty input, boundary values, null/undefined)
   - Error cases (invalid input, missing auth, not found)
   - For API routes: request validation, response shape, status codes
   - For workers: job processing, retry behavior, AI output validation
   - For components: rendering, user interactions, state changes
5. Test guidelines:
   - Use the project's test runner (Vitest)
   - For API tests: use Fastify's `inject()` method
   - For DB tests: use real database (no mocks) with transaction rollback
   - Mock external AI providers but validate the mock shapes match real contracts
   - Use `describe`/`it` blocks with clear descriptions
