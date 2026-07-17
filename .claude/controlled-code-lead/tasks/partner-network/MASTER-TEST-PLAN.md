# Master Test Plan / Test Matrix — Partner Network

Reuses the existing Vitest + ESLint + Prettier + Husky harness. Every phase adds automated tests;
the MVGS regression suite must stay green (grading is PROTECTED). DB-backed tests run only against
a **disposable** local Postgres (Phase 0.5 pattern), never staging/prod. Each row maps to a phase
and (where applicable) a threat T# from the threat model.

## Tenant isolation (Phase 1, 20) — T1,T2,T3,T24
- Partner A cannot read/write Partner B order/customer/card/credit/certificate/NFC/scan.
- Location A user cannot access Location B (same partner) unless explicitly assigned.
- Missing tenant context returns zero rows / 403 (fail closed) at BOTH app and DB (RLS proven by
  connecting as the restricted role directly).
- Partner principal cannot reach any `requireAdmin` / numeric-ID admin route (explicit 403).
- Browser-supplied tenant/location/user/device IDs are ignored (server re-derives).

## Credits & payments (Phase 5, 17) — T4,T5,T6,T7
- Partner cannot create/edit/increase credits (no write path).
- Duplicate Stripe webhook → single issuance (event-id dedup).
- Invalid signature / wrong amount / wrong currency / wrong product rejected.
- Two concurrent reservations cannot consume one credit (atomic + unique index).
- Refund reverses/freezes unused value; chargeback freezes; consumed-credit-then-disputed escalates.
- Ledger is append-only; balance = derived; no negative balance.
- Reconciliation detects: credit-without-payment, payment-without-credit, duplicate credit,
  consumed-without-completed-card, completed-without-credit.

## Device security (Phase 4, 20) — T8,T9,T17,T18
- Approved user on unapproved Mac cannot capture; approved Mac + unauthorised user cannot capture.
- Copied cookie / copied app files do not work on another Mac.
- Revoked/suspended device stops immediately; two Macs cannot share one identity.
- Replayed signed request fails; unsupported app version blocked; no secret in client bundle.

## Workflow / grading integrity (Phase 7,8,10,11) — T10,T11,T12,T13,T15
- Certificate cannot be allocated/published before all gates (payment/credit, evidence, Supreme
  Grader approval, Field approval, authenticated, label, NFC verified, sealed, final photos).
- Shop submit never yields a final grade; state transitions cannot be skipped (server machine).
- Grade change creates a new version (prev/new/reason/who); completed grade not silently editable.
- NFC uid unique; one NFC per card; read-back required; label reprint requires reason + audit.
- Field outcome restricted to the closed set; disagreement returns to Supreme Grader.

## Chain of custody / anti-switch (Phase 10, 20) — T14
- Packaging number linked; tamper state verified; physical-vs-scan comparison recorded before seal.
- Card cannot complete without custody verification + final photos.

## Documents / accreditation (Phase 2,3) — T19
- Expired mandatory insurance blocks live grading; expired ID blocks that user; missing annual
  accreditation blocks certificate completion; suspended/removed technician cannot capture.

## Storage (Phase 7, 20) — T16,T17,T20
- Signed URL only after ownership check; short TTL; key traversal guard; no cross-tenant key.
- Upload: type/size/magic-byte validated at runtime (verify against built artifact, not source —
  esbuild treeshake caveat); server-generated names; private bucket.

## Emergency / rate limit (Phase 15, 20) — T21,T22,T23
- Freeze partner/location/user/device/credits enforced server-side, immediately.
- Security-sensitive partner limiters use a durable/shared store (not per-machine memory).
- Field officer cannot see unrelated cards; cannot escalate privilege.

## Migration safety (Phase 0.5 — DONE) — T24
- Host guard blocks non-local push (no override); preflight fails-closed on any unknown object
  (table/view/matview/schema/orphan-seq/enum); destructive-SQL linter; runner advisory lock +
  checksum + journal + dup-number rejection; dry-run mutates nothing. (54 pure tests + disposable
  harness green at `3e2dda03`.)

## Security validation (Phase 20 — full attack suite)
Tenant/location escape · customer-data access · ID-manipulation IDOR · signed-URL misuse · device
cloning · session replay · request replay · credit duplication · Stripe replay · concurrency ·
workflow skipping · cert duplication · NFC duplication · label reprint abuse · suspended user/
device access · expired-insurance bypass · field officer privilege escalation · grade manipulation
· card-switch evidence · file-upload attacks · rate-limit bypass · emergency-stop effectiveness.
Each attack is a test that must fail to breach.

## Gates per phase (Definition of Done)
`npm run check` + full `npm test` (incl. MVGS regression) + `npm run lint` + `npm run build`
(where bundling touched) + disposable-DB validation for DB work + secret scan of the diff +
independent verification. No phase is "done" on design/local-proof alone — state the proof level.
