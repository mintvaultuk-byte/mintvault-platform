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
separate Neon project at **Phase 23 (Future Expansion, ADR-019)**, not the pilot review (Phase 22).

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

## ADR-015 — Digital Chain of Custody checkpoint system
**Status:** ACCEPTED. **Context:** custody must be provable at every physical transition, not just
recorded ad hoc. **Decision:** a partner card passes through an ordered, server-enforced set of
**custody checkpoints**, each an immutable event: `RECEIVED`, `ARRIVAL_PHOTOS`, `PACKAGED`
(tamper-evident numbered packaging linked + photographed), `STORED`, `SCANNED`, `HANDOVER_*`
(each physical handover), `FIELD_CUSTODY_VERIFIED`, `SEALED`, `COLLECTED`. Each checkpoint records
actor + device + timestamp + location + evidence ref + (where relevant) packaging number and
image-fingerprint reference. Checkpoints are append-only; the workflow state machine refuses to
advance if the required checkpoint is missing. **Consequences:** any gap or out-of-order transition
is detectable; the Field Authentication Officer verifies the packaging number and tamper state
against the `PACKAGED` checkpoint before sealing (anti-switch, ADR-014). Stored in
`partner_custody_checkpoints`.

## ADR-016 — "MintVault Verified" outcome
**Status:** ACCEPTED. **Context:** the public must be able to tell a dual-verified partner-graded
card from an ungraded/incomplete one. **Decision:** a partner certificate reaches the public
**MintVault Verified** outcome ONLY after the full dual-verification chain completes — credit
reserved, shop evidence complete, Supreme Grader approved, Field Authentication Officer approved,
authenticated, correct label, NFC verified, sealed, final photos present. The public certificate
page shows a "MintVault Verified — processed through a MintVault Approved Grading Centre and
independently approved under the MVGS dual-verification process" status, without exposing private
technician/officer identities. `certificate_status` becomes `VERIFIED` only at that gate; nothing
earlier may present as verified. **Consequences:** "MintVault Verified" is a controlled outcome,
never a partner-settable flag; the credit consumes at the same gate.

## ADR-017 — Partner Accreditation Levels
**Status:** ACCEPTED. **Decision:** partners carry an evidence-based level:
`PROVISIONAL_PARTNER → APPROVED_PARTNER → SILVER_PARTNER → GOLD_PARTNER → PLATINUM_PARTNER`.
Level may adjust configurable operational parameters only: daily submission limits, active-card
limits, declared-value limits, credit-bundle access, QA monitoring frequency, document-review
frequency, approved location/technician counts, priority support, approved marketing permissions.
**A level NEVER bypasses** central Supreme Grader approval, Field Officer approval (pilot),
payment/credit controls, chain-of-custody, device security, authentication, NFC validation,
ultrasonic sealing, or certificate-publication gates. Upgrades require authorised MintVault
approval (system may recommend + explain, never auto-grant). Critical policy failures may
auto-downgrade/suspend/hold with an immutable audit trail. Stored on `partner_organisations`
(`accreditation_level`) + `partner_accreditation_events`.

## ADR-018 — Ultrasonic welder governance
**Status:** ACCEPTED. **Decision:** every ultrasonic welder is a registered asset in the
MintVault-internal (super-admin) registry **`field_welders`** — NOT a tenant-scoped `partner_*`
table (no RLS tenant predicate; MintVault-owned): machine id, serial, assigned officer, service
date, calibration date, fault
history, seal count, status (`ACTIVE|SERVICE_DUE|PAUSED|QUARANTINED|LOST_OR_STOLEN|RETIRED`),
location history, last use. A card cannot reach sealed/completed if the welder is unapproved,
service-expired, or the assigned officer is unauthorised, or NFC read-back fails, or final photos
are missing. Seal events reference the welder id + officer + device. **Consequences:** every seal
is attributable to a governed machine; a quarantined/retired welder cannot complete cards.

## ADR-019 — Phase 23 Future Expansion (placeholder, gated)
**Status:** PROPOSED. **Decision:** post-pilot expansion candidates are recorded but NOT built in
this programme: additional grading service tiers, higher-value card handling, automated field-route
planning, reduced-QA sampling for proven partners, larger/auto-top-up credit models, Stripe
Connect / partner payouts, multi-region operations, additional partner marketing surfaces, and a
separate Neon project + fully separate infra per ADR-002's revisit. Each is a future programme with
its own owner approval, threat model, and pilot. Nothing in Phase 23 may weaken tenant isolation,
financial integrity, or grading integrity.

## ADR-020 — Field Authentication Officer auth stack (resolves review finding 6)
**Status:** ACCEPTED. **Context:** the Field Officer is MintVault-internal staff, but their
endpoints live in the partner app and ADR-004 forbids `requireAdmin` on partner-app routes.
**Decision:** the Field Officer authenticates as a **dedicated MintVault-internal field-officer
principal** — a distinct auth stack (`requireFieldOfficer`), NOT the partner principal
(`mv.partner.sid`) and NOT the broad admin `requireAdmin`. It uses its own cookie/token namespace,
mandatory MFA, and a registered mobile device (a `partner_devices` row of type `mobile`, ADR-009).
The `/api/partner/field/*` routes are served by the partner app but gated by `requireFieldOfficer`,
which resolves the officer identity + assigned visits server-side and grants access only to cards
on assigned field visits — never to arbitrary partner or MintVault data. **Consequences:** the
officer sees only assigned visits; no partner user can assume the officer role and vice versa; the
officer never gains `requireAdmin` or partner-tenant data access beyond assigned cards.
