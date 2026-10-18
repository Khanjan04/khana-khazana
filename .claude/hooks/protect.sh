#!/usr/bin/env bash
# PreToolUse hook: block agent edits to protected paths. Exit 2 blocks the tool call and
# feeds stderr back to Claude. Needs jq; if jq is missing we block (fail closed).
f=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty') || { echo "jq missing: blocking" >&2; exit 2; }
case "$f" in
  *test/golden/*|*test/totals.golden.test.js|*legacy/*)
    echo "BLOCKED: $f is protected. Fix the implementation, not the test." >&2; exit 2;;
  *server/migrations/0*)
    # committed migrations are immutable; a NEW numbered migration file is allowed
    if [ -e "$f" ]; then
      echo "BLOCKED: $f is a committed migration. Add a new numbered migration instead." >&2; exit 2
    fi;;
esac
exit 0
