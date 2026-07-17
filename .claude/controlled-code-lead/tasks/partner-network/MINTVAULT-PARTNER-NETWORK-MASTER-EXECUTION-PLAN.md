# MintVault Approved Grading Partner Network — Master Execution Plan

**Status:** DRAFT for master-plan approval. No Phase 1 code started.
**Owner:** Cornelius Oliver (founder). **Governance:** controlled-code-lead v1.1.
**Base commit for the programme:** `b5fe522c`. **Phase 0.5 delivered at:** `3e2dda03` (remote, unmerged).
**Last updated:** 2026-07-17.

This is the permanent spine of the programme. It is written so a future agent can continue
without reopening settled decisions. Settled decisions live in `MASTER-ARCHITECTURE-DECISIONS.md`
(ADRs). Running state lives in `MASTER-TASK-LEDGER.md`. Do not duplicate those here.

---

## 1. What we are building (one paragraph)

A fully isolated, professional partner system that lets approved card shops ("MintVault
Approved Grading Centres") receive customer cards, take the customer's payment, capture
scan + MVGS defect evidence, and hold cards securely — while **MintVault retains sole
control** of the final grade (Supreme Grader), the physical authentication and ultrasonic
seal (Field Authentication Officer), certificate identity, NFC identity, and credit/money.
The shop is an evidence-capture centre, never an independent final grader. Nothing about it
may reach existing MintVault customer data, direct submissions, admin/staff/super-admin
functions, other partners' data, or Vault Quest.

## 2. Non-negotiable invariants (carry into every phase)

1. **Tenant isolation** — a partner sees only its own location's cards/customers/orders/
   credits/stock/docs/staff/tickets. Enforced at the DB with RLS on a restricted role, and
   at the app with a fail-closed tenant-context middleware. Missing tenant context = deny.
2. **No `requireAdmin` for partners; no broad numeric-ID admin routes exposed.** Partner
   principals use a separate auth stack entirely.
3. **Money integrity** — immutable append-only credit ledger; credits created only by the
   verified Stripe→server path **or an authenticated Super Admin adjustment (reason + re-auth +
   audit; ADR-008)**; the shop can never create/edit/increase credits; no negative balances;
   one £15 credit reserved per card, consumed only at controlled completion.
4. **Grading integrity** — the shop never issues the final grade. Final grade is the Supreme
   Grader's; physical completion is the Field Authentication Officer's. Separation of duties
   is mandatory. MVGS scoring/pristine/cert-allocation/label/NFC are reused as-is (PROTECTED),
   never modified.
5. **Certificate identity** — central MV sequence, server-allocated only after all gates,
   never partner-selected/preallocated/editable. `origin_type = PARTNER` + internal metadata.
6. **Device binding** — sensitive capture requires approved user + approved Mac + approved
   scanner + signed request; sealing requires approved officer + registered welder + device.
7. **Storage isolation** — dedicated private partner R2 buckets (prod + staging), tenant-
   scoped key paths, short-lived signed URLs after server-side ownership check, never
   permanent credentials in the browser/app.
8. **Existing MintVault systems remain untouched and operational.**

## 3. Target architecture (summary; full detail in ADRs + MASTER-API-MAP)

- **Existing `mintvault` app** — unchanged: customers, direct submissions, staff/admin/super-
  admin, public cert lookup, protected grading.
- **New dedicated partner Fly app** — own hostname, own session cookie, own auth routes, own
  rate limits, own secrets, own emergency shutdown, own deploy lifecycle, own partner API,
  **restricted (non-privileged) DB role**, dedicated private R2 buckets, own feature flags,
  own monitoring.
- **Shared, deliberately-narrow services only:** MVGS scoring, Pristine gate, central
  certificate allocation, label rendering, NFC verification, public certificate publication —
  reached through trusted narrow server functions, never by proxying admin routes.
- **Same Neon project is acceptable for the pilot** ONLY with: RLS on all `partner_*` tables,
  a restricted partner runtime role, per-transaction tenant context, fail-closed on missing
  context, existing tables not directly reachable by the partner runtime. (ADR-002.)

## 4. Three-stage controlled workflow (separation of duties)

- **Stage 1 — Shop evidence capture** (MVGS Assessment Technician): receive, chain-of-custody,
  arrival photos, locked front/back scan, identify, MVGS defect marking, submit evidence,
  secure storage. **No final grade.**
- **Stage 2 — Central grading** (MintVault Supreme Grader): review full-res evidence, correct
  MVGS findings, confirm identity, set final grade, approve/reject/rescan. **Controls the grade.**
- **Stage 3 — Physical authentication + sealing** (MintVault Field Authentication Officer):
  on-site, MFA + registered device, scan QR, verify custody/tamper, compare physical card to
  scans, confirm authenticity + grade reasonableness + label + NFC, operate registered welder,
  seal, NFC read-back, final slab photos, second approval.
- Certificate publishes and credit consumes **only** after BOTH the Supreme Grader approval
  and the Field Authentication Officer approval, plus label/NFC/seal/photos complete.

Field officer outcomes: `APPROVE | HOLD_FOR_HQ_REVIEW | REJECT_AUTHENTICITY |
REJECT_IDENTITY_MISMATCH | REJECT_CHAIN_OF_CUSTODY | REJECT_LABEL_OR_NFC_MISMATCH`. A grading
disagreement returns to the Supreme Grader; any grade change creates a new version with
prev/new/reason/decision-maker and full audit history.

## 5. Locked commercial model (see ADR-010)

- Retail (shop→customer): **£20.00/card**. Wholesale credit (MintVault→shop): **£15.00/card**.
  Partner gross profit: **£5.00/card** (25% of retail). MintVault share: £15/completed card.
- Term: **MintVault Partner Grading Credit** (never called a cryptocurrency/token publicly).
- Pilot = prepaid wholesale credits only. Bundles: 10/25/50/100 (centrally priced).
- One paid credit = one standard partner card submission. Reserve at submission start, consume
  at controlled completion. Shop cannot create/edit/upload/duplicate/increase credits.
- Portal displays retail £20 / credit £15 / profit £5 — central, non-editable.
- **Not in pilot:** Stripe Connect, split settlements, partner payouts, auto commission, auto
  top-up, credit borrowing, negative balances, partner-created discounts/prices.
- **VAT treatment is configurable and flagged for formal accounting confirmation before
  production launch** (open item — legal/financial, see §12).

## 6. Programmes and phases

Phases are grouped into five programmes for bulk local delivery. Within a programme, agents may
complete all local development + independent verification without repeated permission, stopping
at any merge/infra/migration/deploy boundary (see §10).

| Programme | Phases | Theme |
|---|---|---|
| **A — Safe Foundation** | 0.5, 1, 2, 3, 4 | Migration safety ✓, isolated partner foundation, onboarding/compliance, training/accreditation, device security |
| **B — Money & Shop Intake** | 5, 6, 7 | Credit/Stripe ledger, customer drop-off/order intake, locked scanning + MVGS evidence |
| **C — Central Grading & Field Completion** | 8, 9, 10, 11 | Supreme Grader dashboard, QA/risk engine, Field Authentication Officer system, label/cert/NFC/sealing |
| **D — Operations & Control** | 12, 13, 14, 15, 16, 17, 18 | Stock/equipment, strikes/incidents, collection/public cert, super-admin control centre, field routes, reporting/reconciliation, support/diagnostics |
| **E — Security, Pilot & Rollout** | 19, 20, 21, 22 | Backup/disaster/security, full security validation, controlled pilot, pilot review/expansion |

Per-phase scope is the locked spec; acceptance criteria are in §8. Each phase = dedicated
branch, explicit base commit, exact scope, test plan, threat review, rollback plan, local
commit, independent verification, completion report.

## 7. Phase dependency map

```
0.5 (done) ──► 1 ──► 2 ──► 3 ──► 4 ─┐
                │                    │
                ├────────────────────┼──► 5 ──► 6 ──► 7 ─┐
                │(RLS+tenant ctx +    │(device binding    │
                │ partner auth are    │ gates capture)    │
                │ prerequisites for   │                   │
                │ everything below)   ▼                   ▼
                │                     8 ──► 9        (evidence feeds 8)
                │                     │
                │                     ├──► 10 ──► 11 (cert/NFC/seal completion gate)
                │                     │
                ▼                     ▼
        15 (super-admin control) ◄── 12,13,14,16,17,18 (operations; depend on 1,5,8,11)
                │
                ▼
        19 ──► 20 ──► 21 (pilot) ──► 22 (expansion)
```

Hard dependencies:
- **Everything depends on Phase 1** (partner tenant schema + RLS + restricted role + tenant
  middleware + partner auth). Nothing partner-facing ships before Phase 1 is verified.
- **Phase 5 (credits) depends on Phase 1** and the Phase 0.5 migration workflow (no `db:push`).
- **Phase 7 (capture) depends on Phase 4 (device binding)** — capture must require an approved
  device.
- **Phase 8 (Supreme Grader) depends on Phase 7 evidence** and reuses MVGS as a narrow service.
- **Phase 11 (completion gate) depends on 8 + 10** — cert publishes only after both approvals.
- **Phase 21 (pilot) depends on all of A–D verified** and Phase 19/20 security.

## 8. Phase acceptance criteria (condensed; each is a Definition-of-Proof gate)

- **P1:** two partners cannot see each other's rows (RLS proven at DB, not just app); missing
  tenant context fails closed; partner principal cannot reach any `requireAdmin`/numeric-ID
  admin route (proven by test); partner roles (owner/manager/technician/reception/finance/
  trainee) enforced server-side; audit framework records sensitive actions.
- **P2:** onboarding wizard blocks go-live until every mandatory doc is APPROVED and unexpired;
  expiry auto-suspends the correct capability; no self-approval.
- **P3:** technician cannot capture live evidence unless accreditation = APPROVED; training
  acknowledgements gate live work.
- **P4:** correct user on an unapproved Mac cannot capture; revoked device stops immediately;
  replayed signed request fails; unsupported app version blocked; two Macs cannot share one
  identity.
- **P5:** partner cannot create/edit credits; duplicate Stripe event does not double-issue;
  refund/chargeback freezes unused value; two concurrent reservations cannot consume one
  credit; wrong amount/currency/product rejected; ledger is append-only; balance derived.
- **P6:** order reserves a credit atomically; customer status page shows only that customer's
  order; arrival photos immutable after confirm; custody number linked.
- **P7:** capture requires approved device+scanner+calibration; evidence uploads to the partner
  bucket under tenant-scoped keys; local cache encrypted + auto-deleted; shop sees "awaiting
  MintVault review", never a final grade.
- **P8:** final grade set only by Supreme Grader; grade changes versioned; identity/defect
  corrections audited; rescan/hold paths work.
- **P9:** 100% pilot QA enforced; risk score computed; discrepancies logged; training-error vs
  manipulation distinguished.
- **P10/P11:** cert cannot publish and credit cannot consume until credit reserved + shop
  evidence complete + Supreme Grader approved + Field Officer approved + authenticated + label
  correct + NFC verified + sealed + final photos present; NFC uniqueness enforced; welder must
  be registered/approved/serviced; reprint controlled + audited.
- **P12–P18:** stock ledger reconciles cards vs credits/labels/NFC/slabs/seals; three-strike
  progression + critical immediate removal; collection PIN/signature; super-admin emergency
  controls enforced server-side; field-route batching; daily reconciliation alerts fire.
- **P19/P20:** restore test actually performed; full attack suite (tenant escape, IDOR, credit
  dup, Stripe replay, device clone, workflow skip, cert/NFC dup, privilege escalation, grade
  manipulation, card-switch evidence) passes.
- **P21:** pilot runs within limits with daily reconciliation + weekly quality/security review,
  zero tenant/credit/cert/NFC integrity failures.

## 9. Weighted completion (do not inflate for docs)

Weights: Phase 0 + 0.5 = 8% · Programme A remaining = 22% · B = 18% · C = 22% · D = 18% ·
E = 12%.

Current: Phase 0 audit complete; Phase 0.5 complete + verified (unmerged). Partner app
functionality not started. **Overall ≈ 12–15%.** Documentation alone does not raise this.

Report separately: Architecture (design) ~35% · Code ~4% (Phase 0.5 tooling only) · Tests ~4% ·
Infrastructure 0% · Pilot 0% · Production rollout 0%.

## 10. Automated execution rules (post-approval)

After master-plan approval, agents may run each phase's local lifecycle automatically:
inspect → design → implement on an isolated branch → local migrations against a **disposable**
DB → tests → docs → local commits → independent review → fix ordinary defects → update the
master ledger. **Stop before** any: merge to main, deploy, prod/staging data change, prod
migration, prod infrastructure creation, Stripe live product create/change, live secret change,
service purchase, enabling a live partner, external communication, change to existing protected
MintVault behaviour, or any destructive action. For ordinary implementation questions the locked
spec already answers, pick the safest repository-consistent option, record it in
`MASTER-ARCHITECTURE-DECISIONS.md`, and continue.

## 11. Branch & delivery strategy (see ADR-001)

- One branch per phase: `feat/partner-net/phase-NN-<slug>`, based on the prior verified phase
  branch (or main once phases merge). Explicit base commit recorded in the ledger.
- Phase 0.5 stays on `chore/partner-network-phase-0.5-db-migration-safety` (remote `3e2dda03`).
- No phase merges to main without owner approval. Programmes are delivered as a stack of
  verified phase branches; the owner decides merge order.

## 12. Genuine unresolved blockers (only real ones)

1. **VAT / accounting treatment** of the £20 retail vs £15 wholesale credit — legal/financial,
   must be confirmed by the owner's accountant before production launch (not before local build).
   Keep VAT configurable and flagged. **Blocks production launch, not local development.**
2. **Dedicated partner Fly app + hostname + dedicated R2 buckets + restricted DB role +
   partner secrets** — production infrastructure provisioning is owner-gated (protected action).
   Local development uses disposable DB + local/mock storage; real infra is a Programme-A→B
   boundary requiring owner action. **Blocks deploy, not local build.**
3. **Stripe live products** for credit bundles — live-mode change is owner-gated; local build
   uses Stripe test mode. **Blocks Phase 5 go-live, not local build.**
4. **Field Authentication Officer hardware** (approved phones/iPads) and **ultrasonic welder**
   registration are physical/operational provisioning — owner-supplied; software models them.
5. **Phase 0.5 final sign-off** — currently READY WITH CONDITIONS; Phase 1 stays blocked until
   the owner signs off Phase 0.5.

None of the above blocks producing this master plan or (post-approval) local Phase 1 development.

---

## 13. New subsystems (integrated across phases; ADR-015…019)
- **Digital Chain of Custody checkpoint system (ADR-015):** ordered, append-only, server-enforced
  checkpoints from RECEIVED → COLLECTED; the card state machine will not advance without the
  required checkpoint. Built in Phase 6/7 (capture/custody) and enforced at Phase 10/11 (field/seal).
- **MintVault Verified outcome (ADR-016):** the public dual-verified status; set only at the full
  completion gate; delivered in Phase 11/14 (completion + public cert).
- **Partner Accreditation Levels (ADR-017):** PROVISIONAL→APPROVED→SILVER→GOLD→PLATINUM; evidence-
  based; adjusts configurable limits only, never the critical gates; built in Phase 3, enforced
  wherever limits apply.
- **Anti-card-switch controls (ADR-014):** tamper-evident numbered packaging + image fingerprint +
  field physical-vs-scan comparison; spans Phase 7 (capture) and Phase 10 (field).
- **Ultrasonic welder governance (ADR-018):** registered welder assets gate sealing/completion;
  built in Phase 10/11.
- **Field Authentication Officer workflow (ADR-007/013):** Phase 10.
- **Batch field-visit operations:** Phase 16 (field routes) — visit queue, thresholds, regional
  route grouping across shops.

## 14. Phase 23 — Future Expansion (gated, NOT in this programme; ADR-019)
Recorded for continuity; each item is a separate future programme with its own owner approval,
threat model, and pilot: additional grading service tiers · higher-value card handling · automated
field-route planning · reduced-QA sampling for proven partners · larger/auto-top-up credit models ·
Stripe Connect / partner payouts / split settlements · multi-region operations · additional partner
marketing surfaces · fully separate Neon project + dedicated infra (ADR-002 revisit). None may
weaken tenant isolation, financial integrity, or grading integrity. Programme table adds Phase 23
under a new "F — Future" grouping (not started, 0%).
