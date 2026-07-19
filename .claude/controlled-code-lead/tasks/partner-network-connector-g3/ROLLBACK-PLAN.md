# Trusted Intake Connector — G3 Rollback Plan

## Schema rollback

`rollback-partner-connector-g3.sql` (new, tested): drops
`partner_connector_imports` and `partner_connector_customer_links`, revokes
the new `users`/`submissions`/`submission_items` grants from
`partner_connector_runtime`, drops the connector-scoped reference sequence,
removes the `0010` journal row. Touches no G1/G2 object, no Phase 1/2
object. Idempotent (`IF EXISTS` throughout, matching every prior rollback
script's convention).

## Preservation of valid MintVault submissions

**The rollback script never touches `submissions` or `submission_items`
rows themselves** — only the connector-owned provenance tables that
reference them. `partner_connector_imports.destination_submission_id` has
**no DB-level FK** to `submissions.id` (matching the repository's existing
"MintVault-internal tables carry no cross-schema FK" convention, already
established for the same reason in migration 0007 — see
`ROLLBACK-AND-RECONCILIATION.md` from G2), so there is no FK to `CASCADE`
on in the first place; a real customer's imported submission survives a
full connector rollback exactly as-is, indistinguishable from any other
submission in the table.

## Preservation of import evidence

Once `partner_connector_imports` is dropped, the *mapping* between a
Partner submission and its MintVault destination is lost — this is an
accepted, documented consequence of rolling back the schema that stores
that mapping, identical in kind to G1/G2 rollback already discarding
connector-processing history. The destination `submissions` row itself,
and any operational record an admin made about it through normal MintVault
tooling, is unaffected.

## Connector disablement

Unchanged: `partner_connector_enabled = false` (default) stops every
state-changing G3 function before it opens a transaction — including the
importer, which calls the same `assertConnectorActive()` guard every other
connector function already uses. No G3 code changes this default.

## Partial-import recovery

Per `IDEMPOTENCY-AND-TRANSACTION.md`'s crash-point table: because the
entire import is one transaction, there is no reachable "partially
imported" database state to recover from at the schema level — a rollback
performed while an import is (impossibly, given transaction semantics)
mid-flight would simply roll back that in-progress transaction too (it
was never committed), leaving zero trace, which is the same outcome as if
the rollback had run a moment earlier.

## No automatic deletion of destination submissions

Stated explicitly, matching `RECONCILIATION-RUNBOOK.md`'s forbidden-actions
list: neither the G3 rollback script nor any reconciliation logic built
this pass ever issues a `DELETE FROM submissions` or
`DELETE FROM submission_items` statement. Verified by grep of the rollback
script and every G3 service file as part of the pre-merge scope review.

## Post-rollback reconciliation

After a G3 rollback, any `submissions` rows the connector created remain in
the table as normal, ownerless-of-provenance rows — from MintVault's own
point of view they are just submissions, no different operationally from
one created through the normal checkout flow. Re-applying migration 0010
recreates the provenance tables but does **not** retroactively repopulate
mappings for submissions created before the rollback — that would require
re-deriving which `submissions` rows came from which Partner records with
no data left to do so, which is exactly the kind of guess this task
prohibits. This is an accepted limitation of the rollback, documented so a
future operator doesn't assume reapplying the migration restores lost
mapping history.

## Comprehensive rollback

`rollback-partner-network-phase1.sql` is extended (this pass) to drop G3's
tables first (deepest children in the dependency order: G3 → G2 → G1 →
Phase 2 → Phase 1), add `'0010_partner_connector_import.sql'` to the
journal cleanup list, and its header comment updated to
"Phase 1+2+G1+G2+G3 (migrations 0001–0010)". Same "preserves valid
MintVault submissions" guarantee applies transitively — the comprehensive
rollback removes Partner/connector schema only, never touches
`submissions`/`submission_items`/`users`.
