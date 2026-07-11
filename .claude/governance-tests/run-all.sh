#!/usr/bin/env bash
# Governance self-test runner (governance v1.1).
#
# Validates the governance system itself: reviewer read-only guarantees,
# hook detection patterns, state persistence, and governance file integrity.
#
# SAFETY: these tests never touch production, staging, any database, any
# remote, or any file outside .claude/governance-tests/.tmp. They are pure
# local static checks plus invocations of the advisory hook with fake JSON.
#
# Run:  bash .claude/governance-tests/run-all.sh
# Exit: 0 if all tests pass, 1 otherwise.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0

for t in "$DIR"/test-*.sh; do
  echo "=== $(basename "$t") ==="
  if bash "$t"; then
    echo "--- $(basename "$t"): PASS"
  else
    echo "--- $(basename "$t"): FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    continue
  fi
  TOTAL_PASS=$((TOTAL_PASS + 1))
done

echo
echo "==============================================="
echo "Governance self-test summary: ${TOTAL_PASS} suite(s) passed, ${TOTAL_FAIL} failed"
echo "==============================================="

[ "$TOTAL_FAIL" -eq 0 ]
