#!/bin/bash
# Example PreToolUse hook for validating Write/Edit operations
# This script demonstrates file write validation patterns
#
# Output contract: print the decision JSON to stdout and exit 0.
# (Exit 2 ignores stdout JSON and always blocks, so "ask" would never work.)

set -euo pipefail

# Read input from stdin
input=$(cat)

# Print a PreToolUse decision (allow | deny | ask) with a reason, then exit 0.
# jq builds the JSON so quotes in the file path cannot break it.
decide() {
  jq -n --arg decision "$1" --arg reason "$2" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: $decision,
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Extract file path
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Nothing to validate
if [ -z "$file_path" ]; then
  exit 0
fi

# Check for path traversal
if [[ "$file_path" == *".."* ]]; then
  decide deny "Path traversal detected in: $file_path"
fi

# Check for system directories
if [[ "$file_path" == /etc/* ]] || [[ "$file_path" == /sys/* ]] || [[ "$file_path" == /usr/* ]]; then
  decide deny "Cannot write to system directory: $file_path"
fi

# Check for sensitive files: let the user confirm instead of blocking
if [[ "$file_path" == *.env ]] || [[ "$file_path" == *secret* ]] || [[ "$file_path" == *credentials* ]]; then
  decide ask "Writing to potentially sensitive file: $file_path"
fi

# No objection: fall through to the normal permission flow
exit 0
