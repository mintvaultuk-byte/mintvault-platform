# Partner Network Phase 2 — Product Specification

Status: DRAFT — implementation in progress on `feat/partner-network-phase-2-portal`.
Base: Phase 1 merged at `759baa43`. Portal remains unmounted; all flags OFF.

## 1. Scope of this pass

Phase 2 as specified is a multi-week programme (full dashboard, submission workflow,
tracking, user/location management UI, billing UI, documents, notifications). This pass
implements one complete, real, tested **vertical slice** covering the core objective —
sign in → MFA → location select → create submission → add cards → save draft → submit →
controlled handoff → track status → audit — plus the RLS/security/idempotency guarantees
that slice requires. Screens and features not in this slice are explicitly listed in
"Deferred to a later Phase 2 pass" (§9) rather than stubbed and claimed complete.

## 2. Roles and permissions (reuses Phase 1 RBAC — no new permission system)

Phase 1's `partner_roles`/`partner_permissions`/`partner_role_permissions` already define
`partner.orders.view`, `partner.orders.create`, `partner.cards.view`, `partner.cards.receive`,
`partner.cards.scan`, `partner.cards.assess`. This pass treats **"orders" = "submissions"**
(same noun, matching the existing RBAC) and adds three new permissions:
`partner.orders.edit`, `partner.orders.submit`, `partner.orders.cancel`.

| Permission | Owner | Manager | Reception | Technician | Finance | Trainee |
|---|---|---|---|---|---|---|
| orders.view | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| orders.create | ✓ | ✓ | ✓ | — | — | — |
| orders.edit (own drafts) | ✓ | ✓ | ✓ | — | — | — |
| orders.submit | ✓ | ✓ | ✓ | — | — | — |
| orders.cancel | ✓ | ✓ | — | — | — | — |
| cards.view | ✓ | ✓ | ✓ | ✓ | — | ✓ |

Location-scoping is enforced separately from role permission (§4): a Reception/Technician
user only ever sees submissions bound to their assigned location(s); Owner/Manager see the
whole organisation. This mirrors the "no organisation-wide power merely from one location
membership" rule and is enforced by RLS, not just application code.

## 3. Submission status state machine (implemented subset)

Partner-side:
```
draft --(edit)--> draft
draft --(submit, all required fields + ≥1 card)--> submitted_to_mintvault
draft --(cancel)--> cancelled
submitted_to_mintvault --(cancel, before handoff picked up)--> cancelled   [rare/audited]
```
MintVault-side (post-handoff, not partner-editable): `received` is set the moment the
handoff row is created; further internal states (`intake_check`, `grading`, ...) are out of
scope for this pass — the handoff table's own status is the tracked signal Phase 2 exposes
to partners (`pending`, `applied`, `failed`). A fuller internal-state mirror is deferred (§9).

Transition table lives in code (`server/partner/submission-service.ts`), not free text —
every transition is validated server-side, permission-checked, and audited.

## 4. Data model (migration 0007, isolated — see architecture decision below)

**Architecture decision (per Stage 1 audit):** `submissions`/`cards`/`certificates` have
zero tenant column and Phase 1 explicitly forbids bolting one on. Partner intake therefore
lives in **new, isolated, RLS'd `partner_*` tables**, never writing directly into the
existing MintVault submission pipeline. A handoff record is the only bridge, and even that
does not yet materialize a real `submissions` row in this pass (see §9) — it is the
audited, idempotent boundary the spec requires, ready for a future controlled connector.

Tables (all `tenant_id`, FORCE RLS, policy `tenant_id = partner_current_tenant()`):

- `partner_customers` — customer reference data for a partner's own book (name, email,
  phone; email/phone optional per data-minimisation default, see §8).
- `partner_submissions` — one row per intake ("order"): org/location/creating user, customer
  ref, service tier (config-driven, not hardcoded retail prices — see §8), card count,
  estimated price, status, draft/submit timestamps, cancellation metadata, `version` column
  for optimistic-concurrency (stale-draft protection), `idempotency_key` unique-per-tenant.
- `partner_submission_cards` — per-card intake row: sequence number (unique per submission),
  identification fields, declared value, non-binding intake observations, soft-delete via
  `removed_at`, no grade/cert/label fields (enforced by omission — the table has no such
  columns at all, so a partner literally cannot write one).
- `partner_submission_events` — append-only audit trail of every status transition (actor,
  from/to status, reason, timestamp) — the "activity timeline".
- `partner_submission_handoffs` — one row per successful submit, idempotent on
  `submission_id` (unique), records handoff status + a JSON snapshot of the submitted data
  for audit, so a retried submit can never create two handoffs.

## 5. API surface (new routes under the existing isolated `/api/partner` app)

```
GET    /api/partner/dashboard/submissions        summary counts, location-aware
GET    /api/partner/submissions                  list, paginated, filter by status/date
POST   /api/partner/submissions                   create draft
GET    /api/partner/submissions/:id               detail incl. cards + timeline
PATCH  /api/partner/submissions/:id               edit draft (version-checked)
DELETE /api/partner/submissions/:id               cancel draft
POST   /api/partner/submissions/:id/cards          add card
PATCH  /api/partner/submissions/:id/cards/:cardId  edit card
DELETE /api/partner/submissions/:id/cards/:cardId  remove card (soft)
POST   /api/partner/submissions/:id/submit         submit (idempotency-key required) → handoff
```

Consistent error shape: `{ error: { code, message } }` — no raw DB errors ever returned.

## 6. Handoff design (§ "Controlled handoff")

On submit: validate → open a transaction → lock the submission row (`FOR UPDATE`) →
re-check status is `draft` → snapshot the submission+cards as JSON → insert
`partner_submission_handoffs` (unique on `submission_id`, so retries hit the uniqueness
constraint, not a duplicate) → insert a `submitted` event → update submission status →
commit. Idempotency key is additionally checked/stored so a double-click with the same key
returns the existing result rather than erroring. This pass stops at the audited handoff
record; actually creating a real `submissions`/`cards` row in the trusted MintVault pipeline
is intentionally deferred to a Super-Admin-reviewed connector (§9) — this pass proves the
boundary is safe, not that it's wired to production intake.

## 7. Security (reuses Phase 1 primitives, adds tests for the new surface)

Every new route runs through the existing `requirePartnerAuth` + `requirePartnerCapability`
+ `withTenant` stack. Location scoping added: reception/technician roles' queries are
additionally filtered to `partner_user_locations` for that user. New tests (§ "Test
strategy") cover IDOR (forged submission/card ids across tenant and across location),
IDOR via IDs, IDOR across tenant, stale-version conflict, duplicate-submit-with-same-key,
duplicate-submit-with-different-key-after-first-succeeded, oversized input, malformed
pagination, cross-tenant IDOR, and RLS enforcement independent of the app layer.

## 8. Owner decisions surfaced (not invented)

Per instruction, these are NOT guessed — implemented with safe, clearly-labelled defaults
and flagged as launch blockers:

1. **Partner pricing** — no approved partner rate card exists. Implementation uses a
   `partner_service_tiers` config table (Phase 2, tenant-nullable = global default) seeded
   with the *retail* tiers from `shared/schema.ts` `pricingTiers`, but the UI always labels
   the number "Estimated — price confirmed by MintVault" and the field is a
   super-admin-editable config row, not a hardcoded partner price. **Owner decision
   required before launch: approve real Partner wholesale rates.**
2. Whether partners charge customers directly, or MintVault invoices the partner — not
   implemented (no billing collection this pass); billing surface is deferred (§9).
3. Whether customer email/phone/address are mandatory — implemented as **optional** fields
   (data-minimisation default) until an owner decision sets them mandatory.
4. Whether card images are mandatory — implemented as **optional**, and image upload itself
   is deferred to a later pass (no live storage infra authorised this task); the schema has
   the columns reserved but unused.
5. Whether partners may edit/cancel after submission — implemented as: edit is blocked once
   `submitted_to_mintvault`; cancel-after-submit is allowed but rare/audited (marked in the
   state machine) pending an owner-approved correction-flow policy.
6. Whether one org sees all locations by default — implemented as **no**: Owner/Manager see
   the org; Reception/Technician see only their assigned location(s) — least privilege
   default, per instruction.
7. Whether Partner submissions enter the same physical queue as public submissions, and SLA
   differences — not decided; this pass stops at the audited handoff boundary rather than
   assuming an answer.

## 9. Deferred to a later Phase 2 pass (explicitly NOT built now)

- Real connector from `partner_submission_handoffs` into a live `submissions`/`cards` row
  in the trusted pipeline (needs its own Super-Admin-reviewed design — this pass proves the
  audited/idempotent boundary only).
- Card image upload (needs an approved storage abstraction; no live bucket authorised).
- User/location management UI (Phase 1 already has the underlying admin-shell APIs; this
  pass does not add partner-self-service screens for it).
- Billing/statements UI, document/PDF generation, notification delivery integration (outbox
  model prepared conceptually in `partner_submission_events`, no live email/SMS).
- Super Admin Phase-2 additions (submission search/inspect/retry-handoff) beyond what
  Phase 1's control shell already exposes.
- Full internal MintVault-side status mirror beyond the handoff's own `pending/applied/failed`.

These are not weaknesses of this pass — they are correctly out of scope for a single
controlled increment and are recorded here so they are never silently assumed done.
