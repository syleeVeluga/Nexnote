#!/bin/bash
# PreToolUse hook: block raw SQL string interpolation in Bash commands
# Prevents SQL injection by catching string concatenation in queries

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Check for SQL string interpolation patterns (template literals with SQL keywords)
if echo "$COMMAND" | grep -qiE '(INSERT|UPDATE|DELETE|SELECT|DROP|ALTER|CREATE)\s.*\$\{' 2>/dev/null; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked: SQL command with string interpolation detected. Use parameterized queries only to prevent SQL injection."
    }
  }'
  exit 0
fi

exit 0
