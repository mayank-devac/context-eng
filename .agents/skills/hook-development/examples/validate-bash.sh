#!/bin/bash
# Example PreToolUse hook for validating Bash commands
# This script demonstrates bash command validation patterns
#
# Output contract: print the decision JSON to stdout and exit 0.
# (Exit 2 ignores stdout JSON and always blocks, so "ask" would never work.)
#
# The command is split into segments (; && || | & newlines, quotes, $( ), ( ),
# backticks) and the command word of each segment is checked. That catches
# chained commands (ls && rm -rf /), wrappers (sudo, xargs, env) and nested
# shells (bash -c "rm -rf /"), at the cost of flagging a quoted string that
# itself starts with a dangerous command.

set -euo pipefail
set -f # no globbing while splitting words

# Without jq we cannot read the input or build output: block (exit 2) rather than allow blindly.
if ! command -v jq >/dev/null 2>&1; then
  echo "validate-bash.sh: jq is required" >&2
  exit 2
fi

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

# Extract command; unreadable input is denied instead of crashing (a crash would let the tool run).
if ! command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  decide deny "Hook input was not valid JSON"
fi

# Nothing to validate
if [ -z "$command" ]; then
  exit 0
fi

# Writing to a device is dangerous; the harmless pseudo-devices are fine.
while IFS= read -r target; do
  [ -z "$target" ] && continue
  case "$target" in
    /dev/null|/dev/stdout|/dev/stderr|/dev/tty|/dev/fd/[0-9]*) ;;
    *) decide deny "Dangerous system operation detected: write to $target" ;;
  esac
done < <(printf '%s' "$command" | grep -oE '>[>|]?[[:space:]]*/dev/[^[:space:];&|)<>]*' | sed -E 's/^>[>|]?[[:space:]]*//' || true)

privileged=""
segments=$(printf '%s' "$command" | sed -E 's/(&&|\|\||\$\(|[;&|`"'"'"'()])/\n/g')

while IFS= read -r segment; do
  read -ra words <<< "$segment" || true
  i=0
  n=${#words[@]}

  # Skip wrappers and VAR=value prefixes to find the real command word.
  while [ "$i" -lt "$n" ]; do
    word=${words[$i]}
    case "$word" in
      sudo|doas)
        privileged="$word"
        i=$((i + 1))
        # sudo options; -u/-g/-C/-h/-p take a value
        while [ "$i" -lt "$n" ] && [[ "${words[$i]}" == -* ]]; do
          case "${words[$i]}" in -u|-g|-C|-h|-p) i=$((i + 1)) ;; esac
          i=$((i + 1))
        done
        ;;
      su)
        privileged="su"
        i=$((i + 1))
        ;;
      env|command|exec|nohup|time|nice|xargs|builtin)
        i=$((i + 1))
        while [ "$i" -lt "$n" ] && [[ "${words[$i]}" == -* ]]; do i=$((i + 1)); done
        ;;
      [A-Za-z_]*=*)
        i=$((i + 1))
        ;;
      *) break ;;
    esac
  done
  [ "$i" -ge "$n" ] && continue

  cmd=${words[$i]##*/} # /bin/rm -> rm
  args=("${words[@]:$((i + 1))}")

  case "$cmd" in
    rm)
      recursive=""
      force=""
      for arg in "${args[@]}"; do
        case "$arg" in
          --) break ;;
          --recursive) recursive=1 ;;
          --force) force=1 ;;
          --*) ;;
          -*)
            [[ "$arg" == *[rR]* ]] && recursive=1
            [[ "$arg" == *f* ]] && force=1
            ;;
        esac
      done
      if [ -n "$recursive" ] && [ -n "$force" ]; then
        decide deny "Dangerous command detected: rm -rf"
      fi
      ;;
    mkfs|mkfs.*)
      decide deny "Dangerous system operation detected: $cmd"
      ;;
    dd)
      for arg in "${args[@]}"; do
        if [[ "$arg" == if=* || "$arg" == of=* ]]; then
          decide deny "Dangerous system operation detected: dd"
        fi
      done
      ;;
  esac
done <<< "$segments"

# Privilege escalation anywhere in the command: let the user confirm
if [ -n "$privileged" ]; then
  decide ask "Command requires elevated privileges ($privileged)"
fi

# No objection: fall through to the normal permission flow
exit 0
