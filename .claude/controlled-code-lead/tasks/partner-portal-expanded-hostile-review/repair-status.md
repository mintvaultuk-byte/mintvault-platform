# REPAIR STATUS — per-card settlement + non-superuser proof

Start HEAD `fa94e752` · End HEAD `fa94e752` (**no commits created** — nothing pushed, merged,
deployed, applied or rolled back; no credits, no submissions; production untouched).

## Files

**Modified (9):** `client/src/pages/partner/dashboard.tsx`, `server/partner/definer-guard.ts`,
`server/partner/partner-submission-credit-lifecycle.ts`, `server/partner/submission-service.ts`,
`tests/helpers/partner-realistic-db.ts`, `tests/partner-g6d-migration-upgrade.test.ts`,
`tests/partner-portal-credit-view.test.ts`, `tests/partner-schema-parity.test.ts`,
`tests/partner-wallet-service.test.ts` — 573 insertions, 169 deletions.

**New (3):** `migrations/0042_partner_per_card_credit_settlement.sql`,
`migrations/rollback-0042-partner-per-card-credit-settlement.sql`,
`tests/partner-realistic-migrator-proof.test.ts`.

## Per-card design (reserve / consume / release)

| Stage | Behaviour |
|---|---|
| Unit of account | **(card row, ordinal)** — a card of `quantity` Q counts Q times, matching how `connector-import-service` expands rows when pricing, so credits and invoice reconcile |
| Card reference | `partner-submission-card:{cardId}:{ordinal}` — restores `uq_partner_credit_reserve_card_live` to its designed per-card purpose (not weakened) |
| Idempotency key | `partner-submission-credit:{submissionId}:{cardId}:{ordinal}` — deterministic, so retries are per-card no-ops |
| Reserve | N reservations in the acceptance transaction; a wallet that runs out partway rolls back the ENTIRE acceptance (no partial state) |
| Consume | ONE savepoint around the whole set — all-or-nothing; card 17 of 20 failing must not leave 1–16 consumed |
| Release | Every card released in the caller's transaction; refuses outright if any card is already consumed (no partial release of a cancelled submission) |
| Reconciliation gate | Settlement fails closed with `reservation_count_mismatch` unless `live reservations == expanded card units`. This is the self-policing invariant |
| Tenant safety | tenant + source are always predicates; distinct-card-reference check proves the per-card index was not bypassed |

Seven call sites audited. `findReservationForPartnerSubmission` → `findReservationsForPartnerSubmission`
(returns the live set, validating that historical rows are authorised recovery predecessors);
settlement, cancellation and replay all handle N. The recovery path already reuses the released
reservation's `card_reference`, so it is per-card correct unchanged.

## Migration decision: 0042

Inventory across **all refs** (`git log --all`): numbers 0001–0041 used, with 0019/0020/0033
duplicated historically and 0041 claimed twice (partner — applied on staging; catalogue —
unapplied everywhere). Free: **0028, 0029, 0042+**. Staging watermark 0041.

**0042 chosen. 0028/0029 rejected despite being free** — and this matters: 0042 *replaces a
function 0041 creates*. On a fresh database the runner sorts numerically, so a 0028 would execute
**before** 0041, and 0041 would then overwrite it with the old single-reservation body. A lower
number would be a silent correctness trap, not a cosmetic choice.

Consequence accepted: once 0042 is journalled, 0041's rollback guard (`> 41`) refuses. That is
correct ordering, not a defect — roll back 0042 first. Rollback script provided and tested.
0041 itself is untouched and its checksum ratchet is intact.

## Realistic non-superuser migrator — PROVEN

`tests/partner-realistic-migrator-proof.test.ts` — **12/12 pass.** Every migration now runs as
non-superuser `pn_migrator`. The harness reproduces Neon by granting the definer role
`WITH ADMIN TRUE, INHERIT FALSE, SET FALSE` **from the superuser**, so 0041's closing
`REVOKE ADMIN OPTION FOR ... FROM current_user` cannot remove a row it did not grant — the same
grantor asymmetry that makes the row survive in production. `pn_migrator` is also made the
DATABASE owner, because Neon's project owner is.

Proven: 0041 applies as non-superuser · provider ADMIN row survives with no SET/INHERIT · guard
passes the harmless row · guard rejects `partner_runtime` · `partner_runtime` cannot SET ROLE ·
**the deadlock reproduces** (migrator cannot `CREATE OR REPLACE` a definer-owned function) ·
the repair fixes it without enabling SET ROLE · revocation restores the pre-repair state ·
0042 applies and is idempotent · rollback works and re-apply after rollback works · the definer
gets SELECT on cards and no write access to cards/wallets/ledger.

**The harness immediately earned its keep: it caught a defect in my own proposed staging
statement.** `GRANT ... WITH INHERIT TRUE` silently defaults to `SET TRUE` in PostgreSQL 16+, so
the previously-proposed repair would have granted SET ROLE. Corrected to
`WITH INHERIT TRUE, SET FALSE`.

## Two false-comfort assertions corrected

- `partner-g6d-migration-upgrade`: asserted `migrator_memberships = 0`, achievable only under the
  superuser harness. Now asserts **no USABLE membership** (ADMIN row may exist; SET/INHERIT must not).
- Same file: asserted the migrator could not UPDATE `partner_submission_credit_holds`. Under the
  realistic harness the migrator OWNS that table — exactly as `neondb_owner` owns it on staging.
  Retargeted to the boundary that is real: neither partner runtime role can reach it at all.
- `partner-portal-credit-view`: `expect(...).not.toContain("99")` was a raw substring scan that
  fails at random when a UUID contains "99" (observed) and would equally miss a real leak. A
  tenant-isolation check must not be a coin flip; it now inspects the numeric fields.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npm run build` | **exit 0** |
| `git diff --check` | clean |
| Secret scan on added lines | none |
| ESLint (changed files) | **0 errors, 2 warnings — both pre-existing at HEAD** (verified by linting HEAD's version) |
| ESLint (repo-wide) | unusable: 15,591 problems from leftover `.claude/worktrees/**` agent worktrees — pre-existing environment issue, unrelated |
| Full suite `LC_ALL=C LANG=C` | **7 failed files / 2 failed tests / 3790 passed / 852 skipped** |

Baseline before this work was 7 failed files / 2 failed tests / 3778 passed / 852 skipped. The 7
failing files are **identical to baseline** (`auth-security-migration`, `rarity-structured-migration`,
`structured-variant-persistence`, `variant-line-consolidation`, `vq-backend`,
`vq-fetch-art-stored-pointer`, `vq-higgsfield-observability`) — all outside partner scope.
**Zero new failures; +12 passing.** 852 skipped are the env-gated integration suites needing CI
credentials. **No skipped test is counted as a pass anywhere.**

## Mutation matrix

| ID | Mutation | Required | Result |
|---|---|---|---|
| ROLE1 | Restore the old row-based contradictory membership guard | RED | ✅ **RED** — 3 tests failed incl. the 409 regression guard; tsc 0; restored byte-identically (sha256 verified); residue scan clean; re-run green |
| ROLE2 | Run 0041 as superuser instead of realistic migrator | RED or explicit harness guard failure | ✅ **Explicit harness guard failure** — `applyMigrationsRealistic must execute migrations as a NON-superuser; got 'postgres' with rolsuper=true`. Restored byte-identically; re-run green |
| CARD1 | Collapse N reservations into one | RED | ❌ **NOT PROVEN** |
| CARD2 | Reuse one per-submission reference for all cards | RED | ❌ **NOT PROVEN** |
| CARD3 | Consume only the first reservation | RED | ❌ **NOT PROVEN** |
| CARD4 | Release only the first reservation | RED | ❌ **NOT PROVEN** |
| CARD5 | Permit partial commit across N cards | RED | ❌ **NOT PROVEN** |
| CARD6 | Allow cross-tenant reservation settlement | RED | ❌ **NOT PROVEN** |
| LEDGER1 | Permit direct balance mutation | RED | ❌ **NOT PROVEN** |
| LEDGER2 | Remove append-only enforcement | RED | ❌ **NOT PROVEN** |

**Why the eight are not proven, stated plainly:** the multi-card PostgreSQL test suite does not
exist yet. Nothing currently exercises a 2+ card submission end to end, so a mutation that breaks
multi-card behaviour has no test to turn red. Running those mutations now would produce a
green suite and a false all-clear — the precise failure mode this whole engagement exists to
eliminate. They are recorded as NOT PROVEN rather than attempted.

ROLE1/ROLE2 were run under the full protocol: apply → tsc → record → restore byte-identically
(sha256 checked) → residue scan → re-run green.

## G6A–G6D invariants

Intact. The single-card lifecycle suite (31 tests) passes unchanged against the new N-aware code,
which is the regression proof that per-card did not disturb existing behaviour. Ledger remains
append-only (no UPDATE/DELETE/TRUNCATE against `partner_credit_ledger` anywhere); no stored
balance column; wallet-suite coverage of migration 0017's negative-balance trigger **restored**
(`<= 16` → `< 19`); Super Admin adjustments remain Super-Admin-only, append-only, reason- and
actor- and tenant-recorded, idempotency-keyed, with no direct balance update.

## Remaining work

1. **Multi-card PostgreSQL suite** (1 / 2 / 20 cards, quantity-expanded rows, insufficient
   balance, duplicate, concurrent, repeated settlement, repeated cancellation, cancellation
   before/after settlement, mixed states, corrupt/missing reservation, cross-tenant id, rollback
   mid-N, ledger totals == card count). Blocks CARD1–6 and LEDGER1–2.
2. Restore the deleted/inverted Super Admin ledger guard tests (`partner-dashboard-admin-ui`)
   with the now-intended adjustment path guarded rather than forbidden.
3. Push the branch for a CI run — 852 tests still skip locally and this branch has never run in CI.
4. Untouched HIGHs from the review: expiry batch-abort wedge, recovery-bricks-connector-release,
   dead "Change customer" button, COALESCE cannot-clear-fields, no draft reopen.

## Is the branch safe for the owner-gated staging role repair?

**Yes for the role repair.** It is one reversible statement, proven in the harness, and the guard
tolerates both pre- and post-repair states — so the repair can be executed and revoked
independently of any code deployment.

**No for deployment.** The per-card path is not multi-card-verified, and 0042 must not be applied
before the role repair (it will refuse, by design, with an instruction).
