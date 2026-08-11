#!/usr/bin/env bash
# Run the COMPLETE critical Partner assurance matrix in one provisioned environment.
#
# Two passes, because one alone is not the matrix:
#   PASS 1  the full repository suite under the complete CI environment, followed by all six
#           execution-floor assertions — byte-for-byte what CI's `check` job runs. A suite that
#           silently skips looks identical to a suite that passed in an exit code; the floors are
#           what turn that back into a red run.
#   PASS 2  the per-suite Partner matrix (scripts/ci/run-partner-suite.mjs --all) — every critical
#           suite in its OWN vitest process with ONLY its own database pinning. This is the only
#           way the accounting-topology suites can run at all, and a skip or an environment abort
#           in any of them is a hard failure, not a local convenience.
#
# ORDER IS LOAD-BEARING, and was wrong on the first attempt. The full-repository pass runs the
# migration suites against whatever the database already contains; the per-suite runner DROPs and
# CREATEs each suite's database first (recreateDatabase()). Running the per-suite matrix first
# therefore left objects behind that made three migration suites abort in the full pass —
# "cannot change return type of existing function" (partner-definer-ownership) and "duplicate key
# value violates unique constraint uq_partner_contacts_primary" (partner-management-migration).
# Both suites are GREEN in the per-suite pass, which is what identified it as an ordering artefact
# of this harness rather than anything about the source. Full pass first = virgin databases, exactly
# as CI has them; the per-suite pass is immune to prior state by construction.
#
# Everything is recorded as JSON so Matrix A and Matrix B can be compared mechanically rather than
# by eye.
set -euo pipefail

LABEL="${1:?usage: run.sh <A|B>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd)"
EVID="$HERE/../evidence"
RUNDIR="$EVID/run-${LABEL}"
mkdir -p "$RUNDIR/per-suite"
cd "$REPO"

eval "$(node "$HERE/derive-env.mjs" "$LABEL" shell)"

echo "=== [$LABEL] ENVIRONMENT FINGERPRINT ==="
echo "  pg17 : $(node -e 'console.log(new URL(process.env.PARTNER_RLS_DB).host)')"
echo "  admin: $PARTNER_MATRIX_PG17_USER   prefix: $PARTNER_MATRIX_DB_PREFIX"
echo "  minio: $PARTNER_REAL_R2_PROOF_ENDPOINT"

echo
echo "############ [$LABEL] PASS 1 — full repository suite under the CI environment ############"
set +e
npx vitest run --reporter=default --reporter=json --outputFile.json="$RUNDIR/full-report.json" 2>&1 | tee "$RUNDIR/pass1-full.log"
FULL_STATUS=${PIPESTATUS[0]}
set -e
echo "full-suite exit=$FULL_STATUS" | tee "$RUNDIR/pass1-full.status"

echo
echo "############ [$LABEL] EXECUTION FLOORS (a skip must not look like a pass) ############"
FLOOR_FAIL=0
for script in assert-connector-suites-executed \
              assert-partner-management-suite-executed \
              assert-partner-pilot-suites-executed \
              assert-partner-rbac-suites-executed \
              assert-partner-rls-suite-executed \
              assert-partner-auth-suites-executed; do
  echo "--- $script"
  if ! node "scripts/ci/${script}.mjs" "$RUNDIR/full-report.json" 2>&1 | tee -a "$RUNDIR/floors.log"; then
    FLOOR_FAIL=1
  fi
done
echo "floors exit=$FLOOR_FAIL" | tee "$RUNDIR/floors.status"

echo
echo "############ [$LABEL] PASS 2 — per-suite critical Partner matrix ############"
set +e
node scripts/ci/run-partner-suite.mjs --all --json "$RUNDIR/per-suite" 2>&1 | tee "$RUNDIR/pass2-matrix.log"
MATRIX_STATUS=${PIPESTATUS[0]}
set -e
echo "per-suite-matrix exit=$MATRIX_STATUS" | tee "$RUNDIR/pass2-matrix.status"

echo
echo "############ [$LABEL] STORAGE AFTER ############"
set +e
node "$HERE/storage-inventory.mjs" "$LABEL" after | tee "$EVID/storage-after-${LABEL}.json"
STORAGE_STATUS=${PIPESTATUS[0]}
set -e
echo "storage-after exit=$STORAGE_STATUS"

echo
echo "############ [$LABEL] SUMMARY ############"
node "$HERE/summarise.mjs" "$LABEL" "$MATRIX_STATUS" "$FULL_STATUS" "$FLOOR_FAIL" "$STORAGE_STATUS" \
  | tee "$EVID/summary-${LABEL}.json"
