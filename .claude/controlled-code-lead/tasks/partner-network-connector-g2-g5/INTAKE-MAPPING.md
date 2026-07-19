# Trusted Intake Connector — Intake Mapping (G3 design)

**Status: Designed only, not implemented this pass.** This document
records the G3 design so a follow-up controlled pass can implement it
without re-deriving the architecture — see `PROGRAMME-PLAN.md` for why G3
was deferred. Nothing in this document has been built, tested, or merged.

## 1. Existing MintVault intake boundary (evidence)

- `storage.createSubmission(data)` — `server/storage.ts:386-470`. Single
  unguarded `INSERT INTO submissions ... RETURNING *`. Only enforced
  requirement: `data.pricePerCardAtPurchase > 0` (throws otherwise). Not
  wrapped in `db.transaction()` (a lone INSERT is atomic regardless).
- `storage.addSubmissionItems(submissionId, items)` — `server/storage.ts:710-725`.
  A plain loop of individual inserts into `submission_items`
  (`shared/schema.ts:279-292`), **not itself transactional**. This is the
  real destination for card/item rows — the `cards` table
  (`shared/schema.ts:306-322`) is dead code: repo-wide grep for
  `insert(cards)` / `INSERT INTO cards` returns zero hits anywhere.
- Both are called from `POST /api/create-payment-intent`
  (`server/routes/submissions.ts:359-848`) — the _only_ caller of
  `createSubmission` in the entire repo (confirmed by grep).
- No certificate, grading, or Stripe-charge side effect occurs inside
  either function. Certificates are created exclusively by two later,
  separate, explicit actions (`server/scan-ingest-service.ts:195` and
  `POST /api/admin/certificates/new`, `server/routes.ts:3767`) — neither
  reachable from intake creation. Email sends only from
  `fulfilPaidSubmission` (`server/routes/submissions.ts:134+`), itself only
  reachable from `POST /api/confirm-payment` after a real Stripe charge
  succeeds — never from intake creation.

## 2. Customer strategy

**Approach: provenance-linked internal customer, resolved-or-created by
email, mirroring the existing (non-Partner) flow's own later-stage
mechanism.**

The existing flow does not create a `users` row at submission-creation
time — it links one later, in `fulfilPaidSubmission`, via
`storage.getUserByEmail(submission.email)` then (per that function's
existing pattern) `storage.createUser(...)` if none exists. G3's importer
does the equivalent lookup **eagerly, at import time**: resolve
`partner_customers.email` against `users.email`; if found, use that
`users.id`; if not found, create a new `users` row with `role: "customer"`
and the Partner customer's name/email, exactly matching the shape
`createUser` already expects (`server/storage.ts:374-384`). This is the
one point where G3 **must never** let `createSubmission`'s own
`COALESCE(userId, arbitrary-existing-user, garbage-uuid)` fallback fire —
`userId` is always resolved and passed explicitly, never left null.

No cross-tenant customer linking: the email-lookup key space is the
internal `users` table, which has no tenant concept at all (by the
existing Phase 0/1 architecture decision that MintVault-internal tables
carry no tenant column) — this is _by design_ the same identity space
every existing customer already occupies, Partner-originated or not.
Historical intake data is never rewritten by a later Partner-customer edit:
the imported `submissions` row carries a **snapshot** (customer email/name/
phone copied as flat text fields, exactly as the existing flow already
does — `customerEmail`/`customerFirstName`/`customerLastName`/`phone`
columns on `submissions` itself), not a live foreign-key join to
`partner_customers`, so an edit to the Partner customer record after
import has zero effect on the completed intake.

Partner users receive no access to internal MintVault customer records —
unaffected by this design; `partner_runtime` already has, and retains,
zero grants on any non-`partner_*` table.

## 3. Service and price mapping

**No mapping table this pass (deferred, per `VALIDATION-CONTRACT.md`'s
`service_tier_unmapped` reserved code).** G3A must add an explicit mapping
table (e.g. `partner_service_tier_mintvault_mapping`: `partner_tier_code
→ mintvault service_type + service_tier` pair, admin-managed, not
string-matched at runtime) before G3B can safely call `createSubmission`
with a real `serviceType`/`serviceTier` — inferring MintVault's tier from
Partner's `tier_code` string by pattern-matching would be exactly the kind
of "no arbitrary string matching" the brief explicitly forbids.

Price: the validated price snapshot (`partner_submissions.estimated_price_pence`,
already re-verified server-side by G2's `service_price_mismatch` check) is
what G3 passes as `pricePerCardAtPurchase`-equivalent — never a
browser-supplied or Partner-app-supplied number recalculated at import
time. `totals recalculated server-side` is already G2's job (the
validation run either confirms the stored price or blocks import).

## 4. Destination status

`status: "draft"`, `payment_status: "unpaid"` — the same neutral,
already-existing pre-payment state every submission starts in today.
**No new payment-status value is invented.** This is an honest state: it
does not fake a Stripe payment, does not fake a "paid" flag, and does not
require the current MintVault model to grow a new "manual/partner-billing"
concept just to represent "this hasn't been charged via Stripe" — that
concept already exists as the default state.

If Partner billing semantics are later defined (a real invoicing/
manual-billing model), this status can move without a schema change, since
`payment_status` is already a free-text column, not an enum with a fixed
member list enforced at the DB level (confirmed: no CHECK constraint on
`submissions.payment_status` was found in `shared/schema.ts`).

## 5. Destination uniqueness (design)

`partner_connector_imports` (design only, G3A):

```
id uuid PK
connector_record_id uuid UNIQUE NOT NULL REFERENCES partner_connector_records(id)
partner_organisation_id uuid NOT NULL
partner_location_id uuid NOT NULL
partner_submission_id uuid NOT NULL
partner_handoff_id uuid UNIQUE NOT NULL
validation_run_id uuid NOT NULL
destination_submission_id integer UNIQUE  -- nullable until import completes
source_fingerprint text NOT NULL
source_fingerprint_version integer NOT NULL
import_version integer NOT NULL DEFAULT 1
import_attempt integer NOT NULL DEFAULT 0
created_at timestamptz NOT NULL DEFAULT now()
completed_at timestamptz
reconciliation_status text  -- null | 'needs_review' | 'resolved'
last_safe_error_code text
```

`UNIQUE(connector_record_id)` and `UNIQUE(partner_handoff_id)` together
give the "one connector record → at most one destination" and "one
handoff → at most one destination" guarantees at the database level, not
just in application code. `destination_submission_id UNIQUE` (nullable, so
a _reservation_ row can exist before the destination is actually created —
see the reservation pattern below) prevents two different connector
records from ever claiming the same `submissions.id`, which cannot happen
through normal flow but is a real database-enforced backstop.

## 6. Transaction boundary (design)

`storage.createSubmission` + `storage.addSubmissionItems` are NOT
currently wrapped together in one transaction anywhere in the existing
code (see §1). G3B must add its own explicit wrapper (a `db.transaction()`
block, matching the pattern already used elsewhere for
`markSubmissionAsPaid`, `server/storage.ts:545`) around: the
`partner_connector_imports` row insert/update, the `createSubmission` call,
the `addSubmissionItems` call, and the connector-record state transition
to `imported` — all four in one transaction, or none. This is exactly the
kind of "single database transaction" the brief allows falling back from
if not technically possible; here it **is** possible (all writes are to
the same MintVault Postgres database), so the honest design is a real
transaction, not a reservation+reconciliation fallback for this specific
step. The **reservation** pattern is still needed one layer up — see
`ROLLBACK-AND-RECONCILIATION.md` — to make the _whole_ import operation
(claim → validate-recheck → transact → transition connector) safe across a
process crash between steps, since that outer sequence genuinely cannot be
one database transaction (the connector tables and the MintVault tables
are different logical boundaries even though they happen to live in the
same physical database today).

## 7. Forbidden side effects — how they're prevented

- **No grade/certificate**: G3B never calls `getNextCertId()` or inserts
  into `certificates` — those live exclusively in
  `scan-ingest-service.ts`/`routes.ts:3767`, both untouched by this
  programme.
- **No payment/Stripe**: G3B never calls `stripe.paymentIntents.create()`
  — that's a separate function in `server/routes/submissions.ts`, not
  something `createSubmission` itself does (confirmed in §1).
- **No email**: emails only fire from `fulfilPaidSubmission`, only
  reachable after a real Stripe charge — G3B never calls it.
- **No Vault Quest**: no code path touched by this programme imports from
  or writes to any `server/vault-quest/*` module.

## 8. Public-reference treatment

`trackingNumber` is generated, not Partner-supplied — `storage.getNextSubmissionId()`
today (`server/storage.ts:624-628`) is a non-concurrency-safe count-based
generator (documented risk in `PROGRAMME-PLAN.md`). G3B must either (a)
wrap generation + insert in a retry-on-23505 loop, or (b) adopt a
collision-safe generator (e.g. an actual DB sequence or the same advisory-
lock pattern `cert_counter` was fixed with, per the incident comment at
`server/storage.ts:1218-1224`). This is an explicit G3A/G3B design
decision, not resolved by this document — flagged for the follow-up pass.

## 9. Payment-state treatment

Covered in §4. No payment is collected, no Stripe object created, no fake
"paid" status. `payment_status` remains at its honest default (`"unpaid"`).
