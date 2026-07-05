#!/bin/bash
# PreToolUse hook: block Edit/Write/NotebookEdit/MultiEdit targeting paths
# outside the ichigo project folder. Requested by the project owner as a
# permanent guardrail (see memory: feedback-ichigo-scope-lock).
set -euo pipefail

ALLOWED_PREFIX="/Users/kuramochikeito/Desktop/web3.0/ichigo/"

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

# No file path in this tool call (shouldn't happen for these matchers) -> allow.
if [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  "$ALLOWED_PREFIX"*)
    exit 0
    ;;
esac

jq -n --arg path "$file_path" --arg prefix "$ALLOWED_PREFIX" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("ichigoフォルダ(" + $prefix + ")の外は編集できません: " + $path)
  },
  systemMessage: ("🚫 ichigoフォルダの外は編集できません: " + $path)
}'
exit 0
