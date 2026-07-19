# Trusted Intake Connector — G3F Final Blocker Remediation

Narrow corrective pass after the Final Release Authority returned MERGE
BLOCKED on four findings. Starting origin/main `d5caf4f1` (unchanged), source
branch `feat/partner-network-connector-g3f-final-scale`, starting HEAD
`8d1c42f6`. No architecture change, no G4, no deploy, no flag flip.

## Blocker 1 — three speculative indexes in migration 0012

- **Verified** by code search: no production/reconciliation/support/audit
  query filters or joins `partner_connector_import_attempts` by
  `import_mapping_id`, `validation_run_id`, or `destination_submission_id`
  (only `connector_record_id` + `outcome='completed'` are queried, in
  `connector-import-service.ts` and `connector-reconciliation-service.ts`).
- **Fix:** remove `idx_partner_connector_import_attempts_mapping`, `_run`,
  `_destination` from migration 0012. Retain only the evidence-backed
  `idx_partner_connector_import_attempts_connector` (history lookup) and the
  `uq_partner_connector_import_attempts_completed` partial unique (exactly-once
  completed-evidence protection). Edit 0012 directly (unmerged, undeployed —
  no corrective migration for a local-only mistake).
- **Files actually updated (verified against `git diff 8d1c42f6..HEAD`):**
  migration 0012, query-plan test (add absence + retained-inventory assertions),
  and PERFORMANCE-RESULTS.md (retained/removed index inventory).
- **Files reviewed and deliberately NOT changed:** PROVENANCE-EVIDENCE-MODEL.md,
  ROLLBACK-PLAN.md, and FINAL-CONNECTOR-SAFETY-GATE.md needed no edit — the
  rollback scripts DROP the whole `partner_connector_import_attempts` table via
  CASCADE (which removes any index automatically), and ROLLBACK-PLAN.md's
  existing wording ("any new index are removed") already covers the trimmed set,
  so removing three `CREATE INDEX` lines requires no rollback/plan change. 0013
  is unaffected; migration-idempotency/journal/parity are unchanged since no
  migration file is added or removed.
- **Proving test:** `partner-connector-query-plan.test.ts` asserts the three
  index names are ABSENT after migration, the retained two are PRESENT, and
  the hot-path queries still avoid a seq scan.

## Blocker 2 — overstated evidence documents

- **PERFORMANCE-RESULTS.md:** the "no index added speculatively" claim was
  false. Corrected to state the retained index inventory, each retained
  index's exact query path, the three removed indexes + why, and that numbers
  describe a controlled local test environment (not production throughput).
- **FAILURE-INJECTION-MATRIX.md:** rewritten so every row carries exactly one
  status — EXECUTED AND PROVEN / STRUCTURALLY PROVEN / DOCUMENTED LIMITATION /
  DEFERRED. Rows describing non-existent hook points (`after_claim`,
  `after_lease_renewal`, `after_reference_allocation`) are re-labelled
  STRUCTURALLY PROVEN or DOCUMENTED LIMITATION (no false "executed hook" claim).
  The three real-but-previously-omitted hook points (`before_validation_recheck`,
  `after_validation_recheck`, `before_mapping_completion`) are added to the
  executed `ROLLBACK_POINTS` so their EXECUTED AND PROVEN rows are truthful.

## Blocker 3A — append-only runtime permission proof

- **Fix:** add a real-Postgres permission test using the actual
  `partner_connector_runtime` role: INSERT/SELECT succeed; UPDATE/DELETE/
  TRUNCATE/ALTER/DROP/ownership-transfer/self-grant all fail; PUBLIC has no
  privilege; runtime does not own the table; runtime privileges are narrower
  than the owner. The table has NO RLS (same as sibling connector tables —
  tenant isolation is service-level via `connector_record_id` scoping); this is
  tested and documented precisely, not claimed as RLS.

## Blocker 3B — resumed import uses the newer fingerprint

- **Fix:** add one end-to-end test: validate (run A / fingerprint A) → seed a
  forced `reserved` attempt/mapping carrying fingerprint A → mutate source →
  revalidate (run B / fingerprint B, asserted ≠ A) → resume import → assert via
  `getImportAttempts` that the OLD attempt still holds run A/fingerprint A
  (unchanged), a NEW completed attempt holds run B/fingerprint B, the
  destination links to attempt B, exactly one destination/mapping/completed
  attempt exist, retry converges, no historical overwrite, runtime cannot
  update/delete either attempt row, and no forbidden side effect occurred.

## Blocker 4 — bounded transient claim retry

- **Fix:** `connector-worker.ts` classifies claim outcomes (no work / flag-off
  / emergency-stop / shutdown / transient / permanent). A transient claim error
  now retries with bounded count + bounded backoff (not a permanent worker
  exit); permanent errors exit safely; shutdown/flag/stop take precedence. New
  `claimRetries` + `claimRetryExhaustions` counters in the result. Numeric
  config (`maxClaimRetries`, `claimBackoffMs`) validated to finite non-negative
  integers.
- **Proving tests:** transient-then-success, retry-exhaustion, permanent-error,
  shutdown-during-retry, claim-contention, client-release — in the fault test.

## Disposition

All four blockers fixed; see the focused-verification + re-review + re-audit
sections of the final report for proof.
