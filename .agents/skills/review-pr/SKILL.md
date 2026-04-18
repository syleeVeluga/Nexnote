---
name: review-pr
description: Review a pull request or current changes against NexNote's architectural rules
argument-hint: "[PR-number or branch]"
allowed-tools: Read, Glob, Grep, Bash
context: fork
agent: reviewer
---

Review code changes for NexNote project compliance.

## Arguments
- `$ARGUMENTS` — PR number, branch name, or empty for current uncommitted changes

## Current state
```!
git diff --stat HEAD 2>/dev/null || echo "No changes"
git log --oneline -3 2>/dev/null || echo "No commits"
```

## Instructions

Use the reviewer agent's checklist to audit all changed files:

1. Get the diff:
   - If PR number: `gh pr diff $ARGUMENTS`
   - If branch: `git diff main...$ARGUMENTS`
   - If empty: `git diff` + `git diff --cached`

2. For each changed file, check:
   - **Revision integrity**: page mutations create revisions, never direct updates
   - **Audit trail**: mutations create audit_logs, AI ops link to model_runs
   - **Security**: no plain-text tokens, parameterized queries, Zod validation at boundaries
   - **Schema consistency**: types match Zod schemas in shared/
   - **Editor safety**: no changes that break Markdown round-trip
   - **Separation**: draft vs published, API vs business logic, worker idempotency

3. Report findings as a structured review with severity levels:
   - 🔴 **Critical** — Must fix (security, data integrity)
   - 🟡 **Warning** — Should fix (architectural violation, missing audit)
   - 🔵 **Info** — Consider (style, optimization)
