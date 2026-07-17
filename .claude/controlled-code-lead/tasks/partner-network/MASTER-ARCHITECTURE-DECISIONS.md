# Master Architecture Decision Register — Partner Network

Append-only. Each ADR is a settled decision; future agents follow these without re-litigating.
Status values: ACCEPTED (locked by owner) · PROPOSED (safe default, changeable) · SUPERSEDED.

---

## ADR-001 — Dedicated partner Fly application, not a mode of the existing app
**Status:** ACCEPTED (owner). **Context:** partners must not touch existing MintVault surfaces.
**Decision:** a separate Fly app with its own hostname, session cookie (`mv.partner.sid`), auth
routes, rate limits, secrets, emergency shutdown, deploy lifecycle, partner API, feature flags,
and monitoring. **Consequences:** partner traffic never shares the admin session/cookie; deploys
are independent; a partner incident cannot take down the main app's request path.
**Reuse boundary:** only narrow trusted services (MVGS, Pristine, cert allocation, label, NFC,
public publication) are shared, called as functions — never by proxying `/api/admin/*`.

## ADR-002 — Same Neon project for pilot, but a restricted partner role + RLS
**Status:** ACCEPTED. **Context:** standing up a separate Neon project is optional for pilot.
**Decision:** the partner runtime connects with a **non-privileged role** that can touch only
`partner_*` tables, all of which have Row-Level Security keyed to a per-transaction
`app.tenant_id` / `app.location_id`. The existing privileged all-table role is never used by the
partner runtime. Existing MintVault tables are not granted to the partner role.
**Consequences:** even an app-layer bug cannot read cross-tenant or existing MintVault data,
because the DB refuses it. Missing tenant context = no rows (fail closed). Revisit a fully
separate Neon project at expansion (Phase 22).

## ADR-003 — Dedicated private R2 buckets for partner assets
**Status:** ACCEPTED. **Decision:** new private buckets — one prod, one staging — never the
existing `mintvault-cards` bucket. Key model
`partners/{partner_id}/locations/{location_id}/cards/{card_id}/...`. Access only via short-lived
signed URLs minted after a server-side ownership check; the browser/app never holds permanent
credentials. Key construction is guarded (traversal assertion, like the VQ `assertVqReadKey`
precedent). **Consequences:** partner evidence is physically separated from MintVault card images.

## ADR-004 — Separate partner auth stack; never `requireAdmin`
**Status:** ACCEPTED. **Decision:** partner principals authenticate through partner-only routes
and middleware (`requirePartnerAuth`, `requirePartnerCapability`). No partner session flag ever
satisfies `requireAdmin`; no broad numeric-ID `/api/admin/:id` route is exposed or proxied to a
partner. Ownership is derived server-side from session + device, never from browser input.
**Consequences:** the ~230 existing admin IDOR-surface routes are structurally unreachable by
partners.

## ADR-005 — Central MV certificate sequence with internal PARTNER origin metadata
**Status:** ACCEPTED. **Decision:** partner certs use the existing central MV `cert_counter`
sequence (server-allocated, atomic), with **no visible separate range**. Store internal metadata:
`origin_type=PARTNER`, `partner_id`, `location_id`, `assessment_technician_id`,
`supreme_grader_id`, `field_authentication_officer_id`, `assessment_device_id`,
`sealing_device_id`. Allocation happens only after all grading/approval gates. Devices never
preallocate/select/edit numbers. **Consequences:** public verification is uniform; provenance is
internal.

## ADR-006 — Separate status fields, never one generic "approved" flag
**Status:** ACCEPTED. **Decision:** a partner card carries independent `grading_status`,
`authentication_status`, `physical_verification_status`, `nfc_status`, `sealing_status`,
`certificate_status`. Server-enforced state machine; no client can skip a transition.

## ADR-007 — Separation of duties across three roles + trusted server
**Status:** ACCEPTED. **Decision:** Assessment Technician (capture only), Supreme Grader (final
grade), Field Authentication Officer (physical auth + seal). No single human controls the whole
process. The trusted server enforces the workflow, allocates the cert number, consumes the
credit, and publishes. Field officer cannot casually change grades; disagreements return to the
Supreme Grader; every grade change is versioned with reason + decision-maker.

## ADR-008 — Append-only credit ledger; balance is derived
**Status:** ACCEPTED. **Decision:** `partner_credit_ledger` is append-only (PURCHASE,
ISSUE_FROM_PAYMENT, RESERVE, RELEASE, CONSUME, REFUND, CHARGEBACK, REVERSAL, EXPIRY,
ADMIN_ADJUSTMENT, PROMOTIONAL, VOID), each entry with an idempotency key + correlation id.
Balance = sum of valid entries; never a stored mutable column. Credits created only by the
verified Stripe→server path or an authenticated Super Admin adjustment (reason + re-auth +
audit). Reserve at submission start; consume at controlled completion, in one atomic
transaction with row locking. No negative balances; no partner-created credits/discounts/prices.
**Reuse:** the existing `stripe_webhook_events` dedup + reserve/consume patterns are templates —
the partner ledger is a NEW table family (do not overload `member_credits`/`estimate_credits`).

## ADR-009 — Device-bound capture and sealing
**Status:** ACCEPTED. **Decision:** evidence capture requires approved user + approved Mac +
approved scanner + signed request (device key in Keychain/Secure Enclave) + nonce/replay
protection + allowed app version. Sealing requires approved Field Officer + registered welder +
registered mobile device. Serial number is never the sole mechanism. Server-side revocation +
per-device kill switch.

## ADR-010 — Locked pilot commercial model (£20 retail / £15 credit / £5 profit)
**Status:** ACCEPTED (owner). Prepaid wholesale credits only; bundles 10/25/50/100, centrally
priced; single MintVault Stripe account; test mode for local build. No Connect/payouts/splits/
auto-top-up/borrowing/negative balances in pilot. VAT configurable and **flagged for accountant
confirmation before production** (blocker in the master plan §12).

## ADR-011 — Migration safety is a hard prerequisite (Phase 0.5)
**Status:** ACCEPTED, delivered `3e2dda03`. **Decision:** no `db:push` to staging/prod ever;
numbered migrations via `db:migrate` with journal + advisory lock; fail-closed preflight across
all object types; destructive-SQL linter; fail-closed allowlist config. All partner migrations
follow this workflow. Partner tables get their own `drizzle-partner.config.ts`
(`tablesFilter: ["partner_*"]`) and `"!partner_*"` added to the main allowlist.

## ADR-012 — Partner tables are a new `partner_*` family; minimal additive touch to existing
**Status:** PROPOSED (safe default). **Decision:** all partner data lives in new `partner_*`
tables. The only touch to existing tables is an additive nullable `tenant_id`/`partner_id` on
`certificates` (and `submissions` if a partner order links there), NULL = MintVault first-party,
added via the Phase 0.5 numbered-migration workflow, indexed before any hot partner query. If a
change would require altering existing table semantics, STOP and escalate.

## ADR-013 — Field officer allowed outcomes are a closed set
**Status:** ACCEPTED. `APPROVE | HOLD_FOR_HQ_REVIEW | REJECT_AUTHENTICITY |
REJECT_IDENTITY_MISMATCH | REJECT_CHAIN_OF_CUSTODY | REJECT_LABEL_OR_NFC_MISMATCH`. No free-form
grade edit at the field stage.

## ADR-014 — Anti-substitution chain of custody
**Status:** ACCEPTED. Tamper-evident numbered packaging linked to the submission; card
photographed with the packaging number; image fingerprint/comparison reference created at scan;
field officer verifies packaging number + tamper state and compares the physical card to the
original scans before sealing. High-value cards get extra evidence + dual control + mandatory HQ
review.
