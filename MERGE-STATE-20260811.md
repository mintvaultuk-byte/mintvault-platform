# Sibling-lineage merge — COMPLETE (2026-08-11)

Branch: `release/canonical-scanner-reconcile-20260811`
Worktree: `/Users/cornelius/mintvault-canonical-scanner-reconcile`
**Merge RESOLVED and committed. NOT deployed. No migration applied.**

## Inputs

|                  | SHA         | Notes                                                     |
| ---------------- | ----------- | --------------------------------------------------------- |
| merge-base       | `be8a501e`  | = origin/main                                              |
| ours (HEAD)      | `6ad84fbb`  | canonical grading (`c788fa68`) + scoped migration runner   |
| theirs           | `7d20196c`  | v1069 scanner/station mainline reconcile                   |
| production start | `c788fa68`  | v1071 serving it (read-only observation)                   |

`c788fa68` **is an ancestor of** `6ad84fbb`, so the live release is contained in
this merge on the canonical side; `7d20196c` is the second parent. The merge
commit therefore contains BOTH deployed releases, which is what makes the new
live-ancestry deploy guard pass by construction rather than by override.

## Outcome

- 128 files auto-merged; 22 files conflicted, 69 hunks; **all 69 resolved**.
- No wholesale `--ours`/`--theirs` on any semantically divergent file.
- Zero conflict markers, zero unmerged paths, `git diff --check` clean.

## Semantic resolutions that matter

| File | Resolution |
| --- | --- |
| `server/partner/grading-routes.ts` | Canonical as base (quantity>1 image binding, provenance JOINs, revision-bound preview). Hand-integrated theirs' `authorizePartnerScannerCertificate`, **re-pointed** at canonical `authorizeAssignedPartnerCert` + canonical `loadPartnerCert`, so station capture inherits the full provenance chain instead of the weaker tenant-only binding it shipped with. |
| `server/partner/mfa-service.ts` | Canonical service. Stronger on every axis: password verified UNCONDITIONALLY (theirs routed through `createPendingEnrolment`, whose `password != null` guard skips verification when `undefined` is passed), plus a session-liveness/`credential_version` check theirs lacks, plus tenant-bound session revoke in cancel. |
| `server/partner/routes.ts` | Canonical route body + **theirs' stricter empty-password guard** (`password.length === 0` → undifferentiated 401 instead of 400). Neither parent's weaker half survives. |
| `server/routes.ts` | Both parents' work kept. Auto-merge already preserved the scanner imports (`registerPartnerStationAdminRoutes`, `scannerEvidenceAdmission`, `requireStationCaptureAgent`, `getR2Buffer`) and canonical's `checkGradePublishGates`. The one conflict took theirs' audit-diff loop tail plus canonical's `savedReviewRevision` + `const gradeWrite` (`RETURNING grading_revision`). |
| `server/grader.ts` | Canonical (strict superset: carries theirs' `extraWhere` partner write-guard AND `RETURNING grading_revision`). Theirs' `certificate_image_evidence` / `NEW_IMMUTABLE_MASTER` working-asset block in `buildCertImagesPayload` was re-added by hand — a wholesale take had silently dropped it. |
| `client/src/components/certificate-form.tsx` | Canonical architecture (the canonical lineage deleted 767 lines of the old in-form grading application; `GradingWorkstation` owns stages). Theirs' scanner `CaptureWizard` was **re-hosted** on the canonical Card Details region — it had no consumer at all in the merged tree, i.e. Canon capture was unreachable from /admin. |
| `client/src/pages/partner/grading.tsx` | Canonical `mode="partner"` + `serviceTier`. Theirs' `mode="grader"` would have bypassed the partner capability gating (`catalogueEndpoint`, no identify, no image mutations) that `GradingWorkstation` keys off `mode === "partner"`. |
| `client/src/components/partner/partner-shell.tsx` | Theirs — a superset (adds New Submission + Certificates/Completed) AND correct: ours gated Customers on `partner.customers.view`, a capability that exists nowhere on the server; the real `/customers` route requires `partner.orders.view`. |
| `client/src/pages/partner/submission-wizard.tsx` | Theirs — its additions are load-bearing in the merged tree (`CreditCard` used at the pricing row, `catalogue` query consumed by the finish/language pickers). Ours would not have compiled. |
| `tests/partner-main-reconciliation-merge-loss.test.ts` | Theirs' derived `readdirSync` glob over `server/partner/*routes*.ts` — the hard-coded list went stale and misses `station-routes.ts`. |

## Migration lineage — a real collision was resolved

The two lineages numbered the SAME migration differently:

- canonical: `0046_partner_mfa_pending_lifecycle.sql` (applied on **staging**)
- scanner: `0044_partner_mfa_pending_lifecycle.sql` (applied on **production**)

Both files are byte-identical (`sha256 6243d1d8…`). Naively merged, the tree held
BOTH, which put two files on number `0046` (the other being
`0046_scanner_processing_jobs.sql`). The runner rejects duplicate NUMBERS at file
collection, before it opens a database — so the merged tree could not have run any
migration at all, in any environment.

**Resolved by keeping production's `0044` identity and deleting the `0046` copy.**
Production is this release's target. Staging's applied `0046` journal row is left
untouched and simply orphaned: `planMigrations()` iterates FILES, not journal rows,
so a journalled migration with no file is ignored, never reverted. Applied history
stays immutable on both hosts. Per-environment delivery remains the job of
`--only` + `--convergence-mode`.

Final ordering: `0043`, `0044`(mfa), `0045`(stations), `0046`(scanner jobs),
`0047`(evidence staging), `0073`(lineage convergence), `0074`(submission lifecycle,
renamed from canonical `0044`, body byte-identical to the scanner parent's `0074`).

Dangling references to the deleted file were repaired in
`tests/partner-mfa-fail-closed.test.ts` and in the operator-facing error string in
`server/partner/auth.ts`.

## Defects found and fixed DURING the merge

1. **The MVGS protected guard had stopped running entirely.** Both parents added a
   fourth authorised-signature constant to `tests/variant-line-consolidation.test.ts`
   and both named it `signatureD`. Git stacked the two declarations, producing a
   duplicate block-scoped `const` — a hard parse error, so the whole file collected
   as zero tests. `tsc` cannot catch this: `tsconfig.json` excludes `**/*.test.ts`.
   Renamed the scanner one to `signatureE` and OR'd both, in that file and in
   `tests/structured-variant-persistence.test.ts`. The two authorise different
   things (D = canonical review-revision CAS chain, E = immutable-master evidence
   read) and the merged `server/grader.ts` contains both, so collapsing them would
   let either change pass under the other's authorisation.
2. **Scanner `CaptureWizard` was dead code** — present but with no consumer, i.e.
   Canon capture unreachable from /admin. Re-hosted (see table above).
3. **`grader.ts` evidence block dropped** by a wholesale take; restored.
4. **Migration number collision** (above).

## Deploy guard — the root cause of the incident is now closed

`safe-deploy.sh` GUARD 1 only ever compared the checkout against `origin/main`. On
2026-08-11 v1069 (`7d20196c`) and v1070 (`c788fa68`) were siblings and NEITHER was
on `origin/main`, so GUARD 1 was satisfied both times and the second deploy removed
every scanner route from production.

Added:

- **GUARD 1L** — reads the commit the LIVE server reports and refuses unless it is
  an ancestor of the candidate. Decision table is a pure function
  (`scripts/deploy/live-ancestry.ts`) over an injected ancestry oracle.
- **GUARD 1M** — re-reads the live commit immediately before `fly deploy` and aborts
  if production moved during preflight (v1069→v1070 were 4 minutes apart).
- `--reconciled-from <SHA>` must NAME the currently-serving commit, so it goes stale
  the moment production moves and cannot be pre-baked into a runbook. It is not a
  general `--force`, and it cannot rescue a backwards deploy or an unknown live SHA.
- Prod fails CLOSED when the live commit cannot be determined;
  `--allow-unknown-live` is honoured for staging only and never weakens staging's
  divergence check.
- 18 deterministic tests in `tests/deploy-live-ancestry.test.ts` covering A–G,
  both clobber directions, and the override's failure modes. Replaying the real
  incident against real git objects now yields `DIVERGENT_LIVE_ANCESTRY`.

## Do not

- Do not deploy this branch without a fresh live-ancestry check.
- Do not apply any migration from this pass without deciding the per-environment
  `--only` set first.
