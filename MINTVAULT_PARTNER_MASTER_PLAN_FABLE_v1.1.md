# MINTVAULT PARTNER SHOP GRADING — FABLE MASTER PLANNING PACKAGE FOR OPUS

Version 1.1 (final) — 2026-08-13 (both amendment lists applied; scope frozen per Amendment 15) — Author: Claude Fable 5 (planning architect) — Executor: Claude Opus (lead engineer)
Canonical worktree: /Users/cornelius/mintvault-partner-pilot-pass2
Release lineage: 6f0d59df (prod Partner Pilot) → 9a242c6b (auth/onboarding handoff) → cda06227+ (verification/fixes, expected at/near HEAD)

IMPORTANT SCOPE NOTE FOR OPUS: Fable planned from the brief plus MintVault's recorded architecture; Fable has no repo access. Every "existing implementation" claim below is a VERIFY-FIRST claim: Phase 0/1 confirms it against the actual worktree before it is relied on. Where the repo contradicts this plan, the repo wins for facts; this plan wins for business rules and invariants.

TERMINOLOGY (locked): the user-facing and documentation term is "Grading Credits" everywhere — Scanner, Partner Dashboard, Stripe product/receipt copy, ledger UI, Super Admin console, docs. Historical schema names (token/credit/hold) may be referenced internally when reading 0041–0043 code, never in new UI/copy.

---

## 1. EXECUTIVE READINESS SUMMARY

WHAT EXISTS (high confidence, verify in Phase 0/1):

- Live production platform (Node/Express, Drizzle, Neon Postgres, Cloudflare R2, Fly.io LHR ×2 machines, Stripe), HQ grading operational, Ashley grading real queue.
- Partner runtime repaired and deployed; PARTNER_DATABASE_URL uses restricted role `partner_runtime_app` (LOGIN, NOBYPASSRLS); partner portal/login flags on; unauthenticated GET /api/partner/me → 401.
- Applied Partner migrations: 0041 (submission credit lifecycle), 0042 (per-card credit settlement), 0043 (credit hold per card), 0074 (submission lifecycle + location snapshot), 0075 (station single active capture), 0076 (pilot certificate allocation).
- 0077 (credential lifecycle hardening) built locally, hostile-reviewed, repaired (FORCE RLS cleanup defect fixed; loud-fail auth projection; /api/partner/me cache-control hardened; onboarding badge null-safety; migration inventory guard fixed; local Postgres + HTTP onboarding tests green; zero new regressions vs baseline). APPLICATION/DEPLOY STATUS UNVERIFIED — Phase 0 must determine.
- Server-authoritative MVGS v2 (protected maths — DO NOT TOUCH), one canonical grading workstation direction (Admin/Staff/Partner shared), global gapless MV allocator, server-gated print pipeline (layout v31, 8 labels/A4, 720 DPI), certificate + NFC subsystems, soft-delete image pipeline with 90-day quarantine, audit_log discipline, Stripe webhook dedup table (`stripe_webhook_events`), payment idempotency (`markSubmissionAsPaid`).
- Scanner lineage: (a) legacy SilverFast/watcher inbox flow (proven UX: file appears → auto-upload → MV popup → NEXT CARD); (b) current Partner Scanner spec: single signed Mac app for HQ/Staff/Partner, Canon LiDE 400 + ImageCaptureCore, 1200 DPI lossless TIFF, account login + MFA, station enrolment with Keychain secret.

WHAT IS MISSING / INCOMPLETE (to be confirmed and closed in this pass):

- Buy More Credits (Stripe credit packs, webhook-authoritative grant, dashboard + Scanner zero-credit UX).
- FIX queue as a productised, server-authorised, side-scoped, zero-credit flow wired to dashboard "Delete Front/Back Image".
- Partner dashboard operational shape (credits summary, queues, Ready to Grade → workstation).
- Grading edit lease / concurrent-overwrite protection.
- Station fleet lifecycle beyond enrolment (approve/suspend/revoke, readiness/health, UPDATE_REQUIRED, staged rollout, diagnostics).
- Auth follow-ups from last hostile review: legacy MFA reset route permission alignment; unauthenticated denial-of-recovery (repeat invalidation of another user's setup/reset link); session invalidation after password reset; pending-organisation onboarding-state accuracy; known Partner UI baseline crash.
- Observability/fleet metrics, load proof, DR documentation, runbooks, pilot certification evidence.

MAJOR RISKS:

1. Two scanner lineages. Brief §13 says reuse the old watcher; recorded architecture marks SilverFast/watcher as legacy for removal and locks Canon LiDE 400 + ImageCaptureCore + TIFF. RESOLUTION (planned, not silent): reuse the watcher's ORCHESTRATION AND UX PATTERN (auto-detect capture → auto-upload → server binding → big MV confirmation → NEXT) on top of the current canonical capture engine found in the repo. Do not resurrect SilverFast unless the repo shows ImageCaptureCore capture absent/broken. If Opus finds the watcher pipeline is still the only working capture path, run the pilot on it and schedule engine swap post-pilot. Flagged in Owner Decision Register (OD-1) only if the repo shows BOTH working — then pick per evidence, default: current canonical engine + watcher UX.
2. Gapless global MV allocator is a serialization point. At 1,000 concurrent finalise ops a single-row FOR UPDATE allocator caps throughput. Mitigation in §9/§19: keep gapless (locked), allocate at Card Job creation inside the credit-reservation tx (short tx), advisory-lock allocator, measure in load phase; if p99 blocks >250ms at target load, escalate OD-2 (per-day gapless segments) — do not change silently.
3. RLS + connection pooling. `partner_runtime_app` NOBYPASSRLS is correct, but pooled connections must set tenant context per-transaction (`set_config(key, val, true)` local GUC), never per-session, or tenant bleed occurs on connection reuse. Mandatory hostile test.
4. Webhook→credit grant is the money path. Must be outbox/idempotent end-to-end (Stripe event id dedup already exists for submissions — extend pattern, do not fork it).
5. Denial-of-recovery auth hole (unauthenticated repeated invalidation of another user's reset link) is a live security defect — Phase 2 blocker.
6. Execution-lead note: previous session recorded Terra/Codex as lead. This brief LOCKS Opus as lead; that supersedes. Opus should ignore any Codex-oriented scaffolding docs except as content (e.g. MINTVAULT_PARTNER_PILOT_MASTER_EXECUTION.md is valid input material).

---

## 2. CURRENT ARCHITECTURE MAP (verify-first)

Server: Node/Express monolith (routes.ts noted as large; refactor deferred — do not refactor in this pass beyond what tasks require). Drizzle ORM. Neon Postgres prod branch ep-wispy-morning; staging ep-purple-voice; Fly prod app `mintvault` (2 machines, LHR), staging `mintvault-v2`. R2 for images. Stripe for payments (webhook dedup table exists). Resend for email. pg-boss available for background jobs.

Data-plane roles: main app role (full) + `partner_runtime_app` (LOGIN, NOBYPASSRLS) used by PARTNER_DATABASE_URL. RLS policies on partner tables (0074–0077 lineage).

Domain areas and where Opus should look first (names indicative — confirm exact):

- Partner credit lifecycle: migrations 0041/0042/0043 + server modules referencing "credit", "hold", "settlement", "reservation".
- Partner submission/Card Job: 0074 "partner_submission_lifecycle_and_location_snapshot" — the partner submission table with lifecycle + location snapshot is the presumptive canonical Card Job record.
- Capture/station: 0075 "partner_station_single_active_capture" — station registry + single-active-capture constraint exist.
- Certificates: 0076 "partner_pilot_certificate_allocation".
- Auth/onboarding: 0077 + auth routes, MFA, invitation/password setup, session store.
- MV allocator: global gapless allocator module (search "allocator", "mv_number", sequence/table with FOR UPDATE).
- Grading: canonical workstation UI + server MVGS authority endpoints (MVGS maths PROTECTED).
- Images: R2 client, TIFF master handling, derivative/crop pipeline, soft-delete/90-day quarantine subsystem, audit_log.
- Print/NFC: label layout v31 print console, NFC write/verify endpoints (note NFC hardening backlog: content-bound HMAC signing, misleading admin/nfc/verify endpoint rename, URL format validation — fold what's in-scope into Phase 11).
- Scanner app: Mac app (ImageCaptureCore) + legacy watcher (`com.mintvault.scanner` launchd, `~/.mintvault-scanner.env` SCANNER_API_TOKEN) — token-env pattern is legacy; Partner stations use enrolment + Keychain.

Phase 0 produces the authoritative version of this map (schema dump, route inventory, module ownership) and diffs it against this section.

---

## 3. REUSE / MODIFY / REMOVE / NEW MATRIX

Legend: R=reuse as-is, M=modify, N=new, X=remove/retire (post-pilot unless stated). Opus confirms each in Phase 1 and records evidence (file paths) in the Reuse Map.

| Capability                                                  | Verdict     | Notes                                                                         |
| ----------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Global gapless MV allocator                                 | R           | Wrap allocation into NEW-card tx; never client last+1                         |
| Partner wallet/credit tables (0041–0043)                    | M           | Converge naming/semantics to §9 model; no schema fork                         |
| Partner submission lifecycle (0074)                         | M           | Elevate to canonical CARD JOB; add missing states/columns only as needed      |
| Station registry + single-active-capture (0075)             | M           | Add lifecycle states, health, version fields per §13-plan                     |
| Certificate allocation (0076)                               | R/M         | Bind origin snapshot immutably                                                |
| 0077 credential lifecycle                                   | R           | Verify applied; close listed follow-ups (Phase 2)                             |
| RLS policies + partner_runtime_app                          | M           | Extend to every new table; per-tx GUC tenant context                          |
| MVGS server authority                                       | R           | PROTECTED — no changes                                                        |
| Canonical grading workstation                               | M           | Add role gates + edit lease; do NOT build a Partner-specific grader           |
| Soft-delete image pipeline (90-day quarantine)              | R           | FIX invalidation rides on it — do not fork                                    |
| audit_log (entity_type/entity_id/action/admin_user/details) | R           | Use `admin_user`; reason/before/after in `details` jsonb                      |
| Stripe webhook dedup (`stripe_webhook_events`)              | M           | Extend for credit-pack events; same table, new event handlers                 |
| R2 client / TIFF master path                                | R           | Add server-side finalise verification (HEAD + size/checksum) if absent        |
| Legacy watcher UX pattern                                   | R (pattern) | Port orchestration/UX into Scanner app NEW/FIX flows                          |
| SilverFast / inbox watch folders / SCANNER_API_TOKEN env    | X           | Post-pilot removal unless Phase 0 shows they're the only working capture path |
| Client last+1 MV assignment                                 | X           | Remove immediately wherever found                                             |
| Buy More Credits (packs, checkout, grant)                   | N           | §11                                                                           |
| Scanner FIX queue endpoints + UI                            | N/M         | Reuse invalidation subsystem; new authority endpoint + queue UI               |
| Grading edit lease                                          | N           | §15                                                                           |
| Fleet observability/metrics                                 | N           | §18                                                                           |
| Signed app distribution / update channel                    | N           | Pilot-minimal now; staged rollout infra can be 5,000-ready criteria           |
| Support diagnostics/support code                            | N           | §18                                                                           |

Rule restated: no new subsystem until Opus proves existing code cannot satisfy the requirement safely, with the file-level evidence recorded.

---

## 4. LOCKED BUSINESS RULES (verbatim authority — no silent change)

1. 1 usable grading credit = authority for exactly 1 NEW Card Job. 1 Card Job = one permanent MV number = one paid grading job.
2. FIX/rescan on the SAME Card Job costs zero credits, cannot mint MV numbers or reservations, and only targets invalidated/missing sides of an existing paid Partner-owned Card Job.
3. Shops never input credits manually; wallet reconciles from append-only ledger + reservations; no editable balance column as source of truth.
4. Zero credits blocks NEW only — never grading of already-authorised cards, never FIX.
5. Cancellation pre-finalisation may release a reserved credit exactly once; consumed credit is never auto-released; post-consumption refunds are audited Super Admin/business workflow.
6. Tenant isolation is server/DB enforced (RLS), never UI filtering; knowing another tenant's MV number grants nothing; Super Admin is the only cross-tenant authority.
7. MVGS is server-authoritative; browser submits evidence/observations only; protected scoring maths untouched.
8. Certificate origin is immutable: "Graded by MintVault Headquarters" vs "Graded by [Shop Name]" + location snapshot; later rename/move never rewrites history.
9. Public surfaces (lookup, population, logbook, claim, label, NFC) derive only from valid final lifecycle states; cancelled/provisional/superseded work never inflates population; corrections never double-count.
10. MV numbers are globally gapless, permanent, never reused.
11. Suspension (shop/user/station) or emergency stop overrides remaining balance for NEW.
12. No offline creation of NEW paid Card Jobs; no offline credits/MV/reservations.
13. Reprint/NFC-retry reuse the same certificate; never new credit, never new MV; one NFC tag binds to at most one certificate.
14. Data discipline: no hard deletes on business tables (soft-delete via deleted_at); every delete audited; migrations idempotent, additive-then-cutover; never edit an applied migration.
15. Customer PII is NOT reintroduced into Partner intake; ownership claim/logbook remains the downstream ownership path.

---

## 5. STATE MACHINES

Naming: adopt existing enum names from 0074/0041–0043 where they match semantics; where existing names contradict semantics, add new states additively and migrate meanings — record the mapping in the Reuse Map. States below are the semantic contract.

### A. CARD JOB

```
CREATED ─┐ (tx-internal only; a Card Job row is never visible without a reservation)
         └→ CREDIT_RESERVED → NEEDS_SCAN → CAPTURING → READY_TO_GRADE → GRADING
              → SUBMITTED → QA_REVIEW → APPROVED → PRINTABLE → COMPLETED
Branches:
- NEEDS_SCAN/CAPTURING ←→ (side invalidated) FIX_REQUIRED → CAPTURING (fix) → READY_TO_GRADE
- READY_TO_GRADE → FIX_REQUIRED when an accepted side is invalidated (leaves Ready immediately)
- QA_REVIEW → REJECTED_TO_GRADING (returned) → GRADING
- Any pre-SUBMITTED state → CANCELLED (policy-gated; releases reservation exactly once)
- APPROVED/PRINTABLE/COMPLETED → CORRECTION_OPEN → (regrade lifecycle, version-aware) → APPROVED'
- Any state → HELD (Super Admin/risk hold) → previous state on release
- ABANDONED (flag, not a terminal state): stale CAPTURING/NEEDS_SCAN past threshold → surfaced for resume/manual cancel/SA recovery; never auto-released
Terminal: COMPLETED, CANCELLED. CORRECTION never rewrites approved history in place (new version rows).
```

Transition rules table (enforce in one server-side transition function, not scattered updates):

- CREDIT_RESERVED requires: active tenant+user+station, wallet reservation row created same tx, MV allocated same tx.
- READY_TO_GRADE requires: FRONT.ACCEPTED ∧ BACK.ACCEPTED (DB CHECK/trigger or guarded transition).
- SUBMITTED consumes credit (reservation → CONSUMED) exactly once, same tx as submission insert.
- APPROVED requires QA per tenant policy; PRINTABLE requires APPROVED + certificate issued.
- CANCELLED from CREDIT_RESERVED/NEEDS_SCAN/CAPTURING only (pilot policy); reservation → RELEASED same tx.

### B. CREDIT (reservation-centric; wallet balance is derived)

```
Semantic contract only — the CONCRETE accounting model is the canonical 0041–0043 ledger/reservation model, which Opus traces in Phase 1 and REUSES. No second wallet/balance model is built; no new available-credit formula is hard-coded. Locked outcomes the existing model must be shown (or minimally extended) to satisfy:
- one NEW Card Job removes exactly one unit of available capacity;
- exactly-once reservation / consume / release (illegal: CONSUMED→RELEASED; a Card Job never holds two active reservations);
- FIX never changes wallet capacity;
- reconciliation mathematically proves the ledger/reservation result (drift ⇒ alert, never silent fix).
Ledger entry classes (map to existing names): PURCHASE, GRANT(admin, audited), ADJUSTMENT(admin, audited), REFUND_EXCEPTION(audited). Reservation lifecycle: RESERVED → CONSUMED | RESERVED → RELEASED.
```

### C. CAPTURE SIDE (per side FRONT/BACK)

```
MISSING → CAPTURE_AUTHORISED → UPLOADED → ACCEPTED
ACCEPTED → INVALIDATED (soft-delete/supersede; immutable master preserved) → FIX_REQUIRED → CAPTURE_AUTHORISED(fix, side-scoped) → UPLOADED → ACCEPTED(replacement)
Rules: ACCEPTED requires R2 persistence verified (HEAD/size/checksum) + binding checks (§ Tenant/binding). Only the authorised side(s) of an authorised session can transition. Replacement supersedes; history immutable.
```

### D. PARTNER ONBOARDING (per user; org readiness is the conjunction)

```
INVITED → AWAITING_PASSWORD_SETUP → AWAITING_MFA_SETUP → ACTIVE
ACTIVE → LOGIN_BLOCKED (policy/security) → ACTIVE
ACTIVE → RESET_REQUIRED (password reset issued; all sessions revoked) → AWAITING_PASSWORD_SETUP' → ACTIVE
Org readiness: ORG_ACTIVE ∧ ≥1 ACTIVE owner ∧ portal flags ∧ location membership ∧ (station required? STATION_SETUP_REQUIRED → READY : READY)
SUSPENDED (org/user) overrides everything. Onboarding badge must compute from these facts, not row existence (0077 direction).
```

### E. STATION

```
PENDING_ENROLMENT → APPROVED → ACTIVE ←→ OFFLINE(derived from last_seen)
ACTIVE → UPDATE_REQUIRED (version < minimum) → ACTIVE (after update)
Any → SUSPENDED → ACTIVE (SA)  |  Any → REVOKED (terminal; secret invalidated)
Copied app install ⇒ no station identity ⇒ PENDING_ENROLMENT at best; never auto-ACTIVE.
```

---

## 6. INVARIANT REGISTER

Format: Invariant → DB enforcement → server enforcement → automated test → hostile test → operational proof. "AT-n" = acceptance test §21/§48-matrix; "HT" = hostile.

| #   | Invariant                                                                                                                                                                                                                                                                                                                                                                                      | DB                                                                                                       | Server                                                                               | Auto test                                         | Hostile test                                                                  | Ops proof                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| I1  | One Card Job ↔ one MV forever; MV never reused                                                                                                                                                                                                                                                                                                                                                 | mv_number UNIQUE NOT NULL on card job; allocator monotonic; no UPDATE path on mv_number (trigger blocks) | transition fn never touches mv                                                       | AT-8                                              | attempt mv update via any API                                                 | pilot reconcile                              |
| I2  | One NEW Card Job ⇔ exactly one credit reservation                                                                                                                                                                                                                                                                                                                                              | partial UNIQUE (card_job_id) WHERE status IN (RESERVED,CONSUMED); reservation.card_job_id NOT NULL FK    | reservation+job created in one tx                                                    | AT-2                                              | create job via every route w/o reservation                                    | ledger reconcile                             |
| I3  | One credit cannot fund two jobs / race safety                                                                                                                                                                                                                                                                                                                                                  | wallet row FOR UPDATE (or atomic UPDATE ... WHERE available>=1) + I2 unique                              | idempotency key (station_id, client_op_id) UNIQUE                                    | AT-1, AT-4, AT-9                                  | 2 tabs/2 stations/direct API/double-click/retry                               | AT-9 ledger exact                            |
| I4  | FIX never creates reservation or MV                                                                                                                                                                                                                                                                                                                                                            | fix-authorisation table has no wallet/allocator FK; no code path                                         | fix endpoint asserts existing job + invalidated side only                            | AT-12, AT-15                                      | FIX as free-new-card loophole attempts                                        | wallet before==after                         |
| I5  | Consumed credit never released                                                                                                                                                                                                                                                                                                                                                                 | no RELEASED transition from CONSUMED (CHECK on status transitions via trigger)                           | transition fn                                                                        | AT-7                                              | forced release API attempt                                                    | audit                                        |
| I6  | Tenant A cannot read/use tenant B anything                                                                                                                                                                                                                                                                                                                                                     | RLS on every partner table keyed by tenant GUC; partner_runtime_app NOBYPASSRLS                          | route-level tenant assertion (belt+braces)                                           | AT-10                                             | full cross-tenant matrix §8 incl. known-MV probes                             | pilot Partner B check                        |
| I7  | Capture tenant/location/station immutable post-create                                                                                                                                                                                                                                                                                                                                          | columns non-updatable via trigger                                                                        | —                                                                                    | unit                                              | update attempts                                                               | audit                                        |
| I8  | FRONT+BACK belong to same Card Job/session/side                                                                                                                                                                                                                                                                                                                                                | evidence row FK (card_job_id, session_id, side) + UNIQUE active per (job, side)                          | binding check at accept                                                              | AT-6                                              | MV421-FRONT+MV422-BACK, swap, replay, forged R2 key                           | pilot                                        |
| I9  | Invalidated side unusable for grading; Ready requires both accepted                                                                                                                                                                                                                                                                                                                            | Ready transition guard reads active sides                                                                | grading loads only active evidence                                                   | AT-13                                             | grade with invalidated side via API                                           | pilot bad-front test                         |
| I10 | Printed grade == authoritative approved grade; browser never authoritative                                                                                                                                                                                                                                                                                                                     | print payload generated server-side from approved record                                                 | no client grade persistence route                                                    | AT-19                                             | tampered submit payload                                                       | physical label check                         |
| I11 | Origin/provenance immutable post-approval                                                                                                                                                                                                                                                                                                                                                      | snapshot columns frozen by trigger; new versions for corrections                                         | —                                                                                    | unit                                              | rename shop then reprint                                                      | cert wording check                           |
| I12 | Webhook cannot double-credit; retry cannot double-charge                                                                                                                                                                                                                                                                                                                                       | stripe_webhook_events UNIQUE(event_id); ledger UNIQUE(source_event_id)                                   | handler idempotent, grant in tx with dedup insert                                    | AT-16                                             | replay event 5×; concurrent replays                                           | Stripe dashboard vs ledger                   |
| I13 | Reprint/NFC retry same certificate; tag↔cert 1:1                                                                                                                                                                                                                                                                                                                                               | nfc_tag UNIQUE(tag_uid); cert reprint increments print history only                                      | reprint route reuses cert id                                                         | AT-19, AT-20                                      | bind tag to 2nd cert                                                          | physical print/NFC                           |
| I14 | Suspension overrides balance                                                                                                                                                                                                                                                                                                                                                                   | status checked in NEW tx before reservation                                                              | middleware + tx guard                                                                | AT-11                                             | suspended org direct API NEW                                                  | SA console                                   |
| I15 | No orphan: accepted image ⇔ verified R2 object; no orphan job from stray upload                                                                                                                                                                                                                                                                                                                | accept only after R2 HEAD verify; upload cannot create jobs                                              | reconciliation worker flags divergence                                               | AT-5, AT-6                                        | kill worker mid-accept; stray R2 object                                       | reconcile report                             |
| I16 | Public surfaces derive only from final states                                                                                                                                                                                                                                                                                                                                                  | views/queries filter lifecycle states                                                                    | —                                                                                    | integration                                       | provisional cert lookup                                                       | population audit                             |
| I17 | Rolling-deploy compatibility on the LOCKED minimum two-Machine Fly topology: every schema/API change works with old+new app versions during the mixed-version window, OR follows deliberate expand → migrate → deploy → contract; no release makes the old Machine fail while the new starts; scaling to one Machine is NEVER a rollout/schema fix (emergency troubleshooting only, temporary) | additive-first migrations; contract steps separated                                                      | version-tolerant handlers; no Machine-affinity assumptions                           | mixed-version compat checklist per release; AT-23 | run old app code against new schema in staging; cross-Machine request routing | both Machines verified serving new SHA (P16) |
| I19 | No process-local authoritative state: sessions, wallet/capacity, Card Job/Scanner/FIX/grading state, idempotency keys, and edit leases live in shared services (PostgreSQL/R2), never in per-Machine memory; any in-process cache is advisory-only and correctness-safe if cold or stale                                                                                                       | shared-store schemas for all of the above                                                                | code review rule: no module-level mutable authoritative maps/caches on these domains | AT-23 subset                                      | kill one Machine mid-flow; flow completes via the other                       | fleet ops                                    |
| I18 | Schema contract readiness: each app version proves at startup it has its required migrations/columns/functions; a missing requirement produces a visible fail-closed readiness/configuration error — never a misleading 401, 500, empty dashboard, or partially-working Partner UI                                                                                                             | migration journal check + capability probes at boot                                                      | /readiness endpoint reports schema-contract status                                   | boot-with-missing-migration test                  | drop a required column in a scratch DB and boot                               | deploy verification step                     |

Opus maintains this register as a living file (`docs/partner/INVARIANTS.md`), adding rows for anything discovered, and every phase's proof gate cites which invariants it proved.

MANDATORY AUDIT COVERAGE (each writes audit_log with actor (admin_user), tenant, location/station where applicable, timestamp, reason and before/after context in details jsonb): FRONT invalidation; BACK invalidation; FIX authorisation; replacement capture; cancellation; reservation release; manual Grading Credit grant/adjustment; grading edit takeover; reprint; NFC retry/replacement; password reset; MFA reset; session revocation; station approval; station suspension; station revocation; Partner suspension; emergency takeover. A9 verifies every event in this list is actually emitted (integration test greps audit_log after exercising each path).

---

## 7. REQUIREMENTS TRACEABILITY MATRIX (RTM)

Opus generates the full RTM in Phase 1 as `docs/partner/RTM.md` with one row per requirement in this plan, columns exactly: Requirement → existing code/file/schema (paths) → R/M/X/N → DB → API → UI → automated test → hostile test → browser/manual test → physical test → release gate (phase). Seed rows (Opus completes paths):

| Req                               | Verdict                         | DB                     | API                                           | UI                          | Auto            | Hostile                      | Physical            | Gate   |
| --------------------------------- | ------------------------------- | ---------------------- | --------------------------------------------- | --------------------------- | --------------- | ---------------------------- | ------------------- | ------ |
| NEW reserves 1 credit atomically  | M (0041-43)                     | wallet+reservation tx  | POST /api/partner/card-jobs                   | Scanner NEW                 | AT-1/2/9        | race matrix                  | pilot 10-card       | P4     |
| FIX FRONT free                    | M (soft-delete) + N (authority) | side invalidation rows | POST /api/partner/card-jobs/:id/fix-authorise | Scanner FIX queue           | AT-12/13/15     | cross-tenant FIX             | invalidate+rescan   | P7     |
| Buy credits webhook-authoritative | N + M (webhook dedup)           | ledger + packs         | /api/partner/credits/checkout + webhook       | dashboard+Scanner CTA       | AT-16           | replay                       | live £ test-mode    | P5     |
| Delete Front Image → FIX queue    | M                               | supersede active side  | DELETE-image route (invalidate semantics)     | dashboard card view         | AT-13           | delete other tenant's image  | pilot               | P7/P8  |
| Ready→workstation, edit lease     | M/N                             | lease table            | lease acquire/heartbeat/release               | workstation banner          | lease unit+race | takeover abuse               | two-grader test     | P9     |
| Certificate origin snapshot       | R/M (0076)                      | frozen snapshot        | cert issue                                    | cert render                 | unit            | rename attack                | printed label       | P11    |
| Station enrolment/approval        | M (0075)                        | station lifecycle cols | enrol/approve/suspend/revoke                  | SA console + Scanner status | unit            | cloned install               | pilot Mac           | P6/P12 |
| Onboarding truthful states        | R (0077)+M                      | derived readiness      | /api/partner/me                               | badge/gates                 | AT-17/18        | denial-of-recovery fix proof | fresh partner login | P2     |

The RTM is mandatory and is a release-gate artifact: no phase closes with an RTM row in its scope left blank.

---

## 8. TENANT-ISOLATION MATRIX

Enforcement standard for EVERY partner-scoped table: (1) RLS policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)` (or existing equivalent GUC key — reuse the 0074+ convention, do not invent a second), (2) tenant GUC set per-transaction with `set_config(..., true)` immediately after checkout from pool, (3) route-level assertion of session tenant == resource tenant (defence in depth), (4) `partner_runtime_app` NOBYPASSRLS confirmed, (5) Super Admin path uses the privileged role/connection, never a GUC bypass.

Resources requiring RLS + negative tests (each gets: read-by-id, list, mutate, and known-identifier probe from tenant B): card jobs, MV lookups (partner-scope route), wallet, ledger, reservations, submissions, scanner job targets, stations, capture sessions, side evidence (FRONT/BACK), immutable TIFF master references, active images/derivatives, FIX queue + fix authorisations, grading evidence/drafts, grades, edit leases, certificates + history, corrections, print jobs + previews, NFC bindings, staff/users, locations, credit activity/purchases, diagnostics/support bundles.

Additional hostile isolation tests (Phase 14): forged R2 object key targeting tenant B's prefix; presigned-URL reuse across sessions; capture session replay from a revoked station; tenant GUC unset (must fail closed — RLS default-deny, verify no PERMISSIVE fallback policy); pooled-connection reuse without re-setting GUC (simulate; must return zero rows, not previous tenant's rows); Super Admin route reachable with partner session (403).

Deliverable: `docs/partner/TENANT_MATRIX.md` — every route in the partner API inventory × enforcement point × test file path. A route missing from the matrix fails the Phase 14 gate.

---

## 9. CREDIT / WALLET MODEL (concurrency + idempotency)

Source of truth: the EXISTING 0041–0043 canonical ledger/reservation accounting — Opus traces it first and reuses it; the steps below express required semantics against that model, not a replacement. Any cached wallet summary must be the existing one (if present), updated strictly in the same transaction as ledger/reservation writes and reconciled by a nightly job (drift ⇒ alert, never silent fix). Do not introduce a parallel wallet/balance representation.

NEW-card transaction (single DB tx, target <50ms):

1. `SELECT ... FROM partner_wallet WHERE tenant_id=$1 FOR UPDATE` (or the existing 0041-43 equivalent lock point).
2. Assert org/user/station ACTIVE, not suspended, no emergency stop (I14).
3. Assert available ≥ 1 (computed or cached-in-row).
4. Idempotency: `INSERT INTO partner_op_keys(station_id, client_op_id) ...` UNIQUE — conflict ⇒ return the previously created Card Job (same MV), not an error, not a second charge (AT-5 restart/retry semantics).
5. Allocate MV via existing gapless allocator (advisory lock or allocator-row FOR UPDATE — reuse existing mechanism; keep it inside this tx so a failed tx never burns an MV… VERIFY: if the existing allocator burns numbers on rollback, that violates gapless — Opus must confirm allocator is tx-atomic; if it is a Postgres SEQUENCE it is NOT gapless on rollback ⇒ replace with allocator table pattern, additive migration).
6. Insert Card Job (state CREDIT_RESERVED→NEEDS_SCAN), insert reservation (RESERVED, card_job_id), decrement cached available.
7. Commit; respond with {card_job_id, mv_number, sides authorised}.

Consumption: in the grading-submission tx, `UPDATE reservation SET status='CONSUMED' WHERE card_job_id=$1 AND status='RESERVED'` — rowcount must be 1; rowcount 0 with existing CONSUMED row ⇒ idempotent success; 0 with no row ⇒ hard error + alert (I2 breach).

Release (cancel): same pattern RESERVED→RELEASED, exactly-once by rowcount; only from permitted job states; audited.

Concurrency proof obligations: AT-1 (1 credit, 2 simultaneous), AT-4 (2 tabs/stations), AT-9 (100-credit stress, 101st rejected, ledger exact), plus pgTAP/integration test running 50 parallel NEW against 10 credits ⇒ exactly 10 jobs.

Admin adjustments: SA-only, ledger GRANT/ADJUSTMENT rows with audit_log (admin_user, reason in details); no UPDATE on balance ever exposed.

---

## 10. NEW / FIX SCANNER MODEL

Two authoritative server queues per tenant (station pulls, server owns truth):

- NEW: creation path above; Scanner never invents jobs; it calls start-new, receives {job, mv, sides:[FRONT,BACK]}.
- FIX: server-computed list = card jobs of THIS tenant with ≥1 side in FIX_REQUIRED; each entry lists exactly the missing side(s). Selecting an entry calls fix-authorise which returns a capture session scoped to (job, side(s)) — the only sides the upload endpoint will accept (I4, I8, AT-13).

FIX constraints enforced server-side: existing paid job of this tenant only; no wallet touch (AT-15); no MV mint; cannot target an ACCEPTED side unless it was invalidated; authorisation expires (e.g. 30 min) and is single-active per station (reuse 0075 single-active-capture constraint).

Capture orchestration (watcher pattern reused): Scanner watches the capture output (ImageCaptureCore callback or watch-folder, per repo reality) → detects FRONT file → uploads with (session, side=FRONT) → server verifies+accepts → UI ticks FRONT → BACK likewise → server confirms pair → big confirmation `MV421 COMPLETE / MARK CARD MV421 / [NEXT CARD]` → next NEW reuses flow. Out-of-order BACK-first: allowed within the same authorised session (side is explicit, not inferred from order). Duplicate file events, stale files predating the session, restarts: upload carries session id + side + content checksum; server rejects stale/duplicate by (session, side, checksum) semantics (AT-6, HT §18-brief list).

LOCKED: normal FIX flow NEVER requires manual MV entry — the FIX queue is server-derived from the authenticated Partner's own data. Manual MV search/entry exists only as a controlled Recovery affordance, is tenant-isolated at the DB/RLS level, and can never expose or act on another Partner's cards (negative test in §8 matrix).

---

## 11. PAYMENT / BUY MORE CREDITS PLAN

Packs: 5, 10, 25, 50, 100 — KEEP as specified, implemented as Stripe Products/Prices (one per pack) so accounting, receipts and price changes are Stripe-native. Recommended pricing shape (owner sets numbers): flat per-credit price at 5/10, ~5% break at 25, ~10% at 50, ~15% at 100 — mirrors the existing bulk-discount ladder (5/7.5/10%) so Partner economics rhyme with retail; add a 250 pack later only if pilot shops ask (architecture: packs are DB rows `credit_packs(id, credits, stripe_price_id, active)` — adding packs is data, not code). Why fixed packs: no arbitrary-amount VAT/rounding edge cases, simple webhook mapping price→credits, clean refund units.

Flow: dashboard/Scanner CTA → POST /api/partner/credits/checkout {pack_id} (permission: OWNER always; MANAGER iff billing permission; GRADER never — 403) → Stripe Checkout session (metadata: tenant_id, pack_id, initiating user) → redirect. Success page shows "Processing…" and polls wallet; IT NEVER GRANTS. Webhook `checkout.session.completed` (+ `payment_intent.succeeded` guard): insert into `stripe_webhook_events` (existing dedup, UNIQUE event_id) and ledger PURCHASE row with UNIQUE(source_event_id) in one tx (I12, AT-16). Failed/expired session ⇒ nothing. Refund/chargeback events ⇒ create a flagged accounting-exception record for SA workflow (never auto-negative the wallet below committed reservations; SA resolves with audited ADJUSTMENT). Receipts: Stripe receipt email + in-dashboard Credit Activity (ledger view: purchases, grants, reservations, consumption, releases). Auto top-up: not built; ledger/pack model doesn't block it (future: saved payment method + threshold trigger job).

UX states: available>0 ⇒ [SCAN NEW CARD] primary + [BUY MORE CREDITS] secondary; available=0 ⇒ BUY primary, SCAN disabled with reason; low-credit banner at configurable threshold (tenant setting, default 5) in both dashboard and Scanner.

PRODUCTION STRIPE POLICY (locked): staging uses Stripe test mode. The production physical pilot does NOT assume test mode: the first live physical workflow runs on audited Super Admin-granted Grading Credits unless the owner explicitly authorises a real live purchase. Commercial production proof (later, explicitly owner-authorised) = one real purchase → live webhook → ledger → wallet → NEW capacity. In no environment does a browser success page grant credits.

VAT/accounting note (flag, not code): single-purpose voucher treatment likely applies to credit packs under UK VAT — confirm with accountant before public pricing; does not block build (Stripe Tax config is data).

---

## 12. PARTNER DASHBOARD UX PLAN

Single operational page, no dev controls. Top: `27 Grading Credits Available · 2 Reserved/In Progress · 8 Ready to Grade` + [SCAN NEW CARD] (deep-links/instructs station) + [BUY MORE CREDITS]. Queues as tabs/sections: Needs Scan/FIX (with per-card "FRONT missing" etc.), Ready to Grade (click → canonical workstation with Partner role), In Review (QA), Completed. Secondary: Credit Activity (ledger), Recent Cards, Station status chips (name, online/offline, version, readiness), Warnings (low credits, station update required, FIX backlog). Card detail view: images (active), MV, state, history timeline (from audit), Delete Front/Back Image actions (= invalidate per §Locked rule 2 semantics; confirmation dialog states "image will be removed from grading and this card will move to FIX — MV and credit unchanged"). All data via tenant-scoped API; poll or SSE for queue updates (reuse whatever the HQ dashboard uses; do not introduce a new realtime stack for pilot).

---

## 13. STATION / DEVICE / FLEET PLAN

Enrolment: signed Scanner app → user signs in (account + MFA) → app generates device identity, requests enrolment {tenant, location, device fingerprint, hostname, app version} → station PENDING_ENROLMENT → SA (pilot) or Owner (later, flag) approves → server issues station secret → stored in macOS Keychain (never env files — SCANNER_API_TOKEN pattern is legacy). All station API calls: user session + station credential; both checked. Cloned app/disk image ⇒ no Keychain secret ⇒ re-enrolment required (I station rule).

Registry fields (extend 0075): tenant, location, station_id, name, device fingerprint, status (SM-E), approved_by/at, last_seen, app_version, os_version, capabilities/health json (scanner detected, printer, NFC), audit events. Heartbeat every 60s carries version + health. min_supported_version setting ⇒ stations below it get UPDATE_REQUIRED (blocks NEW/FIX capture, shows instruction). SA actions: approve/suspend/revoke/inspect health/set min version; "force update where architecture supports" = for pilot, UPDATE_REQUIRED gating + Sparkle-style feed is the 5,000-ready criterion, not a pilot blocker.

Readiness display (Scanner main view): Shop · Location · Operator · Station · Connection ✓ · Scanner ✓ · Printer ✓ · Upload/R2 ✓ · NFC ✓(where required) · Credits · Version. Any required component failing ⇒ status line replaces READY (PRINTER OFFLINE / SCANNER NOT FOUND / UPDATE REQUIRED / UPLOAD UNAVAILABLE) and gates only the affected actions (printer offline doesn't block scanning).

Distribution: Developer-ID-signed + notarised DMG/pkg; versioned releases; staged rollout ladder (Internal → Pilot → 5% → 25% → 100%) implemented as release-channel field per station for 5,000-ready; pilot = manual install of signed build. Rollback = previous signed build retained + min/max version gates.

---

## 14. AUTH / ONBOARDING CLOSEOUT PLAN (Phase 2 — security blockers first)

1. Verify 0077 applied state (migration table + schema introspection + prod /api/version + behaviour probes). If built-not-applied: apply via standard discipline (dry-run, owner gate for prod).
2. Denial-of-recovery fix (BLOCKER): the route that invalidates a user's password-setup/reset link must require either authentication as that user, possession of the current token, or rate-limited + non-enumerating semantics. Design: requesting a NEW reset link supersedes the old (normal), but an unauthenticated call must never be able to invalidate arbitrarily by identifier without issuing a deliverable new link to the account's email; add per-identifier rate limit (e.g. 3/hour) + generic response (no user enumeration) + audit event.
3. Legacy MFA reset route: align permission to SA-only (or owner-for-own-staff if that's the current product rule — pick per repo evidence, record in RTM), audit every use.
4. Session invalidation on password reset: on successful reset, revoke ALL sessions for the user (session store delete by user id), rotate any remember-me tokens; add AT-18 coverage (old cookie → 401). Define stale-session lifetime (idle + absolute caps) if absent.
5. Pending-organisation onboarding accuracy: /api/partner/me readiness computed per SM-D conjunction; badge states INVITED/AWAITING_PASSWORD_SETUP/AWAITING_MFA_SETUP/LOGIN_BLOCKED/STATION_SETUP_REQUIRED/READY; no "READY because rows exist".
6. Reproduce and fix the known production-baseline Partner UI crash (identify from error logs/Sentry-equivalent or repo TODO; it is in-scope BLOCKER per brief).
7. Keep the 0077 improvements (loud-fail projection, cache-control, badge null-safety) — regression-guard them with tests if not already.

---

## 15. GRADING WORKSTATION PLAN

One canonical workstation, three role profiles (HQ Admin / Staff / Partner Grader) differing only in: visible queues (Partner sees own tenant only — RLS makes this automatic), permitted actions (Partner cannot approve own QA when policy=100% SA; cannot access corrections beyond own tenant), and visibility of internal tooling. MVGS remains server-authoritative: client posts observations/evidence; server computes overall, subgrades, tier, label, printability, pristine/Black Label, stamps mvgs_rules_version. No browser grade persistence route exists or is added (I10). PROTECTED: no changes to scoring maths, floor formulas, calibration.

Edit lease (new, small): `grading_leases(card_job_id UNIQUE, user_id, acquired_at, heartbeat_at)`. Open job ⇒ acquire (fail ⇒ read-only banner "Being graded by Ashley — request takeover"); heartbeat 30s; expiry 2×heartbeat ⇒ acquirable; takeover = explicit action, audited, notifies (banner) the previous holder; autosave drafts keyed to (job, version) with optimistic concurrency (version check on submit; stale ⇒ reload-merge prompt). This closes silent-overwrite risk without inventing CRDTs.

Card identity confirmation before final grade: TCG/set/card number/name/variant via existing TCGdex-backed pickers (reuse PR #142/#145 machinery). Identity correction: editable pre-approval without touching MV/credit/evidence; post-approval via Correction flow only.

---

## 16. QA / TRUST / CORRECTION PLAN

Pilot: 100% Super Admin QA (hard setting). Schema supports future policy per tenant: review_percentage, risk_state, quality_state, force_100_override — built now, UI-set later; sampling engine itself is Pilot-2 (recorded scope) — do NOT build adaptive sampling in this pass, only the policy fields + mandatory-trigger hooks so it bolts on. Mandatory-review triggers implemented as flags on submission (any ⇒ QA regardless of percentage): new partner (<N approved), new grader, 10/Black-Label candidate, repeated FIX on job, correction-origin, plus room for value/risk/distribution/station-anomaly triggers (enum, additive).

Quality signals recorded per tenant/grader/station (counts, not judgements): QA failures, returned grades, corrections, bad-scan invalidations, FIX rate, grade distribution snapshot. SA responses (existing/console actions): warn, set review %, force 100%, suspend grader/station/partner, emergency takeover. No hard-coded 3-strike automation — measured signals + SA action (matches brief §26).

Corrections: pre-finalisation image issues = FIX. Post-approval/post-print = Correction/Regrade workflow: opens CORRECTION_OPEN, routes to originating shop by default (SA can take over), produces a new version of the grade/cert record (version-aware history, I11, population-safe per Locked rule 9). Ordinary FIX cannot touch approved history (state machine forbids).

---

## 17. CERTIFICATE / PRINT / NFC PLAN

Certificate issued at APPROVED→PRINTABLE using 0076 allocation; origin snapshot frozen (shop display name + location/address at approval; trigger-protected). Label render server-side from approved record (layout v31 pipeline reused; Partner label carries Partner origin line). Print: partner print console = reuse staff printing console parity (PR #141 lineage) scoped to tenant; print job rows with history; reprint = same certificate, new print-history row, audited, zero credit/MV (AT-19). Printer jam handling is therefore purely "reprint".

NFC: binding table nfc_tags(tag_uid UNIQUE, certificate_id UNIQUE) — 1:1 both ways; retry writes to the SAME cert (AT-20); failed tag ⇒ new tag_uid, old binding row voided+audited. Fold in-scope NFC hardening backlog items where they touch this path: content-bound HMAC cert signing for the NFC URL payload, validate NFC URL format on save; endpoint rename can ride along if trivial. No provisional grade reaches printable output: PRINTABLE gate requires APPROVED (I10, I16).

---

## 18. OBSERVABILITY / SUPPORT / UPDATE PLAN

Metrics (emit via existing logging/metrics stack; if none, structured logs + a metrics table/pg-boss counters for pilot, real TSDB is 5,000-ready): station online count/last_seen distribution, capture success/failure, upload latency/error rate, credit reservation failures + idempotency conflicts, reconciliation drift (wallet vs ledger — MUST be zero), FIX backlog, grading backlog, QA backlog, print failures, webhook processing lag/failures, login failures, cross-tenant-denial count (RLS denials logged = attack telemetry), DB latency, R2 error rate, app version histogram.

Alerts (pilot: email/Slack via existing channel): webhook failures, reservation drift ≠ 0, systemic capture failure (>X in Y min), migration/schema mismatch on boot, error-rate spike, station version below minimum in ACTIVE use.

Support: Scanner Diagnostics screen (station id, version, scanner/printer detected, network/upload state, queue depth, recent anonymised error codes + timestamps — NEVER secrets/DB URLs/customer data) + "Generate Support Code": uploads a redacted bundle, returns short code the shop reads over the phone; SA console resolves code → bundle. Runbooks (docs/partner/runbooks/): webhook failure, reservation drift, station replacement, R2 partial failure reconciliation, emergency stop, rollback.

Reconciliation worker (pg-boss, hourly): wallet-vs-ledger, accepted-side-vs-R2 HEAD, orphan R2 objects (report only), stuck states past thresholds → ABANDONED flags.

---

## 19. SCALE / LOAD PLAN

Targets: the figures below are INITIAL STRESS TARGETS, not locked business requirements. Phase 1/13 first establishes the realistic expected workload model for 5,000 shops (cards/shop/day, scan cadence, poll intervals), then tests materially above expected peak. Invariant correctness under load outranks any requests/sec figure — a run that misses a latency number but holds every invariant is a tuning task; a run that hits every number but drifts the ledger is a failure. Initial stress figures: 10,000 registered stations / 5,000 concurrently online / 1,000 concurrent capture-upload-finalise ops; NEW-card tx p99 < 300ms at 200 NEW/s burst; heartbeat+dashboard poll load sustained at 5,000 stations without pool exhaustion; webhook processing lag < 30s at 50 events/s; zero invariant violations in every run (ledger exact).

Method: k6/artillery-style harness (or existing tooling in repo) against staging (ep-purple-voice + mintvault-v2) with synthetic tenant generator (1,000 tenants × stations × users seeded by script). Scenarios: concurrent login storm, wallet reads, NEW races (deliberate last-credit contention), FIX queue polling, capture uploads (R2 staging bucket), dashboard polling, grading submissions, QA transitions, webhook replays.

Inspect and fix: query plans on hot paths (EXPLAIN ANALYZE in CI for the 10 hottest queries), missing indexes (reservations by tenant+status, jobs by tenant+state, evidence by job+side+active, stations by tenant), N+1 in dashboard/queue endpoints, RLS predicate cost (index on tenant_id everywhere; verify RLS doesn't defeat index usage), connection pool sizing vs Neon limits (pooled string; per-tx GUC compatible), wallet hot-row contention (single-row FOR UPDATE per tenant is fine — contention is per-tenant, not global), MV allocator global contention (measure; OD-2 if it fails), R2 throughput/parallelism, pg-boss queue latency.

---

## 20. MIGRATION PLAN

Discipline (locked): never edit applied migrations; new numbered files only; idempotent (IF NOT EXISTS/IF EXISTS); additive-then-cutover; dry-run + destructive-warning inspection + explicit owner approval before prod apply; compat views for any rename (7-day window).

MIGRATION NUMBER SAFETY (mandatory — MintVault has had collisions before): before creating ANY post-0077 migration, Opus discovers the GLOBAL migration high-water mark across: current HEAD, origin/main, all relevant local/unmerged branches and worktrees, the staging migration journal, and the production migration journal. Never assume a number is free merely because it is free in the current worktree. Record the discovered high-water mark in the Phase 1 report; number all new migrations above it.

Proposed new migrations (numbers below are PLACEHOLDERS relative to 0077; Opus renumbers above the discovered global high-water mark; MERGE into fewer files where cohesive, split where rollback isolation matters):

- 0078_partner_credit_packs_and_ledger_hardening: credit_packs table; ledger UNIQUE(source_event_id); partial unique reservation-per-job index if absent; status-transition guard triggers (I2, I5).
- 0079_partner_op_idempotency: partner_op_keys(station_id, client_op_id UNIQUE, card_job_id, created_at).
- 0080_partner_fix_authorisation: fix authorisation/session scoping (job, sides[], expires_at) + single-active reuse of 0075 constraint; side-evidence active-uniqueness index if absent.
- 0081_partner_station_lifecycle: status enum extension, last_seen, app_version, health jsonb, min_supported_version setting, release_channel; immutability triggers for tenant/location on stations+jobs+sessions (I7).
- 0082_grading_edit_lease: grading_leases table.
- 0083_partner_qa_policy_fields: review_percentage, risk_state, quality_state, force_100_override, mandatory-trigger flags on submissions.
- 0084_nfc_binding_uniqueness: nfc_tags 1:1 constraints (if current schema lacks them) + cert print_history if absent.
- 0085_partner_rls_extension: RLS policies for all new tables + default-deny verification.
  Each: rollback strategy = forward-fix preferred; every migration ships with a down-path note in-file; production risk note; applied first to local Postgres, then staging, then prod behind owner gate (Phase 16).

---

## 21. TEST PLAN

Layers: unit (transition fns, permission guards, pack mapping); integration on REAL local PostgreSQL (RLS on, partner role, tenant GUC — never mocked DB for RLS/tx tests); HTTP (supertest-style against real server); browser (Playwright: onboarding, dashboard, buy-credits redirect stubbed to webhook simulator, workstation lease banner, responsive at 1280/1440 + iPad-width dashboard); security (cross-tenant matrix §8 auto-generated per route; auth follow-ups AT-17/18); concurrency (parallel-worker tests for AT-1/4/9 + lease races); load (§19); physical (§27 pilot script).

Acceptance matrix AT-1…AT-20 implemented exactly as brief §48 (same numbering), plus:

AT-21 — WEBHOOK GRANT UNDER CONCURRENT NEW: balance = 0; a verified Stripe webhook grants 10 Grading Credits while two stations attempt NEW concurrently. Prove: webhook grants exactly once; resulting capacity exactly 10; no stale balance/cache causes incorrect rejection or overspend at the grant boundary; maximum ten NEW jobs; 11th rejected; ledger/reservations reconcile exactly.

AT-22 — FIX FORENSIC INTEGRITY / ABUSE MEASURABILITY: invalidate FRONT on an existing paid Card Job and replace it. Prove preserved: original immutable evidence, replacement evidence, actor, station, reason, timestamps. Prove repeated/abnormal FIX behaviour is measurable (per-job and per-tenant FIX counts feed §16 quality signals) and can force QA/risk review via the mandatory-trigger flags. FIX must never erase forensic evidence.

AT-23 — MULTI-MACHINE STATE INDEPENDENCE: prove no state is accidentally tied to one Fly instance (run in staging with 2 machines, forced request pinning per step): NEW begins via Machine A, continuation (uploads, pair-confirm) hits Machine B; FIX authorised on A, upload/finalisation lands on B; login/session valid across both; last-credit race with the two competing requests handled by DIFFERENT Machines still yields exactly one winner; webhook processed by A, wallet read immediately via B shows granted capacity. Shared PostgreSQL/R2 remain the sole source of truth; any process-local cache must be correctness-safe when cold/stale (I19).

All 23 green + zero BLOCKER/HIGH open = CODE-COMPLETE. (Phase gates P5→AT-21, P7→AT-22 added.)

Test-infra notes: seed factory for tenants/stations/credits; webhook simulator signing real Stripe signatures with test secret; R2 tests against staging bucket or S3-compatible local (whatever repo already uses — reuse); full-suite regression baseline = current recorded baseline, zero NEW regressions permitted (0077 standard).

---

## 22. OPUS SUB-AGENT ORGANISATION

Opus is main brain and REMAINS IN /Users/cornelius/mintvault-partner-pilot-pass2: owns global invariant register, RTM, integration, merges, release gates, final verdict. Worktree policy: read-only/review agents (A1, A9 review passes) need NO separate worktree; editing agents use isolated worktrees ONLY when concurrency genuinely requires it, otherwise branches in place. All code and findings return to Opus for SEMANTIC integration (Opus re-reads and reconciles, not blind merge); NO sub-agent or sibling branch merges to mainline or deploys independently, and no sub-agent decides architecture. Conflict resolution: Opus decides citing invariant register + locked rules; unresolvable business questions → Owner Decision Register, not improvisation.

Agents (parallelise groups; serial fallback fine):

- A1 Archaeology/Reuse: repo+schema inventory, reuse map, watcher/capture-lineage verdict, RTM path column. Returns: architecture map diff vs plan §2, reuse matrix with file evidence.
- A2 DB/Migrations/RLS: migrations 0078+, RLS extension, transition triggers, pooling+GUC pattern audit. Returns: migration files + local-apply proof + RLS negative-test results.
- A3 Credits/Wallet/Payments: §9 tx implementation, packs, checkout, webhook handlers, reconciliation worker. Returns: code + AT-1/2/4/5/7/9/16 green.
- A4 Scanner/Station: NEW/FIX flows, enrolment/lifecycle, readiness, diagnostics, capture binding, upload verify. Returns: app + endpoints + AT-5/6/12/13/15 + hostile capture list §18-brief green locally.
- A5 Auth/Onboarding Security: §14 items 1–7. Returns: fixes + AT-17/18 + denial-of-recovery proof.
- A6 Dashboard/UX: §12 + Delete-image→FIX semantics + browser tests.
- A7 Grading/QA/Corrections: lease, role gates, QA policy fields, correction flow, MVGS-authority verification (read-only vs protected maths).
- A8 Cert/Print/NFC: §17 + AT-19/20.
- A9 Hostile Review: independent adversarial pass over A2–A8 output vs invariant register + tenant matrix; runs full §8 attack list. Reports defects to Opus; BLOCKER/HIGH fixed in-pass (no-bullshit rule).
- A10 Load/Observability: §18/§19 harness + metrics + alerts + runbooks.
- A11 Release/Docs: release gates, rollout/rollback plan execution artifacts, pilot script, certification template, acceptance evidence bundle.

Integration sequence: A1 → (A2) → {A3,A4,A5 parallel} → {A6,A7,A8 parallel} → A9 hostile → fixes → A10 → A11. Opus integrates after each group, re-running the acceptance subset touched.

---

## 23. DEPENDENCY-ORDERED EXECUTION PHASES

Continuation rule (locked): phase gate green ⇒ continue automatically. Stop ONLY for: owner/business decision, missing external credential/dependency, irreversible/destructive production action, hard session/tool limit.

| Phase                         | Scope                                                                                                                                                                                                                | Entry          | Proof gate                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| P0 Reconcile                  | pwd; git status --short; git log -10 --oneline; git branch --show-current; merge-base --is-ancestor for 6f0d59df, 9a242c6b, cda06227; curl prod /api/version; 0077 applied? live moved? schema dump; route inventory | —              | Written reconciliation report; repo facts supersede stale docs   |
| P1 Map                        | Reuse map, invariant register file, state-machine mapping to real enums, RTM skeleton, tenant matrix skeleton, skill discovery (inspect installed skills, list which apply)                                          | P0 report      | All Phase-1 docs exist with file-level evidence                  |
| P2 Auth closeout              | §14 all items incl. UI crash                                                                                                                                                                                         | P1             | AT-17/18 green; denial-of-recovery hostile test fails closed     |
| P3 Card Job convergence       | Canonical Card Job on 0074 lineage; transition function; immutability triggers                                                                                                                                       | P1             | Transition unit tests; I1/I7 proven                              |
| P4 Credit authority           | §9 full; migrations 0078/0079                                                                                                                                                                                        | P3             | AT-1/2/4/5/7/9 green on real PG                                  |
| P5 Buy credits                | §11; webhook handlers                                                                                                                                                                                                | P4             | AT-16 + AT-21 green; Playwright purchase flow w/ simulator       |
| P6 Scanner NEW                | §10 NEW; station enrolment/readiness minimum                                                                                                                                                                         | P4             | AT-5/6 green; capture binding hostile subset                     |
| P7 Scanner FIX                | §10 FIX + dashboard Delete-image semantics                                                                                                                                                                           | P6             | AT-12/13/14/15/22 green                                          |
| P8 Dashboard                  | §12 complete                                                                                                                                                                                                         | P5,P7          | Browser tests green; queue correctness vs states                 |
| P9 Workstation                | §15 lease + roles                                                                                                                                                                                                    | P3             | Lease race tests; two-session manual check                       |
| P10 QA/Corrections            | §16                                                                                                                                                                                                                  | P9             | QA policy tests; correction versioning tests                     |
| P11 Cert/Print/NFC            | §17                                                                                                                                                                                                                  | P10            | AT-19/20 green                                                   |
| P12 Observability/Support     | §18                                                                                                                                                                                                                  | P6             | Metrics visible; reconciliation worker running; runbooks written |
| P13 Load                      | §19                                                                                                                                                                                                                  | P4–P11         | Targets met or OD raised with data                               |
| P14 Hostile E2E               | A9 full pass; complete §8 matrix; all 23 AT incl. AT-23 multi-machine                                                                                                                                                | all            | Zero open BLOCKER/HIGH; tenant matrix complete                   |
| P15 Release package           | Docs, evidence bundle, rollback capture, staging deploy full E2E                                                                                                                                                     | P14            | Staging E2E green; safe-deploy dry run                           |
| P16 OWNER GATE → prod rollout | §25 plan; prod migrations; safe-deploy; verify both machines; /api/version                                                                                                                                           | Owner approval | Prod verification checklist green                                |
| P17 Physical pilot            | §27 script on real Mac/shop setup                                                                                                                                                                                    | P16            | §28 certification report answers YES                             |

---

## 24. OWNER DECISION REGISTER (only genuinely unresolved)

- OD-1 (conditional): capture engine for pilot IF Phase 0 finds both watcher pipeline and ImageCaptureCore path working. Default recommendation: ImageCaptureCore engine + watcher UX. Consequence of watcher/SilverFast: faster pilot maybe, but ships legacy token-env pattern and SilverFast dependency to a shop.
- OD-2 (conditional): if gapless MV allocator fails load targets — proposal: gapless-within-day segments (MV-YYMMDD-nnn) vs relaxing throughput target. Only raised with load data.
- OD-3: credit pack PRICES (structure decided; £ numbers are owner's), and confirm packs are Partner-only pricing invisible to retail customers.
- OD-4: pilot cancellation policy — which states allow Partner self-cancel vs SA-only (plan default: self-cancel allowed CREDIT_RESERVED/NEEDS_SCAN only; CAPTURING+ = SA).
- OD-5: MANAGER billing permission default (plan default: off, Owner grants).
- OD-6: VAT treatment of credit packs — accountant confirmation before public pricing page (non-blocking for build).

Everything else in the brief is treated as decided.

---

## 25. PRODUCTION ROLLOUT PLAN

TOPOLOGY (locked): production is intentionally a MINIMUM two-Machine Fly deployment; both run the same app, share central PostgreSQL/R2, and may receive any Partner/Scanner request. Never solve a rollout/schema problem by deleting a Machine — single-Machine operation is temporary emergency troubleshooting only. Release verification is incomplete until BOTH Machines serve the intended new SHA.

Preconditions: P15 green; Opus has reported THREE SEPARATE statuses to the owner — CODE-COMPLETE (yes/no + evidence), PILOT-READY CANDIDATE (yes/no + what remains physical-only), 5,000-SHOP SCALE STATUS (met/partial/not-run + data) — and the owner has approved (P16 gate). The phrase "production-ready" is never used without naming which level and citing its completed proof. Steps: (1) verify git clean + HEAD ancestry incl. live SHA via /api/version (moving-target check); (2) capture rollback image ref + current SHA; (3) apply new migrations to prod via standard tooling with dry-run output reviewed (destructive warnings = stop); (4) safe-deploy wrapper only (never raw fly deploy); embedded SHA; (5) verify /api/version on BOTH Fly machines; health/readiness INCLUDING the schema-contract readiness check (I18); confirm the release's mixed-version compatibility checklist (I17) is signed off — expand → migrate → deploy → contract where any change is not old-version-safe; (6) real Partner API smoke: 401 unauth /api/partner/me, authed onboarding state, wallet read, NEW-card on a test tenant with 1 test credit then cancel/release, webhook test-mode purchase; (7) feature flags: partner buy-credits + FIX UI behind flags, flipped after smoke; (8) monitor alert channel 24h before pilot start.

## 26. ROLLBACK PLAN

App: redeploy captured rollback image (both machines), verify /api/version. DB: migrations are additive — rollback = forward-fix; each migration file documents its down-path; never destructive rollback on prod. Flags: buy-credits/FIX/portal flags off = instant behavioural rollback without deploy. Data: any ledger/wallet incident → freeze NEW (emergency stop flag), reconcile from ledger (source of truth), SA audited adjustments only. Stripe: webhook endpoint can be paused; events replayable (idempotent handlers make replay safe). Communication: single runbook page docs/partner/runbooks/rollback.md with exact commands.

## 27. PHYSICAL PILOT SCRIPT (locked acceptance, ≥10 credits)

Setup: fresh real Partner org; real login+MFA on real Mac; station enrolled+approved; grant exactly 10 credits (audited GRANT); Partner B org exists with 1 card for isolation checks; printer + (if required) NFC ready.

1. Scan 10 real cards rapidly (NEW×10; note each MV; mark physical cards).
2. During the run deliberately: one bad FRONT (card k), one bad BACK (card m), one Scanner restart mid-card (must resume same job, AT-5), one network interruption mid-upload, one duplicate watcher/file event.
3. Attempt card 11 → rejected with zero-credit UX.
4. Dashboard: Delete FRONT on card k → appears ONLY in this tenant's FIX as "MVxxx — FRONT missing"; Delete BACK on card m likewise.
5. With ZERO credits: FIX both via Scanner FIX queue → zero additional credits (wallet before==after screenshot/ledger).
6. Partner B login: sees nothing of Partner A (spot-check every queue + direct MV probe → denied).
7. Add 1 Grading Credit via audited Super Admin GRANT (default; a real live Stripe purchase only with explicit owner authorisation — the webhook path is already proven in staging test mode and, when authorised, by the later commercial production proof) → card 11 immediately startable.
8. Grade all 11 in canonical workstation (two-grader lease check on one card); submit; 100% SA QA; approve; settle (each credit consumed exactly once).
9. Issue certificates; print ≥1 real label (verify Partner origin line + grade matches authoritative); NFC bind+retry test where applicable; complete/return states.
10. Reconcile and record: wallet, ledger, reservations (11 consumed, 0 stranded), Card Jobs, MVs (gapless run), side evidence + superseded masters for the two FIXed cards, FIX events, grades, QA, certs, print history, audit trail — ALL EXACT.

## 28. PILOT CERTIFICATION TEMPLATE

`docs/partner/PILOT_CERTIFICATION_<date>.md`: Partner identity/location/station/operator; software versions (server SHA, Scanner version, MVGS rules version); starting credits; NEW attempts (accepted/rejected counts); wallet reconciliation table; reservation table dump; MV list; FIX events; cross-tenant attack results; concurrency test results; scan/grade/QA/settlement records; certificate ids; print evidence (photo); NFC results; load-test summary; remaining known issues (severity-tagged); rollback info (image ref, SHA). Final line answers explicitly: **CAN THIS MAC BE PUT IN A REAL CARD SHOP TOMORROW? YES/NO + conditions.**

## 29. 5,000-SHOP SCALE READINESS CRITERIA (separate from pilot-ready)

CODE-COMPLETE = all AT green + zero BLOCKER/HIGH + staging E2E. PILOT-READY = P17 certification YES. 5,000-SHOP-READY additionally requires: load targets met (§19) with report; fleet observability on real TSDB + alerting; signed auto-update feed + staged rollout channels operational; support-code workflow tested; SA control centre covering §33-brief action list; runbooks complete + one tabletop incident exercise; DR: Neon PITR verified restore test, R2 versioning/object-lock on evidence bucket, documented RPO ≤ 1h / RTO ≤ 4h assumptions; per-tenant rate limiting on public/partner endpoints; audit_log growth plan (partitioning/archival). Never call anything "production-ready" without naming which level.

## 30. FABLE'S ADDITIONAL RECOMMENDATIONS

R1 (security) Per-tenant + per-station rate limiting on NEW, FIX-authorise, checkout, and auth routes — race protection is not abuse protection.
R2 (integrity) Content checksum (SHA-256) captured client-side per upload, verified server-side post-R2-write, stored on evidence row — makes I8/I15 provable and dedup exact.
R3 (payments) Grant credits via transactional outbox: webhook handler writes event+ledger in one tx; a pg-boss job emits receipts/notifications — never do side-effects inside the webhook response path.
R4 (RLS) Add an automated "default-deny" CI check: connect as partner_runtime_app with no GUC set and assert zero rows from every partner table.
R5 (allocator) Verify the gapless allocator is NOT a Postgres SEQUENCE (sequences gap on rollback). If it is, that's a live invariant breach today — fix in P3.
R6 (ops) Emergency-stop flag per tenant AND global (blocks NEW + purchases, allows grading/FIX) — one switch for incident response.
R7 (clock) Station heartbeats report local clock; server flags skew >5min (capture timestamps feed provenance).
R8 (privacy/GDPR) Partner staff are data subjects: extend privacy notice scope to partner users; enrolment stores device fingerprints — document lawful basis (legitimate interest, security); diagnostics bundles auto-redact; retention rule for revoked-station records. (uk-gdpr skill scope; solicitor review rides existing Stage B track — flag, don't block.)
R9 (consumer law) Partners are businesses ⇒ B2B terms, but publish clear pack pricing, no drip fees; DMCC hygiene anyway. Partner T&Cs (credit expiry? plan: credits don't expire for pilot) → solicitor list.
R10 (evidence bucket) Separate R2 prefix/bucket policy for immutable masters with object versioning enabled now — retrofitting immutability later is painful.
R11 (support) "Station replacement" runbook (Mac dies mid-pilot): revoke old, enrol new, in-flight jobs resume via idempotency keys — test it once in P17 setup, not during a real failure.
R12 (webhooks) Alert on webhook signature failures specifically — early tamper/misconfig signal.
R13 (UX) Scanner NEW confirmation should also show running tally ("Card 7 of ~10 credits") — shops batch by credits.
R14 (docs) Every phase closes by appending to docs/partner/ACCEPTANCE_EVIDENCE.md — the pilot report then assembles itself.
No locked rule changed by R1–R14; OD-1/2 are the only owner-gated proposals.

FABLE ADDITIONAL BLOCKER/HIGH RECOMMENDATION (raised by Amendment 14, required for correctness): B-1 — NO PROCESS-LOCAL AUTHORITATIVE STATE (now invariant I19). The two-Machine topology makes any per-process authoritative state a latent correctness bug: an in-memory wallet/capacity cache, in-memory idempotency map, in-memory edit-lease table, in-memory session store, or module-level FIX/queue cache would pass every single-machine test and fail silently in production (stale rejections, double-spend at the grant boundary, lease conflicts, session flapping). A1's archaeology pass must explicitly grep for module-level mutable state on these domains; anything found is a BLOCKER/HIGH fix in-pass. This adds no feature scope — it is the enforcement mechanism Amendment 14's tests assume.

---

## 31. FINAL OPUS EXECUTION PROMPT

Copy/paste everything between the lines to Opus, alongside this document (MINTVAULT_PARTNER_MASTER_PLAN_FABLE.md must be available to it):

---

You are Claude Opus, MAIN BRAIN and LEAD ENGINEER for the final MintVault Partner Shop Grading build. Your execution programme is MINTVAULT_PARTNER_MASTER_PLAN_FABLE.md (the "Plan"). Read it fully before any action.

AUTHORITY MODEL: You coordinate all sub-agents and remain in the canonical worktree; read-only/review agents use no separate worktree; editing agents get isolated worktrees only when concurrency genuinely requires it; all code/findings return to you for semantic integration; no sub-agent or sibling branch merges to mainline, deploys, or makes irreversible decisions. You own the invariant register (Plan §6), the RTM (§7), the tenant matrix (§8), integration, release gates, and the final production-readiness verdict. Repo facts supersede any stale document, including the Plan's verify-first claims; the Plan's LOCKED BUSINESS RULES (§4) supersede everything except explicit owner overrides.

SKILLS: Before Phase 1 completes, inspect the actually installed skills on this machine (list the skills directory contents; do not assume names) and load every relevant one — at minimum any no-bullshit completion controller, engineering-OS/build-controller, hostile-review/release-verification, migration/DB-safety, RLS/RBAC/security, UI/browser/responsive, scanner/station, deploy/anti-clobber/rollback, and codebase-graph skills present. Record which skills you loaded in the Phase 1 report.

NO-BULLSHIT COMPLETION RULE (mandatory): fix ALL known in-scope BLOCKER/HIGH defects in this same pass. Do not stop to ask for another prompt. When a phase's proof gate is green, continue automatically to the next phase. You may stop ONLY for: (1) a genuine owner/business decision (add it to the Owner Decision Register, Plan §24, and continue with everything not blocked by it), (2) a missing external credential/dependency, (3) an irreversible/destructive production action requiring approval (Phase 16 owner gate, prod migrations, prod deploys), (4) a hard session/tool limit.

EXECUTION: Run Phases P0–P17 exactly as ordered in Plan §23, with entry criteria and proof gates as specified. Phase 0 first, verbatim:
pwd; git status --short; git log -10 --oneline; git branch --show-current;
git merge-base --is-ancestor 6f0d59df HEAD; git merge-base --is-ancestor 9a242c6b HEAD; git merge-base --is-ancestor cda06227 HEAD (where available);
curl the live production /api/version and reconcile if production has moved; determine whether migration 0077 is applied locally/staging/prod;
discover the GLOBAL migration high-water mark across current HEAD, origin/main, relevant local/unmerged branches and worktrees, the staging migration journal, and the production migration journal — never assume a number is free from this worktree alone; number all new migrations above it.
Work only in /Users/cornelius/mintvault-partner-pilot-pass2 (branches for sub-agents; no new root worktree unless technically unavoidable — justify in writing if so).

SUB-AGENTS: Organise per Plan §22 (A1–A11), parallel where tooling allows, serial fallback otherwise. Every agent returns findings/diffs to you; you integrate, re-run affected acceptance tests, and resolve conflicts by citing the invariant register and locked rules.

HARD CONSTRAINTS:

- MVGS scoring maths, floor formulas, and calibration are PROTECTED — read, never modify.
- Never edit an applied migration; new numbered idempotent migrations only; additive-then-cutover; dry-run and destructive-warning review before any prod apply; explicit owner approval for production DB writes and deploys; safe-deploy wrapper only; verify /api/version on both Fly machines after deploy.
- No hard deletes on business tables; soft-delete + audit_log (columns: entity_type, entity_id, action, admin_user, details jsonb, created_at).
- Tenant isolation is DB/RLS-enforced with per-transaction GUC tenant context; partner_runtime_app NOBYPASSRLS; default-deny verified (Plan R4).
- Grading Credits (use this term in all UI/copy/docs): trace and REUSE the canonical 0041–0043 ledger/reservation accounting — no second wallet/balance model, no hard-coded new availability formula. Locked outcomes: one NEW Card Job removes exactly one unit of available capacity; exactly-once reservation/consume/release; FIX never changes wallet capacity; reconciliation mathematically proves the ledger/reservation result. Idempotency keys on all mutating Scanner/purchase operations; the verified Stripe webhook is the only credit-granting authority — a browser success page never grants, in any environment.
- Production Stripe: staging is test mode; the first live physical workflow uses audited Super Admin-granted credits unless the owner explicitly authorises a real live purchase; the commercial production proof (one authorised real purchase → live webhook → ledger → wallet → NEW capacity) is a separate, owner-gated step.
- Production topology (LOCKED): minimum two Fly Machines, both serving all traffic against shared PostgreSQL/R2; never delete a Machine to dodge a rollout/schema problem (single-Machine = temporary emergency troubleshooting only); release verification requires BOTH Machines on the new SHA. Rolling deploys create a mixed-version window; every schema/API change must be old+new compatible during rollout or follow expand → migrate → deploy → contract; no release may fail the old machine while the new starts (Plan I17). Each app version proves its required schema at startup and fails closed with a visible readiness/configuration error — never a misleading 401, 500, empty dashboard, or partially-working Partner UI (Plan I18). No process-local authoritative state anywhere (sessions, wallet, idempotency, leases, queues) — shared services are the source of truth (Plan I19/B-1); A1 greps for violations, fixes are BLOCKER/HIGH in-pass.
- Audit coverage: emit audited events (actor, tenant, location/station, timestamp, reason, before/after) for every action in Plan §6 MANDATORY AUDIT COVERAGE list — including split password-reset and MFA-reset events, station approval/suspension/revocation, Partner suspension, and emergency takeover; verify each by test.
- Load: treat Plan §19 figures as initial stress targets; establish the realistic expected 5,000-shop workload first, test materially above expected peak; invariant correctness outranks throughput numbers.
- FIX is zero-credit, side-scoped, existing-job-only, can never mint MV numbers or reservations, and NEVER requires manual MV entry in normal operation — the FIX queue is server-derived; manual MV lookup is controlled recovery only, tenant-isolated, incapable of exposing another Partner's cards.
- Never run git clean -fd without explicit per-incident permission; git reset --hard HEAD is the sanctioned recovery.
- If you fix the same bug a third time, stop and pull real logs/diagnostics before another attempt — no third blind fix.
- No fake data in anything deployable; no marketing/UI claim that the code doesn't actually do.

DELIVERABLES: maintain docs/partner/{INVARIANTS.md, RTM.md, TENANT_MATRIX.md, ACCEPTANCE_EVIDENCE.md, runbooks/}, the migration set (Plan §20 renumbered to reality), the full acceptance matrix AT-1…AT-23 automated and green (Plan §21, including AT-21 webhook-grant-under-concurrent-NEW, AT-22 FIX forensic integrity, AT-23 multi-Machine state independence), the staging E2E, the release package (Plan §25/§26), a pre-rollout owner report stating separately CODE-COMPLETE / PILOT-READY CANDIDATE / 5,000-SHOP SCALE STATUS (never an unqualified "production-ready"), and after the owner-gated rollout and physical pilot (Plan §27), the Pilot Certification Report (Plan §28) ending with an explicit YES/NO to: CAN THIS MAC BE PUT IN A REAL CARD SHOP TOMORROW?

## Begin with Phase 0 now.

END OF MASTER PLANNING PACKAGE
