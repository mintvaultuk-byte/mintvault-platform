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

| File set                                                                 | Change                                                                    | Why                                                                 | Class |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- |
| 24 files in `7368b07e`                                                   | Semantically integrate the focused Pass 1 authority commit and its tests. | PP2-F2; preserve server-issued grades and remove browser authority. | B     |
| `migrations/0074_partner_submission_lifecycle_and_location_snapshot.sql` | Pin function search path and qualify the provenance table.                | PP2-F3; source-only security repair.                                | E     |
| `migrations/rollback-0073-lineage-convergence.sql`                       | Preserve the matching rollback journal correction.                        | PP2-F3; migration lineage integrity.                                | E     |
| `tests/partner-submission-lifecycle-migration.test.ts`                   | Add the executable pg_temp forgery regression.                            | PP2-F3 proof.                                                       | E     |

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

# Package F — Partner certificate allocation, immutable capture, QA, output and history

## Owner authority and boundary

The owner Pass 2 brief requires one server-authoritative Partner path from
reserved credit through station capture, mandatory Super Admin QA, settlement,
print and completed-history visibility. This package changes only local source,
tests and a new numbered migration file. It does not apply a migration, enable a
flag, alter a credit, render/print a live label, or access production data.

## Findings addressed

- PP2-F6 — one Partner-aware QA/output authority for preview, output, cached
  artefacts and physical-print confirmation.
- PP2-F7 — allocate targetable Partner certificates with immutable origin and
  the global MV allocator in the connector transaction.
- Partner history and Super Admin QA provenance visibility required by Parts
  7, 8, 19, 21 and 55 of the owner brief.

## MV identity timing

The existing signed scanner/evidence contract is certificate-targeted: a
capture session, its TIFF masters and the canonical workstation all bind to
`certificates.id`. The safe compatible point is therefore the locked connector
import, after the source submission has atomically reserved exactly one active
credit per card and before either side can be armed. `0076` allocates the
global MV identity and immutable Partner origin in that same database
transaction; a failed import rolls back the allocator increment and no client
or Scanner predicts an identity. The same identity stays attached through
capture, correction, QA, print and completion. It is deliberately not output
or public-finalised until the stricter QA/credit/evidence print authority
passes. This earlier-than-registration timing is retained for compatibility
with the canonical target model and must be exercised in the owner physical
canary; an abandoned post-import card retains its historical identity and is
never reassigned.

## Files to change

| File set                                                           | Change                                                                                                                                                                                                 | Why                                                                | Class |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| `migrations/0076_partner_pilot_certificate_allocation.sql`         | New narrow SECURITY DEFINER allocator, fixed search path, exact connector/tenant derivation, immutable origin snapshot, assignee, MV allocation, and one-live-cert-per-item guard.                     | PP2-F7. Source only until owner-authorised journal reconciliation. | E     |
| connector/grading routes                                           | Invoke the allocator only when the scoped flag is enabled; require current station-bound TIFF evidence and exact Partner origin for all Partner grading reads/writes.                                  | PP2-F7 and wrong-card prevention.                                  | B/C   |
| `server/partner/print-eligibility.ts` and print/preview call sites | Require completed mapping, QA clear, settled per-card credit set, two current captured TIFF masters, approved station provenance, MV identity and allowed print state.                                 | PP2-F6.                                                            | B/C   |
| QA context, certificate history and portal page                    | Show Super Admin Partner/location/operator/station/evidence/correction facts beside the canonical workstation; replace the Partner certificate-history placeholder with a scoped read-only projection. | Parts 7 and 9.                                                     | B     |
| migration/source boundary tests                                    | Classify 0075/0076 as application scope and pin allocator, evidence, QA/output and history boundaries.                                                                                                 | Regression proof.                                                  | B/E   |

## Explicitly not changed

- No migration journal/schema, production certificate, MV counter, reservation,
  flag, Partner runtime role/URL, R2 object, deploy, printer or physical card.
- No protected MVGS mathematics, label rendering, credit price, stripe/payment
  or generic HQ output behaviour.

## Regression

Run migration scope/parity, Partner allocation/output, print workflow + credit,
Pass 1 authority, scanner, TypeScript and production build suites. A real
PostgreSQL execution of 0076 requires a disposable application-shaped database;
none was configured in this local environment.

**Authorised to proceed:** owner Pass 2 brief, local-source scope only.

---

# Package G — immutable Scanner release policy

The scanner now blocks an unsupported station with **UPDATE REQUIRED** and has
no self-update path that pulls Git or resolves npm dependencies. `update.sh` is
an explicit safe refusal; installing a signed package remains an owner-approved
release/distribution action. This is deliberately not a deployment or package
publication action.

---

# Package E — Super Admin station fleet controls

## Owner authority and boundary

The owner Pass 2 brief requires a Super Admin operational surface for station
approval and controlled rejection. This package exposes the existing fleet
data and locked service transitions in the canonical internal Partner
Management page. It does not approve, reject or otherwise alter any live
station.

## Findings addressed

- PP2-F11 — present pending/approve/suspend/revoke controls with an explicit,
  reasoned rejection path.

## Files to change

| File                                            | Change                                                                                              | Why            | Class |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------- | ----- |
| `server/partner/station-service.ts`             | Add a PENDING-only rejection transition with a credential-epoch rotation and dedicated audit event. | PP2-F11.       | B     |
| `server/partner/station-admin-routes.ts`        | Add the Super Admin rejection endpoint beside existing reasoned lifecycle routes.                   | PP2-F11.       | B     |
| `client/src/pages/admin/partner-management.tsx` | Render the paginated fleet view and reason-confirmed constrained actions.                           | PP2-F11.       | B     |
| `tests/partner-station-fleet-control.test.ts`   | Pin server/route/UI control boundaries.                                                             | PP2-F11 proof. | B     |

## Explicitly not changed

- No station credential, public key, secret, identity, status, calibration,
  database row, deployment or physical station is changed by this task.
- The browser cannot submit a station ID other than one returned by the server,
  and a reject operation cannot apply to an already-approved station.

## Regression

Run the fleet boundary suite with TypeScript and the production build; retain
the signed-station capture suites because every status action rotates the
credential epoch.

**Authorised to proceed:** owner Pass 2 brief, local-source scope only.

---

# Package D — scanner card-registration acknowledgement

## Owner authority and boundary

The owner Pass 2 brief requires a paired, explicit **CARD REGISTERED** state
and a **NEXT CARD** acknowledgement. This package makes the scanner surface
consume only terminal capture facts already persisted by the server; it does
not make the scanner an allocation, grading, QA or print authority.

## Findings addressed

- PP2-F10 — retain a server-derived paired completion state until the operator
  explicitly acknowledges the next card.

## Files to change

| File                                                                 | Change                                                                                                             | Why                        | Class |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----- |
| `server/scanner-capture-service.ts`                                  | Derive paired card registration only from captured front and back target sessions.                                 | PP2-F10 server fact.       | B     |
| `server/routes.ts`                                                   | Return the derived `card_registered` fact from successful capture and reconciliation responses.                    | PP2-F10 transport.         | B     |
| `scripts/scanner-app/{lib/watcher.js,main.js,preload.js,renderer/*}` | Persist/display the server result, and permit a local acknowledgement that can neither arm nor retarget a capture. | PP2-F10 operator hand-off. | B     |
| scanner boundary and state-machine tests                             | Prove a second accepted side holds the server-derived acknowledgement state.                                       | PP2-F10 proof.             | B     |

## Explicitly not changed

- No pairing record is inferred from a browser, local TIFF, certificate number
  prediction, or a successful front capture alone.
- No capture session, evidence, origin, credit, grade, QA, print state,
  station approval, database, deployment or physical scanner is mutated by
  acknowledgement.

## Regression

Run scanner unit/state-machine suite, focused capture boundary tests,
TypeScript and production build. The package keeps server-side capture state
as the sole source of the `CARD REGISTERED` decision through a restart.

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

| File                                                        | Change                                                                                                         | Why        | Class |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- | ----- |
| `server/partner/station-service.ts`                         | List only active, permitted, calibrated station summaries without credential material.                         | PP2-F8.    | B     |
| `server/partner/station-routes.ts`                          | Add scoped station discovery and session-state reads around the existing target arm route.                     | PP2-F8.    | B     |
| `server/scanner-capture-service.ts`                         | Transactionally expire stale station targets and rely on a partial unique station index.                       | PP2-F9.    | B     |
| `client/src/pages/partner/grading.tsx`                      | Add station-picker/front-back capture controls to the canonical Partner grading page; no free-form station ID. | PP2-F8.    | B     |
| `migrations/0075_partner_station_single_active_capture.sql` | Add the partial unique station index; source only.                                                             | E          |
| focused scanner/migration tests                             | Pin scope, route and index proof.                                                                              | B/E proof. |

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

| File                                           | Change                                                                                                                                                 | Why                     | Class |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ----- |
| `server/partner/grading-routes.ts`             | Resolve `partner_grading_enabled` under the authenticated tenant/location transaction before any grading endpoint. Fail closed on flag/database error. | PP2-F5.                 | B     |
| `server/services/label-preview-access.ts`      | Deny a Partner preview for `pending_review`; Super Admin QA remains the sole review/print authority.                                                   | PP2-F6.                 | B     |
| `tests/label-preview-security.test.ts`         | Prove the QA-pending denial.                                                                                                                           | PP2-F6 proof.           | B     |
| `tests/structured-variant-persistence.test.ts` | Admit only the already-authorised server-owned resolver signature while retaining its scoring/certificate-number prohibition.                          | Package A proof repair. | B     |
| `tests/grader-noop-audit.test.ts`              | Update the mocked server-owned resolver path and asserted API response.                                                                                | Package A proof repair. | B     |

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
