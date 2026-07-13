#!/usr/bin/env bash
# Test: governance state survives a session restart.
#
# Governance state (task ledger, issue register, deployment state, protected
# systems) is file-based under .claude/ — persistence means: written to disk,
# re-readable by a brand-new process with no shared memory. We simulate the
# restart by writing in one shell process and reading back in a separate,
# fresh shell process.
#
# Never mutates anything outside .claude/governance-tests/.tmp (cleaned up
# afterwards). Also verifies the live protected-systems file already
# persists on disk.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$ROOT/.claude/governance-tests/.tmp"
FAIL=0

rm -rf "$TMP"
mkdir -p "$TMP/session-sim"

# --- task ledger round-trip across "restart" ---
LEDGER="$TMP/session-sim/task-ledger.md"
MARKER="ledger-marker-$$-line"
bash -c "cp '$ROOT/.claude/skills/controlled-code-lead/templates/task-ledger.md' '$LEDGER' && printf '\n<!-- %s -->\n' '$MARKER' >> '$LEDGER'"

# fresh process, no inherited variables beyond the path
if bash -c "grep -q '$MARKER' '$LEDGER'"; then
  echo "ok: task ledger persists across process restart"
else
  echo "FAIL: task ledger did not survive re-read from a fresh process"
  FAIL=1
fi

# --- issue register round-trip across "restart" ---
REGISTER="$TMP/session-sim/issue-register.md"
ROW="| F99 | persistence-test-finding-$$ | low | confirmed | \`test:L1\` | H | deferred | self-test row |"
bash -c "cp '$ROOT/.claude/skills/controlled-code-lead/templates/issue-register.md' '$REGISTER' && printf '%s\n' '$ROW' >> '$REGISTER'"

if bash -c "grep -q 'persistence-test-finding-$$' '$REGISTER'"; then
  echo "ok: issue register persists across process restart"
else
  echo "FAIL: issue register did not survive re-read from a fresh process"
  FAIL=1
fi

# --- the LIVE governance state already on disk is readable ---
for live in \
  "$ROOT/.claude/controlled-code-lead/protected-systems.md" \
  "$ROOT/.claude/project-memory.md"
do
  if [ -s "$live" ]; then
    echo "ok: live state file present and non-empty: ${live#$ROOT/}"
  else
    echo "FAIL: live state file missing/empty: ${live#$ROOT/}"
    FAIL=1
  fi
done

rm -rf "$TMP"
exit "$FAIL"
