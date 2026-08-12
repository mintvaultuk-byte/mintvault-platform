# Reviewer report — runtime reconciliation

**Scope:** production/main/Pass 1 lineage, Partner runtime/RLS/configuration and migration safety.
**Authority:** read-only review; received 2026-08-12.

## Accepted findings

- **PP2-F1 — BLOCKER, D/G.** Live Partner endpoints return `503` because
  `PARTNER_DATABASE_URL` does not target the same database as
  `MINTVAULT_DATABASE_URL`. Evidence: production `/health` `200`, two Partner
  endpoint `503` responses, and both Fly v1076 machines log the same topology
  rejection. `server/partner/db.ts:54-80` has no privileged fallback. The
  owner must set a same-`neondb`, restricted LOGIN URL; no secret value was read.
- **PP2-F3 — HIGH, E.** `migrations/0074_partner_submission_lifecycle_and_location_snapshot.sql`
  creates the location-snapshot trigger with an unqualified table reference and
  no fixed `search_path`. Commit `3df3e40e` contains an executable PostgreSQL
  regression and source-only repair. It must be integrated before 0074 could
  ever be applied; no migration will be applied by this task.
- **PP2-F2 — HIGH, B.** Pass 1 `7368b07e` is one commit ahead of current
  `origin/main` `864fadeda` and not integrated. Its authoritative server-grade
  boundary must be integrated and freshly proven.
- **PP2-F4 — HIGH before migration, E.** The exact production migration journal
  is unproven. Immediately before any future migration, use a redacted
  `BEGIN READ ONLY` journal query and compare exact filenames/checksums.

## Clean areas

- Production `b0de0880` is an ancestor of `origin/main`; live Fly v1076 has
  two healthy LHR machines.
- Partner mount is present and fails closed. The connected runtime user is
  checked for `rolbypassrls`; source and real-PostgreSQL tests reject an owner/
  BYPASSRLS credential.

## Not covered

Direct live `current_user`/`rolbypassrls` and journal reads, authenticated
Partner use, and every production/physical operation. The broken topology makes
the runtime-user query non-actionable until the owner performs the configuration
correction.
