# Change manifest — Partner Pilot Pass 2

**Date:** 2026-08-12
**Candidate:** `codex/partner-pilot-pass2` at `864fadeda`

## Owner authority and boundary

The attached owner Pass 2 brief explicitly directs semantic Pass 1 integration
and preservation of 0074 security hardening. This package makes only local
source/test changes. It does **not** apply a migration, alter a secret/runtime
role, modify Stripe/payment behaviour, push, deploy, or perform a physical
operation.

## Findings addressed

- PP2-F2 — Pass 1 server-authoritative grade boundary (B).
- PP2-F3 — 0074 pg_temp provenance hardening (E; source only, unapplied).

## Files to change

| File set | Change | Why | Class |
|---|---|---|---|
| 24 files in `7368b07e` | Semantically integrate the focused Pass 1 authority commit and its tests. | PP2-F2; preserve server-issued grades and remove browser authority. | B |
| `migrations/0074_partner_submission_lifecycle_and_location_snapshot.sql` | Pin function search path and qualify the provenance table. | PP2-F3; source-only security repair. | E |
| `migrations/rollback-0073-lineage-convergence.sql` | Preserve the matching rollback journal correction. | PP2-F3; migration lineage integrity. | E |
| `tests/partner-submission-lifecycle-migration.test.ts` | Add the executable pg_temp forgery regression. | PP2-F3 proof. | E |

## Explicitly not changed

- No database, migration journal, Fly secret, DB role, feature flag value,
  Stripe object, R2 object, physical station or printer.
- No protected MVGS mathematics, grading thresholds, label dimensions or
  certificate allocation semantics.
- PP2-F5 through PP2-F13 are deferred to packages after this candidate proves
  the exact authority/security integrations without conflicts.

## Order and regression

1. Cherry-pick Pass 1 exactly with provenance (`-x`), inspect the diff.
2. Cherry-pick source-only 0074 hardening with provenance (`-x`), inspect it.
3. Run grading authority, browser-bundle and 0074 migration regressions,
   TypeScript and a production build; no migration runner against an environment.

**Authorised to proceed:** owner Pass 2 brief, local-source scope only.

---

# Package C — Partner station target arm and single-active-target invariant

## Owner authority and boundary

The owner Pass 2 brief requires the canonical workstation to arm only a
server-authorised Partner card at a selected approved station/location, and
requires a one-active-card invariant. This package changes source, tests and a
new numbered migration file only. The migration is deliberately **not applied**
to any environment by this task.

## Findings addressed

- PP2-F8 — expose a constrained browser control that can arm the existing
  signed-station capture lifecycle.
- PP2-F9 — make the one-active-target-per-station invariant database-enforced,
  including expiry cleanup inside the target-arm transaction.

## Files to change

| File | Change | Why | Class |
|---|---|---|---|
| `server/partner/station-service.ts` | List only active, permitted, calibrated station summaries without credential material. | PP2-F8. | B |
| `server/partner/station-routes.ts` | Add scoped station discovery and session-state reads around the existing target arm route. | PP2-F8. | B |
| `server/scanner-capture-service.ts` | Transactionally expire stale station targets and rely on a partial unique station index. | PP2-F9. | B |
| `client/src/pages/partner/grading.tsx` | Add station-picker/front-back capture controls to the canonical Partner grading page; no free-form station ID. | PP2-F8. | B |
| `migrations/0075_partner_station_single_active_capture.sql` | Add the partial unique station index; source only. | E |
| focused scanner/migration tests | Pin scope, route and index proof. | B/E proof. |

## Explicitly not changed

- No migration journal row, database schema, station status, runtime URL,
  credential, R2 object, capture, print, payment, credit balance, deploy or
  physical device is modified.
- No station scanner endpoint accepts a browser-selected certificate, filename,
  TIFF or free-form device identity.

## Regression

Run focused capture boundary/migration/UI tests plus TypeScript and production
build. A real-PostgreSQL migration proof runs only against an explicitly local
disposable URL; no production database is queried or changed.

**Authorised to proceed:** owner Pass 2 brief, local-source scope only.

---

# Package B — scoped grading enablement and QA-hold label denial

## Owner authority and boundary

The owner Pass 2 brief requires a tenant/location-flagged Partner grading
workflow and an enforced 100% QA hold before printing. This package repairs
only local source and regression proof. It makes no feature-flag mutation,
database/migration operation, deployment, printing, credit mutation or
external-system change.

## Findings addressed

- PP2-F5 — make `partner_grading_enabled` an enforced tenant/location gate.
- PP2-F6 (QA-preview portion) — refuse Partner label preview while the card is
  awaiting Super Admin QA.
- Package A regression-contract drift caused by the already-authorised Pass 1
  server-authority integration.

## Files to change

| File | Change | Why | Class |
|---|---|---|---|
| `server/partner/grading-routes.ts` | Resolve `partner_grading_enabled` under the authenticated tenant/location transaction before any grading endpoint. Fail closed on flag/database error. | PP2-F5. | B |
| `server/services/label-preview-access.ts` | Deny a Partner preview for `pending_review`; Super Admin QA remains the sole review/print authority. | PP2-F6. | B |
| `tests/label-preview-security.test.ts` | Prove the QA-pending denial. | PP2-F6 proof. | B |
| `tests/structured-variant-persistence.test.ts` | Admit only the already-authorised server-owned resolver signature while retaining its scoring/certificate-number prohibition. | Package A proof repair. | B |
| `tests/grader-noop-audit.test.ts` | Update the mocked server-owned resolver path and asserted API response. | Package A proof repair. | B |

## Explicitly not changed

- No generic or Partner print-batch capability is broadened; the remaining
  lifecycle/settlement print invariant remains tracked as PP2-F6.
- No Partner intake allocation, scanner, station, migration, database role,
  feature-flag value, credit/Stripe operation, deployment, R2 object or
  physical device is changed.

## Regression

Run focused flag/preview/authority tests, TypeScript, production build, the
protected-diff check and the full available suite. Native label-render tests
are separately reported if the supplied dependency tree lacks `canvas.node`.

**Authorised to proceed:** owner Pass 2 brief, local-source scope only.
