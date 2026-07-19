# Trusted Intake Connector — Programme G2–G5

## Status of this document

This plan covers the full G2–G5 programme as authorised. **This pass
executes G2 only** (validation engine) to full rigor — schema, service,
tests, checkpoint commit, independent review, stop/go decision — and
explicitly defers G3–G5 with a written rationale below. This is a
deliberate scoping decision, made for the same reason the Phase 2 and G1
passes were scoped down: the alternative is rushing four large,
interdependent milestones (one of which touches the live payment/submission
creation path) in a single pass, which produces unverified or fabricated
"done" claims rather than real, checked progress.

## Why G3 is not attempted this pass

The mandatory baseline audit (see `INTAKE-MAPPING.md` §1 for full
citations) surfaced three concrete risks that G3's own instructions did not
anticipate and that materially change its scope:

1. **The `cards` table is dead.** Nothing in the current codebase writes to
   it. The real destination for card/item rows is `submission_items`
   (`shared/schema.ts:279-292`), populated by `storage.addSubmissionItems()`
   — a plain loop of individual inserts, not itself transactional.
2. **`storage.createSubmission()`'s `userId` handling is a live landmine**:
   `COALESCE(data.userId||null, (SELECT id FROM users LIMIT 1),
gen_random_uuid()::text)` (`server/storage.ts:411`). Passing `null`
   silently attaches the new submission to an **arbitrary existing
   customer's account**, or to a fabricated UUID that references nothing.
   G3 must never let this fallback fire — every import must resolve or
   create a real `users` row first, exactly as the existing
   `fulfilPaidSubmission` path does (`server/routes/submissions.ts:244`,
   `getUserByEmail` then `createUser`-if-missing).
3. **The tracking-number generator is not concurrency-safe**
   (`storage.getNextSubmissionId()`, `server/storage.ts:624-628`, a
   `SELECT COUNT(*)` based counter with no advisory lock or retry) — the
   same class of bug this repo already had to fix once for `cert_counter`
   (per the incident comment at `server/storage.ts:1218-1224`). G3's
   "exactly-once" guarantee needs its own collision-safe reference
   generation or an explicit retry-on-23505 loop; the existing code doesn't
   provide one to reuse as-is.
4. **`createSubmission` + `addSubmissionItems` are two separate,
   non-atomically-wrapped calls** in the existing route. G3's required
   17-step transactional sequence needs its own explicit transaction
   wrapper spanning both — nothing in the existing code demonstrates this
   pattern to copy from.

None of these are blockers requiring an owner architecture decision — the
destination boundary itself (`storage.createSubmission()` +
`storage.addSubmissionItems()`, writing `status='draft'`,
`payment_status='unpaid'` — the same neutral pre-payment state every
submission starts in) is clearly identified and safe to use. But building
G3 correctly around these three landmines, with its own transaction
wrapper, its own collision-safe reference scheme, and its own crash/
reconciliation tests, is a substantial independent piece of work — exactly
the kind of thing this programme's own "must not become one uncontrolled
implementation dump" instruction warns against compressing into the same
pass as G2. **G3, G4, and G5 are deferred to a follow-up controlled pass**,
scoped and briefed by this document and `INTAKE-MAPPING.md`.

## Milestone order (as authorised)

1. **G2A** — Validation schema (immutable validation runs + findings).
2. **G2B** — Deterministic validation engine (all listed rule categories).
3. **G2C** — Lease renewal, stale-source protection, revalidation. Closes
   the G1-documented `validating`-state lease gap.
4. G3A — Import provenance and destination uniqueness schema. **Deferred.**
5. G3B — Transactional MintVault intake importer. **Deferred.**
6. G3C — Crash recovery and reconciliation. **Deferred.**
7. G4A — Internal connector operations APIs. **Deferred.**
8. G4B — Super Admin Connector Operations UI. **Deferred.**
9. G4C — Metrics, audit, recovery controls. **Deferred.**
10. G5 — Adversarial proof and controlled merge (of the full programme).
    **Deferred** — this pass's own G2 slice gets its own scoped review and
    merge instead (see "Final merge criteria" below), since G5 as specified
    reviews the whole G2–G4 surface together.

## Implementation boundaries (this pass — G2 only)

- New migration only (next number from live `migrations/` — see below).
- New files under `server/partner/` only (`connector-validation-schema`
  concerns folded into the migration; validation service, fingerprint
  logic, error/finding types).
- **Zero** changes to `shared/schema.ts`, `server/storage.ts`,
  `server/routes/submissions.ts`, `server/routes.ts`,
  `server/scan-ingest-service.ts`, or any grading/certificate/payment/label
  file. G2 only ever _reads_ Partner-side tables (already established as
  readable by `partner_connector_runtime` in migration 0008) — it never
  reads or writes any MintVault-internal table.
- Extends `connector-service.ts`'s existing state list/matrix (adds
  `ready_for_import`; the `importing` state is deferred to G3 along with
  the `imported`-adjacent matrix entries it needs — G2 does not add states
  it can't yet legally transition into).

## Expected migrations

One new migration, additive only: two tables
(`partner_connector_validation_runs`, `partner_connector_validation_findings`),
extended CHECK constraint on `partner_connector_records.state` to add
`ready_for_import`, indexes, grants to the existing `partner_connector_runtime`
role only (no new role needed — validation is the same trust boundary as
G1). Tested rollback removing only the new objects.

## Services and routes affected

- New: `server/partner/connector-validation-service.ts`,
  `server/partner/connector-fingerprint.ts`.
- Modified: `server/partner/connector-service.ts` (add `ready_for_import`
  to `CONNECTOR_STATES`/`LEGAL_TRANSITIONS`; add
  `requestConnectorRevalidation`-adjacent transition support).
- No HTTP routes added this pass (G2 is a service-layer capability, not yet
  exposed — matches G1's own "no HTTP surface yet" posture; G4A is where
  routes appear).

## Test strategy

Real disposable Postgres, real concurrent connections, mirroring the G1
test convention exactly (`tests/partner-connector-validation-migration.test.ts`,
`tests/partner-connector-validation-service.test.ts`). No mocks for
anything that touches the database. Fingerprint determinism tested as pure
unit logic (no DB needed) plus DB-backed staleness-detection tests.

## Checkpoint commits (this pass)

1. `docs(partner-network): define connector G2-G5 programme`
2. `feat(partner-network): add validation result schema`
3. `feat(partner-network): add deterministic validation engine`
4. `test(partner-network): cover validation and stale-source handling`

Each commit is preceded by: focused tests green, `tsc --noEmit` clean, diff
inspected for scope, and (for the schema/engine commits) an independent
review pass before the commit is finalized.

## Stop/go criteria

**Go for G2B** only if G2A's migration passes fresh-DB apply +
reapply-is-noop + rollback + preflight + grant-boundary tests.

**Go for G2C** only if G2B's validation engine has a real test for every
rule category listed in `VALIDATION-CONTRACT.md`, and independent review of
G2A+G2B finds no unresolved critical/high finding.

**Go for merge of this G2 slice** only if: fresh disposable-DB proof passes
(migration + validation service + full existing G1 + Phase 1/2 suites),
zero new regressions against pristine origin/main, secret scan clean, no
MintVault-internal table touched (verified by diff + grep, not assumed),
connector flag remains OFF, independent review's material findings fixed.

**Explicitly NOT a go-condition for this pass**: G3/G4/G5 completion. Those
require their own baseline audit (informed by this document), their own
architecture decision record for the exactly-once transaction wrapper and
collision-safe reference scheme, and their own independent review panels
(Reviewers 2, 4, 5 in the original brief) — none of which have run yet.

## Explicit exclusions (this pass)

- No MintVault submission/certificate/payment/label code is read-to-modify
  or written to.
- No new HTTP routes.
- No Admin UI.
- No `importing`/`imported` state additions (G2 stops at
  `ready_for_import`).
- No load/concurrency workload beyond what G2's own claim/revalidation
  tests already need (G1's load-relevant claiming primitives are reused
  unchanged).
- No browser verification (nothing user-facing exists yet in G2).

## Final merge criteria (this pass's G2 slice)

Documented in the Final Report at the end of this session. Uses the same
gate list as G1's merge (fresh cluster, full regression, secret scan,
trial merge, flags OFF, nothing deployed) plus G2-specific: validation
determinism proven, fingerprint determinism proven, stale-source detection
proven, immutable validation history proven (runtime role cannot
UPDATE/DELETE either new table).
