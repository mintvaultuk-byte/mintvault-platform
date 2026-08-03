# KEEP / REPAIR / REVERT classification — partner-portal-expanded-hostile-review

Branch `psp/partner-rbac-hybrid` @ `fa94e752`, baseline `e0a2b571`. 50 files, +7055 / −798.
**Nothing in this document has been implemented.** It is the Stage 4 proposal, awaiting owner
decisions on the three load-bearing questions in the final report.

## Summary

| Verdict | Files | Rationale |
|---|---|---|
| KEEP | 27 | Sound work, invariants intact, no protected system weakened |
| REPAIR | 18 | Useful work with contained defects |
| REVERT | 2 | Duplicate/unjustified scope |
| BLOCKED ON OWNER | 3 | Cannot be classified until the credit-unit question is answered |

---

## REVERT (2)

| File | Reason |
|---|---|
| `tests/partner-dashboard-admin-ui.test.ts` (partial) | Two read-only guard tests were DELETED and INVERTED (`expect(PAGE).not.toContain("useMutation")` → `toContain`). Revert the deletion; the new mutation path needs guards ADDED, not the old ones removed. Owner sign-off needed on the capability change itself. |
| `migrations/0041…sql` line 128-129 (`deleted_at` column) | Zero application writers. All three readers use `to_jsonb(i)->>'deleted_at'` specifically so they tolerate its absence. Scope the migration did not need. **Cannot be reverted in place — the migration is applied and immutable.** Carry as a documented no-op. |

## REPAIR (18)

**Credit lifecycle (blocked on owner Q1)**
- `server/partner/submission-service.ts` — B1 per-card reservation; H6 COALESCE null-clearing
- `server/partner/partner-submission-credit-lifecycle.ts` — H3 recovery vs SQL `count<>1`
- `server/partner/partner-credit-reservation-service.ts` — H1 batch-abort wedge; `ON CONFLICT` on the hold insert
- `server/jobs/partner-credit-reservation-expiry.ts` — per-row skip + exception record
- `server/partner/portal-view-service.ts` — M5 delegate to `getCreditPosition`; `SUM(reserved_credits)` not `COUNT(*)`
- `server/partner/dashboard-service.ts` — M4 `manualAdjustmentEnabled` gate on wallet status

**UI**
- `client/src/pages/partner/dashboard.tsx` — **A1-F1 BLOCKER** (gate credits query on capability, isolate section errors, never surface raw "forbidden"); F7 tile scaffold
- `client/src/components/partner/partner-shell.tsx` — F5 gate CTAs on `partner.orders.create`; F6 remove inert bell; F10 `100dvh`; F12 mobile `aria-current` + focus management; F3/F4 portal-scope escapes
- `client/src/styles/partner-portal.css` — F2 consume tokens, remove Fraunces serif, fix gold to exact `#D4AF37`
- `client/src/pages/partner/submission-wizard.tsx` — H5 dead "Change customer" button
- `client/src/pages/admin/partner-dashboard.tsx` — F8 `?? 0` → `—`; F13 confirmation on credit removal
- `client/src/pages/partner/billing.tsx` — F11 status accents not emerald/rose
- `client/src/pages/partner/help.tsx` — F14 add support address
- `client/src/lib/partner-api.ts` — M6 move types to `shared/`

**Tests**
- `tests/helpers/partner-realistic-db.ts` — **F-01: line 195 routes 0041 around the non-superuser migrator the helper exists to model.** Highest-value single repair in the set.
- `tests/partner-wallet-service.test.ts` — H2 filter `<=16` → `<41` (restores the 0017 negative-balance backstop)
- `tests/partner-credit-admin-service.test.ts` — H2 filter `<19` → `<41`
- `tests/partner-g6d-migration-upgrade.test.ts` — add apply-twice, rollback-happy-path, and `certificates`/`label_prints` stubs

## KEEP (27)

All connector services (`connector-service`, `-validation-`, `-reconciliation-`, `-admin-`, `-errors`,
`connector-credit-lifecycle-audit`), `server/partner/db.ts`, `definer-guard.ts`, `routes.ts`,
`dashboard-routes.ts`, `submission-routes.ts`, `connector-admin-routes.ts`, `server/index.ts`,
`server/storage.ts`, `server/routes/admin-submissions.ts`, `shared/partner-dashboard.ts`,
`client/src/pages/partner/{security,locations}.tsx`, `client/src/pages/admin/partner-network.tsx`,
`migrations/rollback-partner-submission-credit-lifecycle.sql` (repair separately, see below),
and the remaining test files.

Notable KEEPs with positive evidence: the `security.tsx` UUID defect is **fixed** in this range
(now `displayName`, server-derived, never a UUID). Zero Super Admin surface reachable from the
partner portal — nav gating **unmounts**, it does not CSS-hide. The scanner honesty posture is
exemplary and should be preserved verbatim.

## BLOCKED ON OWNER (3)

`migrations/0041_partner_submission_credit_lifecycle.sql`,
`migrations/rollback-partner-submission-credit-lifecycle.sql`,
`tests/partner-submission-credit-lifecycle.test.ts` — all three depend on the credit-unit answer
and on the migration-recovery decision. See the final report.

---

## Migration collision resolution — RECOMMENDED

**Never renumber the partner migration.** It is applied, checksum-matched, and renaming it makes
the runner treat it as pending → re-apply → fails at line 166 → the whole migration run aborts.

**Renumber CATALOGUE 0041 → 0028 or 0029** (both genuinely free across all branches; verified
against `git log --all` and the staging journal). This is the only option that is journal-clean
AND does not trip the rollback guard's `> 41` predicate, preserving the (currently non-executable)
0041 rollback window.

Second choice: catalogue → 0042. Journal-clean, but permanently forfeits 0041 rollback.

Free numbers: **0028, 0029, 0042+**. Taken on live branch tips but absent from staging's journal:
0025, 0027, 0036, 0037, 0038.
