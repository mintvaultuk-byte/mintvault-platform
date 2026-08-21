# Change manifest — Public Partner Network v1 final production release

**Date:** 2026-08-20, amended 2026-08-21
**Lead session:** `codex/public-partner-v1-final-release-20260820@29cfd5f7`

## Findings this manifest addresses

- PPNR-001 — migration numeric identity collision — E.
- PPNR-002 — growth/public route, SEO/static and migration-test reconciliation conflicts — B/E.
- PPNR-003 — no Super Admin public-directory activation/kill-switch control with an accountable reason and fresh step-up — B/G.
- PPNR-004 — unsafe live negative-fixture requirement — G.

## Findings explicitly deferred

- PPNR-005 — no physical Partner deletion authority. A production inventory, recovery-point proof, reviewed manifest and the canonical `REVOKED` operation are required before a targeted terminal reset. No deletion code or SQL will be invented.
- PPNR-006 — Google OAuth pilot. Keep its optional schema and flag inactive; its external prerequisites do not gate the public Maps-address fallback.
- PPNR-007 — fresh Partner inputs. The owner must supply real identity/contact/location and perform any action-time sensitive-data transmission or login/MFA step.

## Files to change

| Surface | Change | Why | Class |
|---|---|---|---|
| Complete candidate public-presence commit range | Reconcile `132e9ab4` as a non-fast-forward merge onto current main, retaining both ancestors. | PPNR-002; the candidate contains the reviewed public authority and its release-gate repairs. | B/E/G |
| `migrations/0101_partner_public_presence.sql` → `0102_partner_public_presence.sql`, `migrations/0102_partner_google_presence.sql` → `0103_partner_google_presence.sql`, paired rollbacks | Rename only because neither candidate identity exists in the target journal and main owns 0101; retain bodies/checksums except filename identity. | PPNR-001; one migration number has one immutable meaning. | E |
| `server/routes.ts`, `server/routes/public.ts`, `server/seo-config.ts`, `server/static.ts` | Resolve overlap by retaining main’s growth review routes/structured-data serializer and candidate’s dynamic Partner API/SSR/sitemap contract through the shared serializer. | PPNR-002. | B |
| `tests/canonical-lineage-production-rehearsal.test.ts`, `tests/helpers/partner-realistic-db.ts`, `tests/partner-schema-parity.test.ts`, migration inventories and public-presence tests/docs | Rebuild ordered lineage as growth 0101 → public 0102 → optional Google 0103, and update exact names/counts/rehearsal claims. | PPNR-001/002. | B/E/G |
| `client/src/pages/admin/partner-management-helpers.ts`, `client/src/pages/admin/partner-management.tsx`, focused mounted UI tests | Add a dedicated public-directory release control that requires a nonblank bounded reason, confirmation and `runAdminProtected` fresh-step-up retry; leave non-public operational flags unavailable. | PPNR-003. | B/G |
| Public release runbook/ledger/rollback and task docs | Limit live negative checking to safe existing cases; record proposed containment and current fresh evidence. | PPNR-004. | G |
| Current-main reconciliation (only merge conflicts in `client/src/App.tsx`, Partner settings helpers/page, `server/lib/request-logger.ts`, Partner flags/routes and their mounted regression) | Current `origin/main` advanced from `f4285b71` to `2d776db9`; deploy guard correctly refuses a stale checkout. Retain both the new main security/runtime contracts and the reviewed public-presence contracts. | PPNR-009. | B/D/E |

## Files explicitly NOT touched

- MVGS, grading writers, QA, certificates, labels and Scanner — outside scope.
- Stripe/payment/credit mutation authorities — no financial mutation is authorised.
- Google OAuth/credential path — optional, disabled and not deployed.
- Partner reset implementation — no canonical physical purge exists and no direct cleanup will be added.

## Protected actions required

- [x] Local code reconciliation and rename of un-applied migration artifacts — covered by the owner’s bounded final-release instruction; no migration is applied by this step.
- [x] Push/merge to the remote main branch, selective migration of current-main Growth `0101` then public presence `0102`, production deployment, production flag activation, safe reset and one fresh Partner journey — explicitly approved by the owner on 2026-08-21, within the exact scope below.
- [ ] Target-time execution — only after fresh target journal/schema/recovery preflight and successful reconciliation of `2d776db9`. Google `0103`, batch migration, secrets, payment/credit, Scanner/MVGS and any unproven target remain excluded.

## Order of operations

1. Merge the complete candidate into current main and resolve the four proven conflicts without losing either authority.
2. Rename the two un-applied candidate migrations and every inventory/rollback/test/doc identity that references them.
3. Add the public-directory control and step-up/reason regression proof.
4. Run migration/reconciliation and public/Partner UI regressions; repair any reproduced blocker/high.
5. Capture a fresh candidate proof set before considering protected production operations.
6. Reconcile the candidate with the newly fetched current main (`2d776db9`), rerun affected gates, and use the canonical scoped migration runner for exactly `0101_growth_reviews_and_conversion.sql` followed by `0102_partner_public_presence.sql`.

## Regression gates required

- `npm run check`, full `npm test`, `npm run lint`, `npm run build`, `git diff --check`.
- Real PostgreSQL migration/rehearsal, public-presence, route/SSR/sitemap, privacy/CAS, and mounted control tests.
- Graph update/check and Engineering postflight.
- Targeted hostile re-review of merge, migration identity, UI kill-switch/step-up and public route surfaces.

**Approved to proceed to Stage 5:** bounded local reconciliation only; protected production actions remain pending the listed gates — 2026-08-20.

**Owner approval to proceed to protected execution:** 2026-08-21 — apply only current-main Growth `0101`, verify it, then Public Partner Presence `0102`, verify it; do not apply Google `0103` or a batch of pending migrations. Deployment must begin with public presence off and use the documented rollback position.
