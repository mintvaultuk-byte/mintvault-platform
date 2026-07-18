# Phase 0 — Approved Grading Partner Network: Discovery Audit & Architecture Proposal

**Date:** 2026-07-17
**Branch at audit:** codex/grading-two-column-workstation @ b5fe522c (clean)
**Method:** 6 read-only specialist reviewers (backend/auth, security, database, provider/Stripe, grading pipeline, infrastructure), findings verified by the Lead against source.
**Status:** READ-ONLY. No files changed, no migrations, no commits, no pushes, no deploys.

---

## 0. Bottom line up front

MintVault today is a **single-tenant, single-admin** system. It is well-built for that: the grading engine, Stripe flow, cert allocation, and staff-capability auth are all sound. But **nothing in it is multi-tenant**. There is no organisation concept, no tenant column on any table, no Row-Level Security, one shared login cookie, one shared scanner token, one Stripe account, one storage bucket with prefix-only separation, and ~230 admin routes that resolve a certificate straight from a client-supplied numeric id with no ownership check.

That last point is the crux: **the moment a non-owner (a partner) is given any admin-equivalent access under the current patterns, roughly 230 endpoints become cross-tenant data-leak / cross-tenant write holes (IDOR).** So the partner network cannot be "admin panel with extra users." It has to be a **separate, parallel surface** with its own auth principal, its own tenant-scoped data access, and defence-in-depth at the database layer.

The good news: the pieces you'd *reuse* are cleanly separable. MVGS scoring, the Pristine gate, cert-id normalisation, label/certificate rendering, TCGdex, and the `/api/v1/verify` endpoint are all effectively pure functions or self-contained services. The partner system wraps new tenant-aware routes around those, rather than modifying them.

**Recommendation: yes, but build it as an isolated parallel system with a hard tenant boundary at the DB layer, and refactor five foundations first (below) before any partner-facing code ships.** Do not bolt partner users onto the existing admin surface.

---

## 1. Existing architecture map

```
Browser (React SPA, Wouter, TanStack Query)
  │
  ▼
Express (server/index.ts)  — single Fly app "mintvault" (prod), "mintvault-v2" (staging), ~2 machines, lhr
  ├─ /api/stripe/webhook   (raw body, mounted BEFORE express.json — correct)
  ├─ express.json + session (connect-pg-simple, cookie "mv.sid", PG-backed)
  ├─ /api/admin/*          requireAdmin  (single hardcoded admin identity)
  ├─ /api/staff/*          requireCapability(grade|scan|print|editSets)  ← best-built auth surface
  ├─ /api/grader/*         requireCapability + per-cert ownership (authorizeGraderCert)
  ├─ /api/admin/scan-ingest  requireScannerOrAdmin  (static shared token)
  ├─ /api/cert/:id, /api/v1/verify/:certId, /api/nfc/:certId  (public, PII-scrubbed)
  ├─ /api/create-payment-intent, /confirm-payment  (Stripe)
  └─ /* → static SPA (dist/public)
  │
  ▼
server/storage.ts (IStorage, 85 methods) → single privileged pg.Pool → Neon Postgres
server/r2.ts → single Cloudflare R2 bucket (prefix-only separation)
External: Stripe (1 account), Resend, Anthropic, TCGdex, B2 (cold archive)
```

Route code is split between a **12,184-line `server/routes.ts` monolith** (~176 routes) and 18 files under `server/routes/` (~14k lines). New route families already go in the split dir — the established pattern.

---

## 2. Auth & role map

- **One admin.** Hardcoded `ADMIN_EMAIL` (a single literal address; see `server/auth.ts:16`); `requireAdmin` validates the session against that single row. **No super-admin vs admin distinction exists anywhere** (grep: zero hits).
- **Two-step admin login:** password (bcrypt `admin_passphrase_hash`, env `ADMIN_PASSWORD` break-glass) → 6-digit PIN (bcrypt `pin_hash`) → session. `session.regenerate()` on every privilege change (fixation defence — good). Absolute caps: admin 7d, staff 14d.
- **Staff = capability flags, server-enforced.** `users.can_grade/can_scan/can_print/can_edit_sets`, checked via `requireCapability()` with **per-request DB re-validation + credential_version + fail-closed** (`server/staff.ts:143-197`). This is the strongest auth surface in the codebase and is the correct template for partner permissions.
- **One shared cookie `mv.sid`** across admin/staff/grader/customer, with mutually-exclusive role flags — a second login type in the same browser **evicts** the first (known `session-cookie-clobber`). A partner login on this cookie would clobber admin/staff sessions.
- **Scanner auth = static shared secret.** One `SCANNER_API_TOKEN` (header, timing-safe) authenticates every scanner Mac; operator attribution is an unauthenticated `x-scanner-operator` email header (honor-system). **No device registration, no per-device identity, no per-device revocation anywhere** — grep confirms zero device concept.
- **Client gating is cosmetic** (tab visibility) on top of real server enforcement — verified, not a vulnerability today.

---

## 3. Payment map

- **All money math is server-side** (`server/services/gradingQuote.ts`); client sends no amount. Grading is a Stripe **PaymentIntent** (no Stripe coupons — promos reduce the PI amount server-side).
- **Webhook is solid:** raw body before `express.json()`, signature-verified with dual-secret fallback, event-id idempotency table (`stripe_webhook_events`, `ON CONFLICT DO NOTHING`), atomic single-winner `markSubmissionAsPaid`.
- **Historical audit issues are now CLOSED in code** (verified): confirm-binding gap (PI bound to submission + server amount), credit double-spend (atomic reserve/consume + partial unique index), promo over-redeem (reserve-at-checkout with in-UPDATE cap guard). ⚠️ Project memory still lists the two TOCTOU races as "OPEN pending owner approval" — the code shows them fixed; **you should formally sign these off so memory stops flagging them.**
- **Gaps found:** (a) **no refund/dispute handling at all** — a refunded order stays fully fulfilled, credits stay consumed, grading proceeds; (b) the **estimate-credits webhook branch has no event-id dedup** — a replayed Stripe event double-credits; (c) no Stripe idempotency keys on create calls; (d) no test/live-mode guard (local `.env` has LIVE keys).
- **No generic prepaid grading-credit ledger exists** — only Vault Club `member_credits` (mutable rows) and AI `estimate_credits` (mutable balance). A partner credit system is net-new.

---

## 4. Grading / scanner / NFC map

- **Pipeline:** submission (payment, optional link) → `POST /api/admin/scan-ingest` (front/back, content-hash idempotency) → AI identify + TCGdex → MVGS draft → submit → approve (publish gate = `grade_approved_at IS NOT NULL`) → label → certificate → NFC register.
- **MVGS scoring, Pristine/black-label gate, B3 sub-grade gate, cert-id, labels, certificate document, TCGdex, variant-derive** are all pure / self-contained and **PROTECTED** (owner directive — reuse, never modify).
- **"Approve → lock" is an audit convention, not a hard lock** (verified `routes.ts:7044-7052`, `:6866-6870`): an approved cert can be re-edited by the same SQL path (logged as a live-record edit), and `/approve` can be re-called on an already-approved cert. Fine for a single trusted admin; **a partner system needs real post-publish immutability/versioning as a new layer.**
- **Label & print-batch endpoints have no approval precondition** (verified `routes.ts:4237`, `:4372`) — a label can render for an ungraded cert. Admin-only today; would need a server-side gate before partner exposure.
- **NFC:** registry-on-`certificates` with DB-level UID uniqueness + reassign-overwrite guard. **No tag-writing code in repo** — writing is external hardware; server only records UID/URL after the fact. URL scheme `https://mintvaultuk.com/cert/{certId}`.
- **Scanner app** is in-repo (Electron `scripts/scanner-app/` + legacy watcher); assumes one shared token + local hot-folder on the operator's Mac.

---

## 5. Current security risks (verified)

| # | Risk | Evidence | Impact for partner system |
|---|---|---|---|
| S1 | **No RLS, single privileged DB connection** | `server/db.ts`; grep: zero policies | All tenancy would be app-layer only — one missed `WHERE` leaks cross-tenant |
| S2 | **~230 `requireAdmin :id` routes = IDOR under any non-owner principal** | `routes.ts:7044-7052` etc., resolve cert from `parseInt(req.params.id)`, no ownership | Cannot reuse admin routes for partners at all |
| S3 | **Ownership enforced by 3 different bespoke per-handler patterns** | email-match / `currentOwnerUserId` / `customerEmail` in 3 files | No single gate to trust; easy to omit |
| S4 | **Shared `mv.sid` cookie** | `index.ts:226` | Partner login clobbers admin/staff |
| S5 | **Scanner = one shared static token, honor-system operator** | `scanner-auth.ts:27-40` | No per-partner-device identity or revocation |
| S6 | **Single R2 bucket, prefix-only, presigned URLs are bearer tokens, cert keys lack traversal guard** | `r2.ts:182-188`; VQ keys ARE guarded, cert keys are not | Partner objects need per-tenant prefix/bucket + key assertion |
| S7 | **Sensitive artifacts unaudited: NFC write/lock/clear, label gen, reprint** | no `writeAuditLog` in `routes.ts:4237-5067` | "Which partner reprinted/rewrote this" is undecidable |
| S8 | **Admin login success/failure not in audit_log** (console only) | `admin-auth-session.ts:31-36` | Partner admin actions need durable audit |
| S9 | **Rate limiters + login-attempt counters are per-machine MemoryStore** | zero `store:` options; 2 machines | Brute-force limits are effectively N× |
| S10 | **DB schema DRIFT both directions** | 10 schema.ts tables absent from staging; ~24 live tables absent from schema.ts | Partner migrations must be verified per-host |
| S11 | **`db:push` on main config would propose DROPPING ~24 live tables** | `drizzle.config.ts:16` excludes only `vq_*` | Latent data-loss hazard; fix before adding `partner_*` |
| S12 | **No append-only value ledger** | all credit/promo balances mutate in place | Partner credits must be a new append-only ledger |

---

## 6. Proposed architecture

**Principle: parallel, isolated, tenant-scoped, defence-in-depth at the DB.**

```
Partner MacBook (signed MintVault Grading Agent — extends scanner app)
  │  device-bound key (Keychain/Secure Enclave), signed requests, nonce/replay protection
  ▼
Express — NEW /api/partner/* namespace (separate route files, separate cookie "mv.partner.sid")
  ├─ requirePartnerAuth   → resolves {tenant_id, location_id, partner_user_id, device_id} from session+device
  ├─ requirePartnerCapability(...)  → partner permission namespace (partner.cards.grade, partner.nfc.write, ...)
  ├─ requireActiveDevice + requireAppVersion + requireDocsCurrent + requireAccreditation  (server-side, every sensitive call)
  ▼
Partner service layer (NEW) → tenant-scoped storage wrapper (mandatory tenant filter, fail-closed)
  → Postgres with RLS on partner_* tables (SET LOCAL app.tenant_id on a non-superuser role)
  → reuses PROTECTED pure services: mvgs-scoring, pristine, cert-id, labels, certificate-document, tcgdex

Super Admin — NEW /super-admin/grading-partners/* (extends existing admin, MintVault-only permissions)
  → device control centre, kill switch, QA queue, strikes, credits, documents, reconciliation

Storage: per-tenant R2 prefix partners/{tenant_id}/... (or per-tenant bucket for real isolation)
Payments: reuse the verified webhook + PaymentIntent machinery; add partner credit event branch with dedup
```

**Super Admin retains sole control** of: tenant identity, credit creation/pricing, payment confirmation, certificate/NFC identity, device approval, accreditation, QA policy, global flags. Partners get a restricted permission namespace only.

---

## 7. Proposed database schema (new `partner_*` family)

Defined in **one** place (new `shared/partner-schema.ts` + `drizzle-partner.config.ts` with `tablesFilter: ["partner_*"]`, and add `"!partner_*"` to main config). Real FKs throughout. Append-only ledger from day one.

Core new tables (every partner-owned row carries `tenant_id`, most also `location_id`, `created_by`, `created_at`):

- `partners` (org identity, status, health) · `partner_locations` · `partner_users` (membership + partner role; do NOT overload `users.role`) · `partner_api_keys`
- `partner_devices` (device_id, public_key, app_installation_id, status, scanner/nfc/printer/sealer ids, revocation) · `partner_device_sessions`
- `partner_documents` (type, expiry, verification_status, version, hash) · `partner_grader_accreditation` · `partner_training_records`
- `partner_orders` · `partner_order_items` · `partner_customers` (minimal PII) · `partner_customer_terms`
- `partner_payments` · **`partner_credit_ledger` (APPEND-ONLY** — entries with direction, credit_type, idempotency_key, correlation_id; balance is derived, never stored) · `partner_credit_reservations`
- `partner_cards` (chain-of-custody state machine) · `partner_scans` · `partner_grading_sessions` · `partner_qa_reviews`
- `partner_nfc_tags` (unique nfc_uid) · `partner_labels` (print/reprint tracking) · `partner_slabs` · `partner_stock_ledger`
- `partner_strikes` (immutable) · `partner_strike_appeals` (reversal = new record) · `partner_incidents` · `partner_support_tickets` · `partner_messages`
- `partner_audit_log` (or extend `audit_log` with tenant_id) · `partner_feature_flags`

On existing tables: add a **nullable `tenant_id`** to `certificates` and `submissions` only (NULL = MintVault first-party), additive + indexed, per migration-discipline. If partners get their own cert-number ranges, use **one `cert_counter` row per namespace** — never extend the single-row counter's semantics.

---

## 8. Proposed route & service structure

- Partner-facing: `/api/partner/{orders,payments,credits,grading,customers,documents,training,support,stock,reports}` — all new files under `server/routes/partner/`, never in the `routes.ts` monolith.
- Super-admin: `/api/super-admin/grading-partners/:partnerId/{locations,users,devices,credits,documents,quality,strikes,stock,incidents,finance}`.
- Service layer: `server/services/partner/*` — handler bodies call tenant-scoped services, which call the tenant-scoped storage wrapper. **No partner handler ever calls `requireAdmin` or an admin route.**

---

## 9. Tenant-isolation strategy (defence-in-depth)

1. **Derive tenant/location/device from the authenticated session + device attestation** — never from browser-supplied `tenant_id`, URL, payload, or hidden field.
2. **DB layer (primary boundary):** RLS on all `partner_*` tables via `SET LOCAL app.tenant_id` on a **non-superuser** role. This is the ceiling given the current single-privileged-connection pattern.
3. **App layer (secondary):** a mandatory tenant-scoping storage wrapper that injects `WHERE tenant_id = $ctx` and **fails closed if tenant context is missing** — impossible to call a partner query without a tenant.
4. **Object storage:** per-tenant R2 prefix (min) or per-tenant bucket/credential (real isolation) + traversal-guard assertion on every signable key + ownership check before signing.
5. **Never trust** a client-provided credit id, certificate id, NFC id, or device id — always re-scope to the session tenant.

---

## 10. MacBook device-lock strategy

Extend the scanner app into a signed **MintVault Grading Agent**:

- Enrolment generates a device key pair; **private key in macOS Keychain/Secure Enclave**, public key registered server-side (`partner_devices.public_key`).
- Every sensitive action requires a **signed request** (device key) + valid session + valid tenant/location/device + current nonce (replay protection) + allowed app version + active device status + required permission + valid workflow state — all re-checked **server-side on every call**, not just at launch.
- Server-side revocation, per-device kill switch, app-version floor, emergency stop. A copied cookie / copied app / copied device id alone cannot grade.
- Serial number is never the sole mechanism.

---

## 11. Credit-ledger strategy

**Append-only `partner_credit_ledger` from day one** (the system has no ledger today — this must be new). Entry types: PURCHASE, ISSUE_FROM_PAYMENT, RESERVE, RELEASE, CONSUME, REFUND, CHARGEBACK, REVERSAL, EXPIRY, ADMIN_ADJUSTMENT, PROMOTIONAL, VOID. Every entry has an idempotency_key and correlation_id; **balance is computed from entries, never stored**; corrections are reversing entries, never edits. Credits are created only by the trusted server-side payment workflow or an authenticated Super Admin adjustment (with reason + re-auth + audit). Reuse the verified webhook dedup + reserve/consume patterns; **add event-id dedup to the credit branch (fixes the estimate-credits gap first).** Credit reservation + grading-session creation must be one atomic transaction with row locking (`FOR UPDATE`).

---

## 12. QA & three-strike strategy

- **Risk-scored central QA queue** (grader accreditation, shop history, strikes, declared value, grade awarded, speed, random sample). Outcomes: AUTO_APPROVE / REMOTE_HQ_REVIEW / FULL_MANUAL_REINSPECTION / HOLD. **Pilot = 100% central QA**; partner cannot print final label or publish cert before approval.
- **Three-strike system:** immutable `partner_strikes` (never edited/deleted), severity + category + evidence, standard progression (warning+retrain → suspension+reassessment → permanent removal), **critical-violation immediate-removal path** (fraud, credit manipulation, cert forgery, tenant-isolation attack). Appeals create **reversal records**, never mutate history. Separate grader-level vs shop-level quality status.

---

## 13. Phase-by-phase plan

Follows the owner's Section 46 (Phases 0–20). Each phase: isolated branch, tests, security review, migration review, rollback plan, final report, **no deploy without explicit authorisation.**

- **Phase 0 (this):** audit + architecture. ✅
- **Phase 1:** partner tenant/location schema, partner roles/permissions, feature flags, super-admin shell, **tenant-scoping middleware + RLS**, audit framework, isolation tests. No payments/grading yet.
- **Phase 2:** onboarding wizard, documents + expiry enforcement, accreditation/training records.
- **Phase 3:** device enrolment + cryptographic identity, approval queue, app-version enforcement, revocation, emergency stop, device-security tests.
- **Phase 4:** partner order + server-side pricing + verified payment (reuse webhook), refund/dispute handling.
- **Phase 5:** append-only credit ledger, idempotent issuance, reserve/release, chargeback restrictions, concurrency tests.
- **Phase 6:** partner dashboard + paid grading queue (only paid/authorised cards appear).
- **Phase 7:** chain of custody + scanning + calibration.
- **Phase 8:** controlled grading workflow (reuse MVGS as a service, server-side state machine, post-publish immutability).
- **Phase 9:** QA + accreditation.
- **Phase 10:** three-strike system.
- **Phase 11:** label/NFC/sealing + completion gate + cert publication.
- **Phases 12–17:** stock, notifications/collection, super-admin ops centre, reporting/reconciliation, support/diagnostics, backup/restore/disaster mode.
- **Phase 18:** security hardening + penetration test.
- **Phase 19:** controlled 1-shop pilot (≤20 credits, ≤20 cards/day, 100% QA).
- **Phase 20:** expansion review.

**Refactor-first foundations (before Phase 1 partner code):** (1) fix `drizzle.config.ts` drop hazard (S11); (2) durable rate-limit/attempt store (S9); (3) separate partner cookie (S4); (4) a single ownership/authorization service pattern (S3); (5) generalise the hardcoded admin into a role model (S2). These are prerequisites, not partner features.

---

## 14. Test plan

- Reuse the existing Vitest + ESLint + Prettier + Husky harness and the protected MVGS regression suite (must stay green — untouched).
- New required suites per Section 44: tenant isolation (A-cannot-see-B across every partner surface, missing-context-fails-closed), credits/payments (no client credit creation, duplicate-webhook no double-issue, refund/chargeback restrictions, concurrent reservation atomicity), device security (unapproved Mac blocked, revoked device stops, replayed signature fails, two Macs can't share one identity), workflow (no cert before payment, no label before approval, no completion without NFC/seal, no skipped transitions), documents/accreditation, stock (no NFC reuse, no negative stock, reconciliation detects mismatch).
- **Fill the current coverage holes** (payments + label rendering have zero tests) as part of Phases 4/11.

---

## 15. Rollback plan

- Every phase behind feature flags (global + per-partner + per-location + pilot allowlist + emergency shutdown) defaulting OFF.
- `partner_*` tables are additive; the two nullable existing-table columns (`tenant_id`) are additive with NULL = first-party, so first-party MintVault is unaffected if partner flags are off.
- Per-phase branch + captured rollback image via `scripts/safe-deploy.sh`; migration rollback SQL authored alongside each migration.
- Verify Neon PITR is actually enabled and rehearse one restore (currently unverified; no restore runbook for the main cert bucket — S-adjacent gap).

---

## 16. Exact files expected in Phase 1

**New (created):**
- `shared/partner-schema.ts` — partner tenant/location/user/role/permission tables
- `drizzle-partner.config.ts` — `tablesFilter: ["partner_*"]`
- `migrations-partner/0000_partner_foundation.sql` — tables + RLS policies + non-superuser role
- `server/middleware/partner-auth.ts` — `requirePartnerAuth`, `requirePartnerCapability`, tenant-context derivation
- `server/services/partner/tenant-scoped-storage.ts` — mandatory tenant filter, fail-closed
- `server/routes/partner/index.ts` + `server/routes/super-admin/grading-partners.ts` — route shells
- `server/config/partner-feature-flags.ts`
- `client/src/pages/super-admin/grading-partners.tsx` — super-admin shell
- `tests/partner-tenant-isolation.test.ts`

**Modified (minimal, additive):**
- `drizzle.config.ts` — add `"!partner_*"` to `tablesFilter` (and fix the `vq_*`-only drop hazard, S11)
- `server/index.ts` — mount partner router + separate `mv.partner.sid` session (or scoped path)
- `server/config.ts` — assert any new required env at boot
- `shared/schema.ts` — additive nullable `tenant_id` on `certificates` + `submissions` (deferred to when first-party linkage is needed; may not be in Phase 1)

No change to: MVGS files, Stripe webhook, labels, cert lookup, existing auth logic, Vault Quest.

---

## 17. Open questions (need owner or infra evidence)

1. **Commercial model:** Model A (customer-funded per-order credits) only for pilot, or Model B (shop-funded wholesale bundles) too? Affects credit-ledger design in Phase 5.
2. **Storage isolation level:** per-tenant R2 *prefix* (cheaper, prefix-only) or per-tenant *bucket/credential* (real isolation)? Recommend prefix for pilot, bucket for scale.
3. **Infra separation:** partner traffic on the existing `mintvault` Fly app (shares CPU with the sharp scan pipeline) or a dedicated app? Recommend shared for pilot, revisit at Phase 20.
4. **Cert numbering:** do partner-issued certs share the `MV` namespace and global counter, or get their own prefix/range? Affects public lookup + counter design.
5. **Prod DB state:** the drift finding (S10) is measured on STAGING only. Need a Lead-scoped prod read to confirm prod cert_counter health, prod table presence, and the prod `nfc_uid` constraint before Phase 1 migrations.
6. **Stripe model at scale:** Connect is explicitly deferred (Section 31) — confirm partners are billed on the single MintVault account for pilot.
7. **TOCTOU sign-off:** the two payment races memory lists as OPEN are fixed in code — confirm so we can close them.

---

## 18. Recommendation on refactoring existing code first

**Yes — five foundations must be refactored before partner-facing code, but none of them touch protected systems:**

1. Fix `drizzle.config.ts` so `db:push` can't propose dropping ~24 live tables (S11) — do this regardless of the partner project.
2. Move rate-limit + login-attempt counters to a durable store (S9).
3. Give the partner portal its own cookie (S4).
4. Introduce one ownership/authorization service and stop the three bespoke patterns (S3).
5. Generalise the hardcoded singleton admin into a role model, keeping the current account as the seed (S2).

Everything else is additive. The grading engine, Stripe flow, labels, and cert lookup are reused as-is via service extraction — not modified.

---

## Confidence

- **Design confidence: 80%** — architecture is well-grounded in verified evidence; the two unknowns are prod DB state and the commercial-model choice.
- **Verification confidence: 90%** — 6 specialist reviewers + Lead spot-checked the load-bearing claims (no RLS, no tenant column, drizzle drop hazard, IDOR surface, soft approve-lock) directly against source. Staging DB inspected; prod not.
- This is a **Design Only** deliverable — no implementation, no proof beyond source reading.

**No files changed · No migrations created · No commits · No pushes · No deployments · Awaiting approval before Phase 1.**
