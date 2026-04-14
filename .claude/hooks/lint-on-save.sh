#!/bin/bash
# PostToolUse hook: auto-lint TypeScript files after Write/Edit
# Reads the tool output JSON from stdin, checks if the file is .ts/.tsx, runs lint

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)

# Only act on TypeScript files
if [[ "$FILE_PATH" == *.ts ]] || [[ "$FILE_PATH" == *.tsx ]]; then
  # Check if eslint config exists (project is set up)
  if [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/eslint.config.js" ] || \
     [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/eslint.config.mjs" ] || \
     [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/.eslintrc.json" ]; then
    RESULT=$(npx eslint --no-error-on-unmatched-pattern --format json "$FILE_PATH" 2>/dev/null)
    ERROR_COUNT=$(echo "$RESULT" | jq '[.[].errorCount] | add // 0' 2>/dev/null)

    if [ "$ERROR_COUNT" -gt 0 ]; then
      ERRORS=$(echo "$RESULT" | jq -r '.[].messages[] | select(.severity == 2) | "\(.line):\(.column) \(.message) (\(.ruleId))"' 2>/dev/null)
      jq -n --arg errors "$ERRORS" --arg file "$FILE_PATH" '{
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: ("ESLint found errors in " + $file + ":\n" + $errors + "\nPlease fix these issues.")
        }
      }'
    fi
  fi
fi

exit 0
