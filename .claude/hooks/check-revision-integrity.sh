#!/bin/bash
# PostToolUse hook: warn if editing page-related files without revision pattern
# Checks that mutations to pages go through the revision system

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)

# Only check API route and service files
if [[ "$FILE_PATH" == *"/routes/pages"* ]] || [[ "$FILE_PATH" == *"/services/page"* ]]; then
  # Check if there's a direct UPDATE on pages table content without going through revision
  if echo "$CONTENT" | grep -qiE '(UPDATE\s+pages\s+SET\s+.*(content|title|slug))|\.update\(\s*pages\s*\).*content' 2>/dev/null; then
    if ! echo "$CONTENT" | grep -qi 'revision' 2>/dev/null; then
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "WARNING: This code appears to update page content directly without creating a revision. WekiFlow requires ALL page mutations to go through the revision system. Please ensure a new page_revision is created for every content change."
        }
      }'
    fi
  fi
fi

exit 0
