# Ingestion Agent Step 1: AI Gateway Tool Calling

Status: completed (2026-04-29)

Scope: AGENT-1 from `docs/TASKS.md`.

## Goal

Extend the shared AI gateway contract so workers can call OpenAI and Gemini with
the same normalized tool surface:

- `AIRequest.tools`
- `AIRequest.toolChoice`
- `AIMessage.role = "tool"` for tool results
- `AIMessage.toolCalls` for prior assistant tool calls
- `AIResponse.toolCalls` as provider-normalized output

This step does not implement the ingestion-agent loop or dispatcher. It only
adds the adapter boundary needed by later work.

## Interface Decisions

- Keep all new fields optional so existing route-classifier, patch-generator,
  triple-extractor, synthesis, and predicate-label calls remain unchanged.
- Normalize tool call IDs to `call_<index>_<tool_name>` at the gateway boundary.
  OpenAI's provider IDs are not exposed; later loop turns can echo the normalized
  IDs in assistant/tool messages and keep provider behavior consistent.
- Tool arguments are parsed into `Record<string, unknown>`. Invalid JSON falls
  back to `{ "__raw": string }`; dispatcher-level Zod validation will reject
  malformed arguments in AGENT-3.
- Gemini function calls do not carry IDs, so they use the same deterministic ID
  normalization as OpenAI.

## Verification

- Added a conformance test that stubs provider HTTP responses and verifies the
  same logical fixture returns identical normalized `toolCalls[]` from OpenAI
  and Gemini adapters.
- The same test asserts the outbound request bodies contain provider-native tool schema
  fields (`tools[].function` for OpenAI, `tools[].functionDeclarations` for
  Gemini).
- Verified with `corepack pnpm --filter @wekiflow/worker exec node --import tsx
--test src/ai-gateway.test.ts`.
- Verified repository type safety with `corepack pnpm typecheck`.
