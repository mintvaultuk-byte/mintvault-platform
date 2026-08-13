# Reviewer report — controlled credits, QA and print

**Scope:** Partner credit lifecycle, grade authority, QA/print gates and tenant
isolation. **Authority:** read-only review; received 2026-08-12.

## Evidence executed by reviewer

- Credit/print focused suite: 86/86 passing.
- Real PostgreSQL RLS suite: 27/27 passing.
- Runtime integration suite: 41 skipped because disposable restricted runtime
  configuration was unavailable.

## Accepted findings

- **PP2-F5 — HIGH, B.** `partner_grading_enabled` is defined in
  `server/partner/flags.ts` but grading/preview routes never resolve it. The
  global portal switch is the only runtime gate. Add a tenant/location-scoped
  grading middleware and real route proof.
- **PP2-F6 — HIGH, B/C.** Partner label preview in
  `server/partner/grading-routes.ts` authorizes assignment, revision and grade,
  but does not require approval/QA/paired evidence/financial eligibility.
  `server/print-workflow.ts` currently has only generic approval/print-state
  gating. Add a single server-side Partner print-eligibility authority used by
  preview and physical batch paths, with QA-held and wrong-tenant negatives.
- **PP2-F7 — HIGH, B.** Scanner ingest stamps `origin_type='HQ'` in
  `server/scan-ingest-service.ts`; Partner scan intake has no dedicated allocator
  caller. Because origin is immutable, a Partner card using that path would be
  permanently misclassified. Add a Partner-origin allocation context in the
  same committed allocation transaction and prove Partner/HQ immutability and
  retry behaviour.

## Clean areas

- Controlled admin-granted credits: append-only ledger, per-card reservation,
  idempotency and RLS proof are present. Pilot 1 can use those credits; Partner
  Stripe purchase is not an active controlled-pilot requirement.
- Partner grade writes bind tenant, location, assignee and provenance, require
  both sides before submit, and enter `pending_review` with `review_required`.

## Not covered

Production-shaped restricted-runtime HTTP proof and physical printer/station
proof.
