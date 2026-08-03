# Issue register — partner-portal-expanded-hostile-review

Status key: **VERIFIED** = Lead personally re-read the cited lines and reproduced the logic.
**REPORTED** = reviewer finding awaiting Lead verification.

Reviewers reported so far: Agent 2 (wallet/ledger), Agent 3 (reservation lifecycle),
Agent 6 (submission/scanner). Outstanding: Agent 1 (UI), Agent 4 (security), Agent 5
(database/migration), Agent 7 (test vacuity).

---

## BLOCKER

### B1 — One credit reserved per SUBMISSION, not per CARD (revenue leak)
**VERIFIED by Lead.** Independently found by Agent 3 (G6D-01) and Agent 6 (F-09) — two
agents converged from different scopes.

Evidence, all re-read personally:
- `server/partner/submission-service.ts:706-722` — exactly one `reserveCreditInTransaction`
  call in the entire submit path, `cardReference: partner-submission:${submissionId}`.
  No loop over `partner_submission_cards`. The card gate at `:668` only requires `n >= 1`.
- `migrations/0017_partner_credit_reservations.sql:50` —
  `CONSTRAINT chk_partner_credit_reservations_amount CHECK (reserved_credits = 1)`.
  One reservation row can never represent N credits, so the single call cannot be scaled.
- `server/partner/connector-import-service.ts:409-414` — the SAME submission is expanded
  to N items and priced `pricePerCardPence * cardCount`.
- `migrations/0017:71-73` — `uq_partner_credit_reserve_card_live ON (tenant_id, card_reference)`,
  commented "One live or already-consumed entitlement per partner card reference". This
  index was designed as the per-card double-reserve guard; feeding it a per-submission
  synthetic key silently converts it into a per-submission guard.
- `server/partner/partner-credit-reservation-service.ts:5` (header) — "One partner grading
  credit can be reserved for one card." The code contradicts its own stated contract.

Net effect: a partner submitting 20 cards is invoiced for 20 and debited 1 credit.

Display half (Agent 6 F-09): `submission-service.ts:334` stores the per-card price verbatim
into `estimated_price_pence`, rendered as "Estimated price: £12.00 — price confirmed by
MintVault" (`client/src/pages/partner/submission-detail.tsx:79-80`) regardless of card count.
Also `addCard` increments `card_count` by 1 per ROW, ignoring each card's own `quantity`
(`submission-service.ts:475`), so `card_count` itself understates true volume.

Test blindness: every fixture in the new 1,604-line
`tests/partner-submission-credit-lifecycle.test.ts` uses a single-card draft
(`makeDraftFor` :176-190, `makeDraft` :213+). No multi-card test exists.

**LOAD-BEARING OWNER QUESTION — blocks the repair design.** Are partner credits sold per
CARD or per SUBMISSION? Every artefact in the repo (the `price_per_card_pence` column, the
unique index, the service header) says per card. If per card, this is a revenue defect and
the fix changes reservation cardinality, which forces rework of the SQL definer function
(`migrations/0041:535-542` treats `count(*) <> 1` as corruption), `findReservationForPartnerSubmission`,
`hasExactConsumedEvidence`, and the portal balance projections — plus an owner decision on
whether existing staging reservations are backfilled. Classification E. NOT a local edit.

---

## HIGH

### H1 — Expiry sweep aborts the whole batch on one poison row and wedges permanently
**REPORTED (Agent 2 F1), Lead-verified in part.** `server/partner/partner-credit-reservation-service.ts:837-861`.
The catch at `:854-859` swallows only `RESERVATION_NOT_ACTIVE`, `IDEMPOTENCY_CONFLICT`,
`WALLET_INACTIVE`; anything else rethrows and kills the batch. `createDestinationHoldForExpiredReservation`
(`:758`, `:774`) throws non-retryable `INTERNAL_ERROR` on an ambiguous destination mapping or
a conflicting hold, and the unguarded hold INSERT at `:781` (no `ON CONFLICT`) can raise a raw
`23505`, which is not a `CreditReservationError` at all and takes the same rethrow branch.
Because selection order is deterministic (`ORDER BY expires_at ASC, created_at ASC`, `:831`),
the same poisoned row heads every subsequent hourly tick — no reservation anywhere expires
again until an operator intervenes. Credits stay reserved and unavailable. Visible only as a
repeating log line (`server/index.ts:447`), no alert. Classification C.

### H2 — Two authoritative wallet/ledger suites narrowed to older schemas
**VERIFIED by Lead.** Both previously ran the full set (`applyMigrations(migrator, listMigrationFiles())`).
- `tests/partner-wallet-service.test.ts:50` → `.filter(f => Number(f.number) <= 16)`
- `tests/partner-credit-admin-service.test.ts:219` → `.filter(f => Number(f.number) < 19)`

The `<= 16` filter drops **0017**, which carries `trg_partner_credit_ledger_preserve_active_reservations`
(`migrations/0017:194-224`) — the DB-level negative-balance backstop. The G6A wallet suite
therefore no longer runs against the trigger that makes a negative balance structurally
impossible. **The stated rationale ("G6D requires the separate owner-operated 0041 deployment
path") only justifies excluding 0041 — i.e. `< 41`. Both filters are materially broader than
their own justification.** Classification F.

### H3 — Authorised Super Admin recovery permanently bricks the connector release path
**REPORTED (Agent 3 G6D-02).** `partner-submission-credit-lifecycle.ts:1001-1010` mints a
SECOND `source='portal'` reservation with the SAME `submission_reference`. The TS reader
tolerates exactly 2 rows via an allow-list (`:182-206`); the SQL definer function has no such
exception and treats `count(*) <> 1` as `corrupt_linkage` (`migrations/0041:535-542`).
Reservations are immutable, so after any recovery the count is 2 forever and every subsequent
connector terminal transition (reject/cancel/validation/reconciliation/permanent-failure —
4 call sites) fails closed with `credit_lifecycle_invariant`. A second recovery makes it 3,
which also defeats the TS allow-list, so the submission can then never be settled OR cancelled
by any path. Fails closed (no money leak) but is an operational lock-out. Classification C.

### H4 — Release/expire state machine implemented twice (TS + PL/pgSQL) and only one copy maintained
**REPORTED (Agent 3 G6D-03).** Root cause of H3. Documented divergences: recovery tolerance,
`source` value, idempotency-key shape, and `request_fingerprint` (TS = SHA-256 of canonical
request; SQL = `md5(k)||md5(k||':fingerprint')`). The fingerprints are not comparable, so a
TS-side retry after an SQL-side release surfaces as a spurious `IDEMPOTENCY_CONFLICT` rather
than an idempotent no-op. Data integrity still held by
`uq_partner_credit_reservation_events_terminal` (`0017:117-119`). Classification E.

### H5 — "Change customer" is a dead button
**VERIFIED by Lead.** `client/src/pages/partner/submission-wizard.tsx:426` calls
`onToggleCreate` → `setCreatingCustomer` (`:268`), but `creatingCustomer` is read only inside
the `else` branch at `:459` (i.e. when no customer is selected). `setCustomerId` is called
only at `:150` and `:162`, both with a value — never with `null`. Clicking "Change" on a
selected customer does nothing at all. Survived a ~300-line test suite because
`tests/partner-submission-wizard-ui.test.ts` is a source-STRING-assertion suite
(`readFileSync` + `expect(WIZARD).toContain(...)`) that cannot detect a no-op handler.
Classification B.

### H6 — `editSubmissionDraft` cannot clear fields, and reports success anyway
**VERIFIED by Lead.** `server/partner/submission-service.ts:342-347`:
`customer_id = COALESCE($3, customer_id)`, same for `internal_reference` and `intake_notes`,
with params bound `input.customerId ?? null` (`:355-360`). `COALESCE` conflates "not supplied"
with "explicitly clear". `PATCH` with `{customerId: null}` returns HTTP 200 and increments
`version`, while the value is unchanged — a silent failure. The client type explicitly permits
the null (`client/src/lib/partner-api.ts:315`).
**The correct pattern is already in the SAME statement** — `service_tier_code` uses a
`CASE WHEN $8 THEN $5 ELSE ...` sentinel (`:344`). This is an oversight, not a design choice.
Classification B/D. Blocks any clean fix of H5.

### H7 — A partner can never reopen a draft
**REPORTED (Agent 6 F-03).** The wizard is create-only: `useEffect` at
`submission-wizard.tsx:76` unconditionally calls `partnerSubmissions.create()` on mount. There
is no `/partner/submissions/:id/edit` route (`client/src/App.tsx:276-289`), and
`submission-detail.tsx` has no resume link — `tests/partner-submission-wizard-ui.test.ts`
actively ASSERTS its absence (a prior review deleted the dead link rather than building the
capability). Abandoned drafts are orphaned permanently; the Drafts counter only ever climbs.
Classification C.

### H8 — No scan/image attachment exists in the partner path at all
**REPORTED (Agent 6 F-04).** `migrations/0007_partner_submissions.sql:107-108` reserves
`front_image_key` / `back_image_key` as "reserved, unused until image upload is authorised
(Phase 2 §9)". Grep proves those columns are referenced ONLY in that migration — no `server/`
or `client/` code reads or writes them. Zero occurrences of `scan|upload|image|photo` in the
wizard. This diff does not advance it. Scope/expectation gap, not a code defect.
Classification C.

---

## MEDIUM (abbreviated — full detail in reviewer reports)

- **M1** Settlement silently skipped when the connector-import mapping row is hard-deleted →
  grading completes with no credit consumed (Agent 3 G6D-04, `lifecycle.ts:771-772`,
  `storage.ts:775-778`). Soft-delete IS fail-closed; only a hard row delete degrades.
- **M2** ABBA deadlock between the expiry job and the settlement path (Agent 3 G6D-05).
  Opposite lock order on `submissions` / `partner_credit_reservations`. Aborts the hour's
  batch via H1. UNPROVEN — needs a deliberate two-session test.
- **M3** `BEFORE UPDATE` trigger now runs on EVERY `public.submissions` update including the
  ordinary consumer grading ladder; plus `certificates` and `label_prints`
  (Agent 3 G6D-06, `migrations/0041:277-293`). Core-path blast radius. Lead-flagged at Stage 0.
- **M4** `manualAdjustmentEnabled` hard-coded `true` regardless of wallet status; a suspended
  wallet still renders the adjustment control (Agent 2 F3, `dashboard-service.ts:760`).
- **M5** `portal-view-service.ts:103-112` duplicates the availability query instead of calling
  `getCreditPosition()`; also surfaces `consumed_reservations` (a `COUNT(*)`) as
  `consumedLifetime` (a CREDIT figure). Equal only while `reserved_credits = 1` — which B1's
  fix would change (Agent 2 F4).
- **M6** Portal credit API types re-declared in the client rather than `shared/` — violates
  the CLAUDE.md rule and breaks silently on rename (Agent 2 F5).
- **M7** Partner dashboard renders 7 submission-state cards for a 3-state machine; 4 are
  client-side literal `null` → "Not available". Honest text, but advertises four workflow
  stages that do not exist and have no server wiring point (Agent 6 F-05).
- **M8** Admin "Devices" tab renders browser sessions with a State column reading "Live" and a
  relative "Last seen" (Agent 6 F-06). Server explanation string above it is exemplary, but
  "Live" can be misread as scanner health.
- **M9** Tenant-predicate hardening applied in `submission-service.ts` was NOT applied to the
  identical pattern in `routes.ts:455-460` and `location.ts:33-36` (Agent 6 F-07). Not
  exploitable — RLS covers both. Consistency finding.
- **M10** `submitSubmission` and `cancelSubmission` moved from `withTenant()` (RLS) to
  `withPartnerAdminTenantTransaction()` (privileged role) (Agent 6 F-08). Every statement
  currently carries an explicit tenant predicate — Lead spot-checked and agrees — but tenant
  isolation on the two most financially significant transitions is now a hand-maintained
  invariant with no test and no CI guard.

## LOW

L1 silent catches around fail-closed evidence writes (G6D-08) · L2 release path mutates the
caller's `app.tenant_id` (G6D-09) · L3 full catalogue inspection on every settlement, ~6-8
extra round-trips (G6D-10) · L4 expiry throughput ceiling 100/hr (G6D-07) · L5 low-credit
threshold 3 vs 10 disagreement (Agent 2 F7) · L6 hand-rolled validators not Zod, though the
implementation is good (Agent 6 F-10) · L7 the two integration suites are env-gated and skip
by default (Agent 6 F-11).

---

## Lead corrections to reviewer claims

- Agent 6 implied every statement in the mutating paths carries a tenant predicate. The
  `UPDATE` in `editSubmissionDraft` (`submission-service.ts:351`) does NOT
  (`WHERE id=$1 AND version=$2`). **Not a defect** — that function runs under `withTenant()`
  (`:320`), so RLS scopes it. Checked rather than reported as a false positive.

## Confirmed CLEAN (signal, not absence of review)

Ledger genuinely append-only — no UPDATE/DELETE/TRUNCATE against `partner_credit_ledger`
anywhere in the repo; no stored balance column exists by design (`0016:29-42`); balances
derived from the `partner_credit_availability` view. Negative balance structurally impossible
(three layers incl. the 0017 DB trigger). Idempotency present and DB-enforced on every
credit-affecting write. Super Admin adjustments audited, actor from session never from body.
"Unknown" correctly distinguished from zero end-to-end (nullable types, `balanceStatus:
"unknown"`, UI renders "Unknown" not 0). No client-side credit arithmetic. Double-consume
refused by the DATABASE not just the app. All five SQL outcomes handled; `corrupt_linkage`
NOT swallowed — no fail-open. Expiry job correctly advisory-locked across Fly machines.
Reserve/consume/release each atomic with their state change. Scanner status honestly reported
as unavailable — no fabricated heartbeats anywhere in the repo.
