# Trusted Intake Connector — G3F Rollback Plan

## New schema this pass

Migration `0012_partner_connector_import_attempts.sql`, additive only:

- one new table `partner_connector_import_attempts` (append-only),
- its indexes and one partial unique index,
- `GRANT SELECT, INSERT` to `partner_connector_runtime` (no UPDATE/DELETE),
- possibly one hot-path index on an existing connector/import table if
  G3F-6's EXPLAIN evidence justifies it (added in the same migration, with
  its own drop in the rollback).

No new column on any existing table. No change to any MintVault-internal
table (`users`/`submissions`/`submission_items`).

## G3F-only rollback (`rollback-partner-connector-g3f.sql`)

- `DROP TABLE IF EXISTS partner_connector_import_attempts CASCADE;`
- drop any hot-path index this pass added to an existing table
  (`DROP INDEX IF EXISTS ...`);
- `DELETE FROM schema_migrations WHERE filename =
'0012_partner_connector_import_attempts.sql';`
- Never touches `users`/`submissions`/`submission_items` data, never touches
  `partner_connector_imports`/`_records`/`_events` data — only the new
  append-only evidence table and any new index. Idempotent (`IF EXISTS`).

## Refusal guard on the G3E rollback

`rollback-partner-connector-g3e.sql` gains a guard refusing to run while
migration 0012 is present (mirroring every earlier refusal guard in this
family) — 0012's table FK-references `partner_connector_records`/
`partner_connector_imports`/`partner_connector_validation_runs`, so rolling
back G3E first would orphan it. Run `rollback-partner-connector-g3f.sql`
first.

## Comprehensive rollback

`rollback-partner-network-phase1.sql` extended to drop
`partner_connector_import_attempts` first (deepest child) and add
`'0012_partner_connector_import_attempts.sql'` to the journal-cleanup list;
header updated to "Phase 1+2+G1+G2+G3+G3E+G3F (migrations 0001–0012)".

## Preservation guarantees

- **Imported MintVault destinations preserved.** No rollback script this
  pass issues any `DELETE`/`UPDATE` against `submissions`/`submission_items`.
  A destination the connector created survives a full connector teardown,
  indistinguishable from any other submission — only the connector-owned
  provenance/evidence tables are dropped.
- **Valid mappings preserved through a G3F-only rollback.**
  `partner_connector_imports` is untouched by the G3F-only rollback; only the
  new attempt-evidence table and any new index are removed. The mapping's own
  fingerprint columns remain exactly as before this pass — i.e. rolling back
  G3F returns the audit model to the G3E state (mapping-fingerprint-only, with
  the documented resume ambiguity), which is a safe, known prior state.
- **No destructive rollback of imported destinations**, ever.

## Worker-pool configuration rollback

The worker pool (`connector-worker.ts`) and the opt-in
`statement_timeout`/`lock_timeout`/`connectionTimeoutMillis` env settings are
inert unless invoked/configured; there is nothing stateful to roll back —
removing the branch is a code revert, not a data operation. Production
behaviour is unchanged when the env vars are unset (the pass's default).

## Disabling connector processing

Unchanged: `partner_connector_enabled = false` (the default) stops every
state-changing function — including the worker pool, which calls
`assertConnectorActive` before every claim. No G3F code flips this default.
