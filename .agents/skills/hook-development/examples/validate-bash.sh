#!/bin/bash
# Example PreToolUse hook for validating Bash commands
# This script demonstrates bash command validation patterns
#
# Output contract: print the decision JSON to stdout and exit 0.
# (Exit 2 ignores stdout JSON and always blocks, so "ask" would never work.)

set -euo pipefail

# Read input from stdin
input=$(cat)

# Print a PreToolUse decision (allow | deny | ask) with a reason, then exit 0.
# jq builds the JSON so quotes in the reason cannot break it.
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

# Extract command
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Nothing to validate
if [ -z "$command" ]; then
  exit 0
fi

# Check for obviously safe commands (quick approval)
if [[ "$command" =~ ^(ls|pwd|echo|date|whoami)([[:space:]]|$) ]]; then
  exit 0
fi

# Check for destructive operations
if [[ "$command" == *"rm -rf"* ]] || [[ "$command" == *"rm -fr"* ]]; then
  decide deny "Dangerous command detected: rm -rf"
fi

# Check for other dangerous commands
if [[ "$command" == *"dd if="* ]] || [[ "$command" == *"mkfs"* ]] || [[ "$command" == *"> /dev/"* ]]; then
  decide deny "Dangerous system operation detected"
fi

# Check for privilege escalation (whole word, so "sum" or "sudoku" do not match)
if [[ "$command" =~ ^(sudo|su)([[:space:]]|$) ]]; then
  decide ask "Command requires elevated privileges"
fi

# No objection: fall through to the normal permission flow
exit 0
