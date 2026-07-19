# Trusted Intake Connector — Validation Contract (G2)

Implemented this pass. This is the exhaustive rule set
`server/partner/connector-validation-service.ts` enforces.

## Outcomes

`valid | invalid | stale | cancelled | failed` — stored on
`partner_connector_validation_runs.outcome`.

- `valid`: zero blocking findings. Connector may move to `ready_for_import`.
- `invalid`: at least one blocking finding. Connector moves to `rejected`.
- `stale`: source fingerprint mismatch detected mid-validation. Connector
  moves to `failed` with `last_error_category='stale_source'` (retryable —
  a fresh validation run against the new source may succeed).
- `cancelled`: the underlying Partner submission was cancelled during
  validation. Connector moves to `cancelled`.
- `failed`: an internal/transient error interrupted validation before an
  outcome could be determined (e.g. a genuine DB error). Connector moves to
  `failed`, retryable.

## Severities

`warning | blocking` — stored on
`partner_connector_validation_findings.severity`. A run's `outcome` is
`invalid` if and only if `blocking_error_count > 0`. `warning`-only runs
are `valid` — the finding is recorded for visibility but does not block.

## Blocking rules (invalid if violated)

| Code                          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organisation_missing`        | Partner organisation referenced by the connector record's `tenant_id` does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `organisation_inactive`       | Organisation `status != 'ACTIVE'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `organisation_suspended`      | Organisation `status == 'SUSPENDED'` (distinct code from inactive — surfaces the specific reason).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `location_missing`            | Submission's `location_id` does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `location_inactive`           | Location `status != 'ACTIVE'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tenant_mismatch`             | Any loaded row's `tenant_id` does not match the connector record's `tenant_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `submission_missing`          | `partner_submissions` row referenced by the connector record does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `submission_not_final`        | Submission `status == 'draft'` (must be `submitted_to_mintvault`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `submission_cancelled`        | Submission `status == 'cancelled'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `submission_superseded`       | A newer connector record exists for a handoff belonging to the same submission (should be structurally impossible given migration 0008's `UNIQUE(handoff_id)`, but checked defensively).                                                                                                                                                                                                                                                                                                                                                                      |
| `handoff_missing`             | `partner_submission_handoffs` row does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handoff_not_ready`           | Handoff `status != 'pending'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `handoff_mismatch`            | Handoff's `submission_id` does not match the connector record's `partner_submission_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `customer_missing`            | Submission has no `customer_id`, or the referenced `partner_customers` row does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `customer_invalid`            | Customer `full_name` is null/empty/whitespace-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `customer_invalid_email`      | Customer `email` is present but fails a basic RFC-shape check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `service_tier_missing`        | Submission has no `service_tier_code`, or no matching active `partner_service_tiers` row (own-tenant or global) exists.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `service_tier_inactive`       | Matching tier row has `is_active = false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `service_tier_unauthorised`   | _(reserved — no per-tenant tier authorisation list exists yet; always passes today; documented so G3+ can wire real authorisation without a silent behaviour change)_                                                                                                                                                                                                                                                                                                                                                                                         |
| `service_tier_unmapped`       | _(reserved for G3 — no Partner-tier→MintVault-service mapping table exists yet; G2 cannot check this and does not claim to)_                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `service_price_mismatch`      | `submission.estimated_price_pence` does not equal a fresh server-side recomputation from the matched tier's `price_per_card_pence * total_quantity`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `no_cards`                    | Zero non-removed `partner_submission_cards` rows for the submission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `too_many_cards`              | More than `MAX_CARDS_PER_SUBMISSION` (200, a G2-specific practical ceiling — the existing wizard has no cap of its own, and 1000 per-card matches the _quantity_ ceiling, not a sane row-count ceiling) non-removed rows.                                                                                                                                                                                                                                                                                                                                     |
| `card_invalid_quantity`       | Any card's `quantity` is not an integer `1..1000` (matching `server/partner/submission-routes.ts`'s existing `MAX_QUANTITY` constant exactly).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `card_invalid_declared_value` | Any card's `declared_value_pence` is present and negative, or exceeds `100_000_000` pence / £1,000,000 (matching the existing submission-routes `MAX_DECLARED_VALUE_PENCE` constant exactly).                                                                                                                                                                                                                                                                                                                                                                 |
| `card_missing_required_field` | Any card's `card_name` is null/empty/whitespace-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `card_tenant_mismatch`        | Any card's `tenant_id` does not match the connector record's `tenant_id`. **Structurally unreachable in practice**: `partner_submission_cards` is FORCE ROW LEVEL SECURITY, so a row whose real `tenant_id` doesn't match the validating transaction's `app.tenant_id` GUC is filtered out by the database before this check ever runs — the observable symptom of a corrupted row is `no_cards`/`totals_mismatch`, not this code. Kept as defence in depth (belt-and-braces against a future RLS misconfiguration), not as the actual enforcement mechanism. |
| `totals_mismatch`             | Sum of non-removed card quantities does not equal `submission.card_count`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `source_version_mismatch`     | Submission's current `version` does not equal the version captured when the connector record was created (via `ensureConnectorRecordForHandoff`'s read — see `SOURCE-FINGERPRINT.md`).                                                                                                                                                                                                                                                                                                                                                                        |
| `source_fingerprint_mismatch` | Recalculated fingerprint does not equal the previously-stored fingerprint on a **revalidation** (first-time validation has nothing to compare against and cannot trigger this code).                                                                                                                                                                                                                                                                                                                                                                          |
| `already_imported`            | A completed `partner_connector_imports` mapping already exists for this connector record. **(Schema deferred to G3 — this check is a documented no-op stub in G2, always passing, until G3A's schema exists. Flagged explicitly rather than silently omitted.)**                                                                                                                                                                                                                                                                                              |

## Warning rules (recorded, never block)

| Code                                       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service_tier_missing` price-adjacent note | _(not separately coded — see blocking table; no warning-only tier issues identified yet)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| —                                          | No warning-severity findings are emitted by G2's initial rule set. The severity mechanism exists and is tested (a synthetic warning-only run is exercised in tests to prove `valid` outcome with `warning_count > 0`), but no current rule is soft enough to warrant `warning` over `blocking` — every violation found in existing card/submission/tier data represents a genuine reason not to import. This is intentional, not an oversight: a rule can be reclassified to `warning` later without a schema change (severity is a column, not a type). |

## Unknown/internal error handling

Any unexpected exception during validation (a DB connectivity blip, an
unparseable row) is caught, mapped to finding code
`unknown_validation_error` (blocking, since safety requires blocking on
uncertainty), and the run's `outcome` is set to `failed` — never `invalid`
(that code is reserved for genuine rule violations the engine actually
evaluated, so an operator can tell "the source is bad" apart from "the
validator broke"). No raw SQL, table name, or stack trace is ever stored in
`safe_metadata` or surfaced to a caller.

## Safe metadata rules

`partner_connector_validation_findings.safe_metadata` (jsonb) may contain:
booleans, numbers, short enumerated strings (state names, code names),
counts. It must never contain: customer names, emails, phone numbers,
addresses, free-text notes, card names (a card's `card_name` is
user-authored free text and is never copied into metadata — only its
_presence/absence_ and _length_ are used for validation, never its value).
`safe_entity_reference` on a finding is always an opaque ID (a
`partner_submission_cards.id` UUID, never a name), matching the "no names,
full emails, addresses" requirement.

## Tenant and location checks

Every query the validation service issues is scoped by an explicit
`tenant_id = $1` predicate matching the connector record's own
`tenant_id` (defence in depth — the connector tables have no RLS, per
`ARCHITECTURE.md` §7 from G1, so the service layer is the enforcement
point here, exactly as G1's reviewed `claimConnectorRecord`/
`transitionConnectorState` pattern already established).

## Customer / service-tier / card / quantity / value / totals rules

See the blocking-rule table above — every one of these categories has an
explicit code and an explicit test.

## Stale-source behaviour

If, at any point during validation, a freshly-read `partner_submissions.version`
differs from the version captured at connector-record-creation time, the
run's outcome is `stale` and no further rule evaluation proceeds (there is
no point checking totals against data that's already known to have moved).
This is a distinct code (`source_version_mismatch`) and outcome (`stale`,
mapped to connector state `failed` with a `stale_source` error category)
from a genuine rule violation (`invalid`) — an operator needs to know
"revalidate me, the partner changed something" is different from "this
submission is genuinely bad."

## Revalidation behaviour

`requestConnectorRevalidation()` always creates a **new**
`partner_connector_validation_runs` row (never updates a prior one — see
`SOURCE-FINGERPRINT.md` for why history is append-only). It requires the
connector record to be in `ready_for_import` (an already-validated record
being explicitly asked to re-check itself before import) or `failed` with
a `stale_source`/transient category. Revalidating a `rejected` or
`cancelled` record is refused (`invalid_state_transition`) — those are
terminal for a reason.
