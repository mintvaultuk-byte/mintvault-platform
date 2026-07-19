# Trusted Intake Connector — G3F Provenance Evidence Model

## The limitation being resolved

G3E's RECONCILIATION-RUNBOOK.md disclosed: when a stale `reserved`
`partner_connector_imports` row is safely resumed after revalidation, the
importer re-verifies against the _latest_ validation run before creating the
destination (so the destination is never built from stale data — exactly-once
and correctness are unaffected), BUT the `partner_connector_imports` row's own
`validation_run_id`/`source_fingerprint`/`source_fingerprint_version` columns
are immutable by grant design and are never rewritten on resume. So a completed
mapping could record an _older_ run/fingerprint than the one that actually
authorised the destination. Audit ambiguity, not a safety failure.

## Chosen approach: **C — versioned append-only import-attempt evidence**

Add `partner_connector_import_attempts` (migration 0012): one immutable row
per **committed** import attempt outcome, recording the exact validation run
and fingerprint THAT attempt verified against. This makes the evidence chain
unambiguous without mutating any existing immutable row.

Rejected alternatives:

- **B (reservation_fingerprint + completion_fingerprint columns on the
  mapping)**: would require the runtime UPDATE grant to extend to a
  fingerprint column, weakening the deliberate immutability control G3
  established; and it captures only two points, not the full attempt history.
- **A (append a revalidation record but keep mutating nothing)**: essentially
  a subset of C; C generalises it to every attempt type.

## Why append-only INSERT-once (not started→completed UPDATE)

Following the G2 validation-run precedent: the importer does all its work,
then writes **one** attempt row at the committed terminal outcome, inside the
same transaction as the destination/stale-routing it records. Consequences:

- Pure append-only: runtime gets `SELECT, INSERT` only — **no UPDATE, no
  DELETE, no PUBLIC**. Immutability is DB-enforced, not conventional.
- A crashed/rolled-back attempt writes **no** attempt row — correct, because
  a rolled-back attempt authorised nothing and created nothing; there is no
  evidence to preserve. The retry writes its own row.
- Every _committed_ outcome (completed, stale, failed, reconciled, cancelled)
  is recorded exactly once. `started_at`/`completed_at` columns carry the
  duration; there is no persisted mutable "started" state to leak.

## Table shape (migration 0012)

`partner_connector_import_attempts`:
`id` uuid PK; `connector_record_id` uuid NOT NULL FK; `import_mapping_id` uuid
NULL FK (null for a pre-reservation stale attempt); `partner_organisation_id`,
`partner_submission_id`, `partner_handoff_id` uuid NOT NULL FK;
`validation_run_id` uuid NULL FK (the run THIS attempt verified — the
unambiguous "what authorised it"); `source_fingerprint` text NULL;
`source_fingerprint_version` integer NULL; `attempt_number` integer NOT NULL;
`attempt_type` text NOT NULL CHECK IN (initial, retry, resumed, reconciled,
manual); `claimant` text NULL; `outcome` text NOT NULL CHECK IN (started,
stale, failed, completed, reconciliation_required, cancelled);
`safe_error_code` text NULL; `destination_submission_id` integer NULL;
`started_at` timestamptz NOT NULL; `completed_at` timestamptz NULL;
`created_at` timestamptz NOT NULL DEFAULT now().

- `outcome = 'started'` is in the CHECK for forward-compat/vocabulary
  completeness but is never persisted by current code (see above).

## Uniqueness (no duplicate completed evidence)

Partial unique index
`uq_partner_connector_import_attempts_completed
  ON (connector_record_id) WHERE outcome = 'completed'`
— at most one `completed` attempt per connector, mirroring the exactly-once
destination guarantee. The code never attempts a second completed insert (the
importer's `already_completed` early-return skips writing a new attempt; the
connector row `FOR UPDATE` lock serialises concurrent attempts) — the partial
unique index is a DB backstop, not the primary control.

## Indexes

By `connector_record_id`, `import_mapping_id`, `validation_run_id`,
`destination_submission_id`, and `created_at`.

## Grants / security

`GRANT SELECT, INSERT ON partner_connector_import_attempts TO
partner_connector_runtime;` — no UPDATE/DELETE. No PUBLIC. `partner_runtime`
(the Partner-facing role) gets nothing. Role stays NOSUPERUSER/NOBYPASSRLS.

## Who writes attempt rows

- **importValidatedConnector** (`connector-import-service.ts`):
  - stale-source branch → appends `outcome='stale'` (with the fresh
    fingerprint it just computed and the latest run id) in the same commit as
    the connector→`validating` routing.
  - successful completion → appends `outcome='completed'` (with the latest
    run id + fingerprint that authorised the destination, and the
    `destination_submission_id`) in the same commit as the destination.
  - `already_completed` early return → appends **nothing** (no new attempt;
    the original completed row already records it — keeps "one completed per
    connector" true).
  - `attempt_type`: `resumed` if it resumed an existing `reserved` mapping,
    else `retry` if any prior attempt row exists for the connector, else
    `initial`.
- **completeFromExistingDestination** (`connector-reconciliation-service.ts`):
  if (and only if) no completed attempt row yet exists for the connector
  (e.g. a pre-table backfill/corruption case), appends a
  `attempt_type='reconciled', outcome='completed'` row; otherwise appends
  nothing.

## Backfill

**None required.** The connector has never run outside disposable-DB tests
(flag OFF), so there are zero real completed imports predating this table.
Fresh disposable databases start empty and accumulate attempt rows from the
first import onward. Documented explicitly so no silent backfill is assumed.

## Evidence-chain guarantee (what this proves)

For any imported connector: exactly one `completed` attempt row exists, and
its `validation_run_id`/`source_fingerprint` are the ones the destination was
actually built from (captured at completion time, not at original reservation
time). Every prior stale/failed attempt remains visible as its own row. The
old reservation row's fingerprint (possibly stale) is still present in
`partner_connector_imports` as historical evidence, but is no longer the sole
or authoritative record of what authorised the import — the completed attempt
row is. No historical row is ever overwritten.
