# Phase 0.5 — Database Migration Safety (Proposal only — NOT implemented)

**Date:** 2026-07-17
**Status:** PROPOSAL. No code, config, schema, or migration written. Awaiting approval.
**Trigger:** Confirmed destructive-schema hazard in `drizzle.config.ts`, now measured against LIVE PROD.

---

## Evidence base (verified, read-only)

- `drizzle.config.ts:9` `schema: "./shared/schema.ts"` — drizzle introspects ONLY this one file.
- `drizzle.config.ts:16` `tablesFilter: ["!vq_*"]` — the ONLY tables excluded from the whole-DB diff are `vq_*`.
- `shared/schema.ts` defines **62** tables.
- **PROD** (`<database_name>`, PostgreSQL 17.10, read-only inspection 2026-07-17): **115** tables total; **89** non-`vq_*`.
- **No migration journal exists** on prod: `schema_migrations` and `__drizzle_migrations` both absent (`to_regclass` → null).
- **RLS: 0 tables** on prod (confirms the app-layer-only isolation finding).

## 1. Why `db:push` currently proposes deleting live tables

`drizzle-kit push` computes the difference between the **desired** schema (everything defined in `shared/schema.ts`) and the **actual** database, then emits SQL to make actual match desired. Any table that exists in the database but is **not** represented in `shared/schema.ts` is treated as "should not exist" → a `DROP TABLE`. The `tablesFilter` is the only guard, and it currently protects **only** `vq_*`. Every other live table that was created by a mechanism other than `shared/schema.ts` — the runtime `migrate*()` boot functions and the hand-applied `migrations/*.sql` files — is invisible to the desired schema and therefore a drop candidate. There is no migration journal, so nothing else stands between an interactive `db:push` confirmation and the drop.

## 2. Every table at risk (live on PROD, absent from `shared/schema.ts`, not `vq_*`) — **30 tables**

**Money / payments / credits (catastrophic):**
`member_credits`, `estimate_credits`, `reholder_credits`, `stripe_webhook_events` (payment idempotency), `promo_codes`, `promotions`, `vault_club_subscriptions`, `vault_club_events`, `vault_club_consents`, `subscription_reminders`, `value_protection_tiers`, `estimate_free_uses`

**Auth / sessions (locks everyone out):**
`session`, `sessions` (both live), `pin_attempts`, `pin_reset_tokens`, `pending_switch_nonces`

**Grading / AI data:**
`grading_records`, `grading_sessions`, `ai_accuracy_log`, `ai_grade_corrections`, `ai_override_audit`

**Catalogue / misc:**
`custom_sets`, `custom_variants`, `tcgdex_sets`, `set_review_decisions`, `audit_logs` (plural — coexists with `audit_log`), `bot_logs`, `bot_seen`, `bot_settings`

> Dropping `stripe_webhook_events` + `member_credits` + `promo_codes` alone breaks payment idempotency, credits, and discounts simultaneously. Dropping `session`/`sessions` logs out every admin, staff, and customer. This is a data-loss extinction event gated only by a human clicking "yes" at an interactive prompt.

## 3. Current Drizzle schema coverage

- Main config → `shared/schema.ts` (62 tables), excludes `vq_*` only.
- VQ config → `drizzle-vq.config.ts`, `tablesFilter: ["vq_*"]` (correctly isolated, both directions).
- **Coverage gap:** 30 live non-vq tables are managed by runtime `migrate*()` functions (`server/account-auth.ts`, `server/staff.ts`, `server/grader.ts`, `server/marketplace-schema.ts`, `server/webhookHandlers.ts`, `server/vault-club.ts`, etc.) or by hand-applied `migrations/*.sql`, none of which drizzle can see.

## 4. Safe ownership strategy for existing tables

Two viable strategies; **recommend Strategy B for the pilot, migrate toward A over time.**

- **Strategy A — schema-as-truth (ideal, larger):** define all 30 tables in `shared/schema.ts` (or an imported barrel) so drizzle's desired schema matches reality. Highest fidelity, but requires accurately reverse-engineering 30 tables' columns/constraints from the live DB, and risks drizzle proposing column-level ALTERs where the hand-SQL differs subtly from a drizzle definition.
- **Strategy B — explicit exclusion allowlist (safe, immediate):** extend `tablesFilter` to exclude every unmanaged family in addition to `vq_*`, e.g. `["!vq_*", "!partner_*", "!member_credits", "!estimate_credits", ...]` or a prefix scheme. Zero risk of touching those tables; the cost is that drizzle no longer manages them (they stay hand-SQL/runtime-migrate, which is already true). This is the same pattern already trusted for `vq_*`.

Partner tables get their **own** config (`drizzle-partner.config.ts`, `tablesFilter: ["partner_*"]`) and `"!partner_*"` added to the main filter — so the partner family is never in the main diff.

## 5. Production policy prohibiting direct `db:push`

- **Hard rule:** `db:push` / `drizzle-kit push` is **never** run against staging or production. It remains a local-disposable-DB-only tool (schema prototyping).
- Enforce in three places: (a) document in `CLAUDE.md` and `protected-systems.md`; (b) the `db:push` npm script gains a guard that refuses to run if the target host matches a staging/prod host pattern (`<STAGING_NEON_HOST>`, `<PROD_NEON_HOST>` — actual endpoint IDs held only in env/Fly secrets, redacted here) unless `ALLOW_DANGEROUS_PUSH=1` is explicitly set; (c) the advisory protected-action hook already flags `db:push` — keep it.

## 6. Migration-only production workflow

- All prod/staging schema changes go through **numbered, hand-reviewed SQL files** applied via a single runner, never `push`.
- Introduce a `schema_migrations` journal table (id, filename, checksum, applied_at, applied_by) written by the runner, so "has file N run on this host?" becomes answerable — closing the current no-journal drift gap.
- Runner is idempotent (skips already-applied files by checksum), prints a dry-run plan, and requires explicit confirmation + owner approval per the protected-actions rule.
- Every migration file ships with a paired rollback file (already the partial convention in `migrations/rollback-*.sql`).

## 7. Destructive-SQL detection

- A preflight linter scans any migration file (and any `db.execute` diff) for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER ... DROP`, and unqualified `UPDATE`. Any hit blocks auto-apply and requires explicit owner sign-off with a stated reason.
- Upgrade the advisory hook (`.claude/hooks/protected-action-guard.sh`) toward the blocking mode already designed in `HOOK-UPGRADE-ROADMAP.md` to also catch wrapper forms (`npx tsx …apply-migrations…`, `safe-deploy.sh`) — governance version bump, owner-approved.

## 8. Preflight safeguards

Before any migration is applied to a real host: (1) confirm target host identity and print it; (2) dry-run the SQL inside a transaction with `SET default_transaction_read_only = on` to catch write attempts in review contexts; (3) run the destructive-SQL linter (#7); (4) snapshot the affected tables' row counts before/after; (5) verify the migration journal to prevent double-apply; (6) require the live-column inventory check from `mintvault-db-migration-discipline` (validate SQL against the live DB, not just `tsc`).

## 9. Disposable-database validation

Reuse the CI pattern (`ci.yml:43-66`): a throwaway local Postgres whose URL is asserted to be `127.0.0.1:55432/...` before any `drizzle-kit push --force` runs. All schema prototyping and the full migration sequence are validated against this disposable DB first. The safety assertion (refuse unless both URLs are provably the disposable local DB) is the guard that makes `push` acceptable **only** there.

## 10. Rollback procedure

- Each migration file has a paired, tested rollback SQL file.
- Application rollback stays image-pin redeploy (`scripts/safe-deploy.sh` captures the prior image).
- For schema rollback: apply the paired down-migration via the same runner; where a change is destructive-forward (rare, owner-gated), rely on Neon point-in-time recovery — **which must be verified as enabled first** (currently only asserted in a runbook, not confirmed).
- Rollback rehearsal on the disposable DB is part of the migration's definition-of-done.

## 11. Exact files expected to change (Phase 0.5, when approved)

**New:**
- `scripts/db/migrate.ts` — idempotent, journalled, dry-run-capable migration runner
- `scripts/db/lint-destructive-sql.ts` — destructive-SQL preflight linter
- `migrations/0001_create_schema_migrations_journal.sql` — the journal table (additive, no risk)
- `tests/db-migration-safety.test.ts` — see #12

**Modified (minimal, additive):**
- `drizzle.config.ts` — extend `tablesFilter` to exclude every unmanaged non-vq family (Strategy B)
- `package.json` — guard the `db:push` script against staging/prod hosts; add `db:migrate` script
- `CLAUDE.md` + `.claude/controlled-code-lead/protected-systems.md` — document the no-push-to-prod policy

**Explicitly NOT changed:** `shared/schema.ts` (no table definitions added in Phase 0.5 under Strategy B), any application code, any payment/grading/credit logic, any VQ file.

## 12. Exact tests to add

- **Config guard test:** assert `tablesFilter` excludes every table in the at-risk list of 30 (fails if a new unmanaged table appears without exclusion).
- **Destructive-SQL linter tests:** feeds crafted SQL (`DROP TABLE x`, `DELETE FROM y`, unqualified `UPDATE`, `ALTER ... DROP COLUMN`) and asserts each is flagged; feeds safe additive SQL and asserts it passes.
- **Runner journal tests (against disposable DB):** apply a migration twice → second run is a no-op; checksum mismatch on a previously-applied file → hard error.
- **Host-guard test:** `db:push` script invoked with a staging/prod-shaped URL exits non-zero without `ALLOW_DANGEROUS_PUSH`.
- **Drift-report test:** compares disposable-DB table list to `shared/schema.ts` + exclusion list and reports unmanaged tables (informational, non-gating).

## 13. Proof that payments, credits, certificates, grading and Vault Quest remain untouched

- **Strategy B changes NO table** — it only *adds names to an exclusion list*, which makes drizzle touch **fewer** tables, never more. The 30 at-risk tables (incl. all payment/credit/subscription tables) move from "drop candidate" to "explicitly ignored."
- **No `shared/schema.ts` table definitions are added or changed** in Phase 0.5, so no drizzle-generated ALTER can reach `certificates`, `submissions`, `member_credits`, `stripe_webhook_events`, `promo_codes`, or any grading table.
- **VQ** is already isolated by `drizzle-vq.config.ts`; Phase 0.5 does not touch that config or any `vq_*` table.
- **No migration is executed** in Phase 0.5 except the additive `schema_migrations` journal table (creates one new empty table, drops/alters nothing) — and only after owner approval, applied by the new runner, dry-run first.
- **Application code paths for payment, credit issuance, cert allocation, grading, and VQ are not edited** — the runner and linter are new standalone scripts; the only app-adjacent edits are the `db:push` host guard and the `tablesFilter` allowlist.
- Regression gates before sign-off: `npm run check`, full `npm test` (incl. MVGS regression suite), `npm run lint`, `npm run build` — all must stay green.

---

**Phase 0.5 is a proposal only. Nothing above has been implemented. Awaiting approval.**
