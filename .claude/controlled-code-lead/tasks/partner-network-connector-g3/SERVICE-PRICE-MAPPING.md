# Trusted Intake Connector — G3 Service/Price Mapping

## Evidence

- Partner side: `partner_submissions.service_tier_code` (text) +
  `partner_service_tiers.price_per_card_pence` (integer), already read and
  validated by G2 (`connector-validation-service.ts:167-190`).
- MintVault side: `submissions.serviceType`/`submissions.serviceTier` are
  plain `text` columns with **no FK, no enum, no CHECK constraint**
  (confirmed by grep of `shared/schema.ts` for `.references(` near those
  columns — none). A separate MintVault-internal `service_tiers` table
  exists (`shared/schema.ts:1557-1570`) but `createSubmission` never joins
  or validates against it — it just stores whatever string the caller
  passes. No existing mapping table between Partner tier codes and this
  MintVault table exists.

## Mapping mechanism (mapping version 1 — direct passthrough)

G3 does **not** attempt to resolve a Partner `service_tier_code` into a row
of MintVault's `service_tiers` table — building that cross-system pricing
policy (which MintVault tier a given Partner tier *should* correspond to)
is a business decision with no existing convention in the repository to
follow, and inventing one would be guessing at a decision the brief's own
architecture-decision-gate process reserves for cases with no safe
convention. Since the destination columns are unconstrained free text, the
smallest-blast-radius, non-guessing option is a direct, literal passthrough:

- `submissions.serviceType` ← the fixed literal `"partner-intake"` (so any
  admin or report can immediately identify a Partner-originated submission
  by its service type, without needing to join to the provenance table).
- `submissions.serviceTier` ← the validated Partner `service_tier_code`
  string, unchanged (e.g. `"standard"`).
- `submissions.gradingCost` ← `price_per_card_pence × total item rows`
  (integer pence, matching the column's existing unit — confirmed by
  reading how `shippingCost`/`gradingCost` are used elsewhere as raw
  integer pence, not decimal pounds).
- `submissions.totalPrice` ← the same total, formatted as the decimal
  string the column expects (matching `totalPrice`'s existing
  `decimal(10,2)` shape).

This is recorded as `mapping_version = 1` on the import-mapping row
(`SERVICE-PRICE-MAPPING.md`'s own versioning column, distinct from the
source-fingerprint version) — if a future pass introduces a real
Partner-tier → MintVault-`service_tiers` lookup table, that becomes mapping
version 2, and the version number lets any future reconciliation tooling
distinguish "this import used the old passthrough mapping" from "this
import used the new resolved mapping" without re-deriving it from the data.

## Price snapshot

The price used is whatever the **fresh re-read** at import time shows for
`partner_service_tiers.price_per_card_pence` (not the value cached on the
G2 validation run) — but this is safe, not stale, because the import
transaction's mandatory fingerprint recheck (see
`IDEMPOTENCY-AND-TRANSACTION.md`) already guarantees the tier's price
hasn't changed since validation; if it had, the fingerprint mismatch would
abort the import before any price is read for real. So "fresh read" and
"validated snapshot" are provably the same value at the point the price is
actually used.

## Quantity calculation

`submissions.cardCount` = the total number of `submission_items` rows
created (see `DESTINATION-BOUNDARY.md` for the one-card-with-quantity-3 →
three-rows expansion), computed server-side by counting the rows the
importer itself is about to insert — never taken from a Partner-supplied
count field directly, so a mismatched Partner `card_count` (already a G2
blocking-validation rule, `card_count_mismatch`) cannot leak through even
if that check were somehow bypassed.

## Declared-value surcharge handling

None applied. MintVault's existing surcharge rules (if any) live entirely
in the checkout route handler G3 does not call — `createSubmission` itself
applies no surcharge logic (confirmed: its raw INSERT has no
surcharge-related computation, only stores whatever `totalDeclaredValue`
it's given). G3 sets `totalDeclaredValue` to the sum of the validated
Partner cards' `declared_value_pence`, with no additional surcharge — this
is documented as a known limitation: if MintVault's checkout flow applies a
declared-value-based surcharge to `gradingCost` that G3 is not replicating,
Partner-originated submissions would show a lower `gradingCost` than an
equivalent-value checkout submission. This was not found in the audited
code path (no surcharge computation exists in `createSubmission` itself),
so there is no known behaviour to replicate — but it is flagged here in
case a surcharge is applied elsewhere (e.g. client-side, before the
`totalPrice` reaches `createSubmission`) that this audit did not have
visibility into.

## Payment/billing state

`paymentStatus = 'unpaid'` — the same default a normal draft submission
carries before checkout. No Partner-specific billing state (e.g. "billed to
partner account") exists anywhere in the schema, and inventing one is
explicitly forbidden by the brief ("do not invent a paid or settled
state"). This is a known limitation, not a design choice: Partner-network
billing (how MintVault actually gets paid for Partner-originated grading
work) is an unresolved business question outside this pass's evidence base
— flagged for a future programme, not guessed at here. Every Partner-
imported submission is `unpaid` and will need a real payment/billing
resolution (either a manual admin process or a future G-phase) before it
can proceed past intake in practice; this is explicitly out of scope for
"the intake exists" vs. "the intake is paid for."

## Stale-mapping behaviour

Any Partner-side service-tier data change (`tier_code`, `price_per_card_pence`,
`is_active`) between validation and import is caught by the source
fingerprint recheck (all three fields are canonical fingerprint inputs per
`SOURCE-FINGERPRINT.md`) — import is refused, connector returns to a
revalidation-required state, no destination is created. There is no
separate "mapping went stale" concept distinct from "source went stale"
in mapping version 1, since the mapping is a pure passthrough with no
independent state of its own to go stale.
