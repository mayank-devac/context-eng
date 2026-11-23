#!/bin/bash
# Example PreToolUse hook for validating Write/Edit operations
# This script demonstrates file write validation patterns
#
# Output contract: print the decision JSON to stdout and exit 0.
# (Exit 2 ignores stdout JSON and always blocks, so "ask" would never work.)

set -euo pipefail

# Without jq we cannot read the input or build output: block (exit 2) rather than allow blindly.
if ! command -v jq >/dev/null 2>&1; then
  echo "validate-write.sh: jq is required" >&2
  exit 2
fi

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

# Extract file path; unreadable input is denied instead of crashing (a crash would let the tool run).
if ! file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null); then
  decide deny "Hook input was not valid JSON"
fi

# Nothing to validate
if [ -z "$file_path" ]; then
  exit 0
fi

# Path traversal: ".." as a whole path segment (a..b.md is a normal name)
if [[ "$file_path" =~ (^|/)\.\.(/|$) ]]; then
  decide deny "Path traversal detected in: $file_path"
fi

# System directories
case "$file_path" in
  /etc/*|/sys/*|/usr/*|/proc/*|/boot/*|/dev/*|/bin/*|/sbin/*|/lib/*|/lib64/*)
    decide deny "Cannot write to system directory: $file_path"
    ;;
esac

# Sensitive files: let the user confirm instead of blocking
name=${file_path##*/}
lower=$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')
case "$name" in
  .env.example|.env.sample|.env.template) ;; # committed templates, no real secrets
  .env|.env.*|*.env)
    decide ask "Writing to potentially sensitive file: $file_path"
    ;;
esac
case "$lower" in
  *secret*|*credential*|*/.ssh/*|*/.aws/*|*/.gnupg/*|*.pem|*.key|*/id_rsa*|*/id_ed25519*|*/.netrc|*/.npmrc|*/.pypirc)
    decide ask "Writing to potentially sensitive file: $file_path"
    ;;
esac

# No objection: fall through to the normal permission flow
exit 0
