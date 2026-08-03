# PARTNER SHOP PILOT COMPLETION — Programme Plan

**Programme ID:** PSP · **Created:** 2026-07-29 · **Director:** Lead session (this)
**Baseline:** origin/main @ `6b30136f` (verified) · Staging `v436` @ 6b30136f, journal 26 · Prod `v1065` @ `6f182624`, journal ~22 (re-verify at apply time) · All partner flags OFF everywhere (zero `partner_feature_flags` rows)
**Objective:** ONE partner shop processing real grading submissions end-to-end on STAGING.

---

## 1. Verified repository state (Stage 3-verified, 4 reviewer reports + Lead greps)

Merged & live-dark on main:
- Identity/tenancy/RLS: 14 foundation tables + FORCE RLS (`tenant_id = partner_current_tenant()`), SECURITY DEFINER pre-auth fns owned by BYPASSRLS `partner_definer`. Migrations 0001–0006.
- Intake: partner_customers / service_tiers / submissions / cards / events / handoffs (0007).
- Connector G1–G3F: full queue→validate→exactly-once-import chain, reconciliation, import attempts (0008–0013). **Code complete, runtime INERT — zero production drivers.**
- G4 connector-ops admin + 0014; G5 partner CRM + 0015; Partner Master Dashboard (merged & mounted at routes.ts:2802 — its task ledger is stale).
- Wallet G6A/G6B/G6C: 0016/0017 applied BOTH DBs; services are dead code (no HTTP, no callers).
- Partner User Management (PR #270): invitations, owner login, team mgmt, final-owner invariant. 0031/0032 STAGING ONLY.
- Portal client (Increments A+B): login+MFA, invite accept, dashboard, 5-step submission wizard w/ optimistic locking, team page. Bundled in main SPA, always routed.
- Deployed server mounts ONLY: 4 public partner routes + 4 super-admin surfaces. `createPartnerApp()` (full authenticated portal) has **zero non-test callers** (Lead-verified grep).

Key verified defects/gaps (cross-confirmed R3/R4 + Lead):
- **F-A** Global feature flags have NO write path (admin route writes tenant rows only; public gates read global rows only). Enabling the pilot today requires direct SQL.
- **F-B** Portal API unmounted + serving-topology contradiction (partner app serves placeholder HTML; real pages in main SPA).
- **F-C** Public slice doesn't check `partner_portal_enabled` (master switch dead on the only live routes).
- **F-D** No MFA enrolment or password-reset UI (server endpoints exist; invited user cannot complete first login).
- **F-E** Connector has no driver: nothing creates connector records from handoffs; worker never started.
- **F-F** Wallet/reservations wired to nothing; ledger CHECK lacks 'consumption' entry type (consume writes `admin_adjustment`) — R2-F1.
- **F-G** G6D (credit↔submission) unmerged branch only; its migration adds a trigger ON public.submissions (PROTECTED — owner gate).
- **F-H** Stale WIP branch `codex/partner-auth-invitations-rbac` (b000f89c): its 0020 is DEAD (incompatible `partner_invitations` vs merged 0031 — silent IF NOT EXISTS trap); 0021 shop tables (credit packages/Stripe events/readiness/pilot auth/origin snapshots) salvage-by-rewrite only.
- **F-I** `partner_owner_invariant_tenants` no RLS (low); duplicate partial index on partner_invitations (low) — R2-F3/F4.
- **F-J** Increment C (MintVault-side status feedback to partner) never built.
- **F-K** No pricing approval; service-tier global rows unseeded; no tier admin CRUD.
- **F-L** No prod driver concerns for prod: prod journal lacks 0026/0030/0031/0032 → prod deploy of main is FORBIDDEN until sequenced (out of programme scope; prod frozen).

Absent by later-phase design (NOT in this programme): Stripe credit top-up, storefront/custom-domain routing, payout/settlement/invoices (never — prepaid Model B), device enrolment, QA/three-strike, "Graded by shop" origin labels.

## 2. Capability classification

| Capability | Status |
|---|---|
| Partner org CRM (G5) + connector ops (G4) + master dashboard | COMPLETE (dark) |
| Partner user mgmt + invitations (PUM) | COMPLETE code; staging-only migrations |
| Partner auth/session/MFA/RBAC runtime | COMPLETE code; UNMOUNTED |
| Portal client A+B | COMPLETE; onboarding UX gaps (F-D) |
| RLS/tenant isolation | COMPLETE (one low gap F-I) |
| Intake (submissions→handoff) | COMPLETE code; unreachable |
| Connector import chain | COMPLETE code; INERT (F-E) |
| Wallet/credits G6A–C | PARTIAL (schema live; services dead; no HTTP) |
| G6D credit↔submission | BLOCKED (unmerged; protected DDL) |
| Status feedback (Increment C) | ABSENT |
| Pricing/tiers | PARTIAL (schema only; owner decision pending) |
| Shop monetisation (packages/Stripe/readiness) | ABSENT on main; SUPERSEDED drafts on b000f89c |
| Storefront, payouts, devices, QA, origin labels | ABSENT (post-pilot) |

**Completion toward pilot objective: ~60%** (substrate ~85%, activation/integration ~25%, credit loop ~35%).

## 3. Dependency graph & critical path

```
                    ┌────────────────────────────────────────────────┐
[DONE substrate] ──►│ GATE 1 Runtime Mount + Flag Control (WP-1)     │──► GATE 3 Connector Activation (WP-3) ──► GATE 4 Credit Loop (WP-4) ──► GATE 6 Pilot E2E
                    └────────────────────────────────────────────────┘            ▲                                        ▲
GATE 2 Onboarding UX (WP-2, client-only) — parallel with 1 & 3; E2E proof needs 1 ┘                                        │
GATE 5 Status Feedback (WP-5) — needs imports (Gate 3); parallel with Gate 4 ──────────────────────────────────────────────┘
```
**Critical path: G1 → G3 → G4 → G6.** G2 and G5 are off-path parallel. Zero migrations until Gate 4.

## 4. Gates

### GATE 1 — Runtime Mount & Flag Control (WP-1)
- Objective: partner portal API mounted in the deployed server behind fail-closed flags; super-admin can administer GLOBAL flags via API (no SQL).
- Topology decision (Director): mount the partner routers into the MAIN app (SPA already hosts the pages; public routes already there). Preserve the app-factory gates (definer health, portal_enabled, emergency stop) as router-level middleware. The standalone `createPartnerApp` remains for tests.
- Deps: none. Migrations: NONE. Effort: ~1 agent-day.
- Acceptance: with no flag rows everything 503/404s exactly as today; with global rows ON (test DB), full session lifecycle works through the main app; `partner_portal_enabled` gates the public slice too (F-C); global-flag write endpoint audited + super-admin-gated + typed-confirm semantics; ALL existing partner suites green; new integration suite proves mount parity with the app-factory tests.
- Prohibited: client/src, connector files, wallet files, migrations, storage.ts, schema.ts.
- Rollback: revert commits (no data change).

### GATE 2 — Onboarding Completion (WP-2)
- Objective: a freshly invited partner user can go invite → password → MFA enrol → login → session without operator SQL; portal honestly renders unavailable/expired states.
- Scope: MFA enrolment + recovery codes UI, password-reset request/consume pages, wire `PartnerUnavailableState` (503) / `PartnerSessionExpiredState` (401), fix `catch(err: any)`s, remove dead default export (R4 F-5/F-6).
- Deps: none for code (server endpoints exist); Gate 1 for live proof. Migrations: NONE. Effort: ~1–1.5 agent-days.
- Acceptance: full first-login journey against a locally mounted runtime; states rendered on 503/401; typecheck/lint/vitest green; no `any`.
- Prohibited: server/**, admin pages, design-token changes.

### GATE 3 — Connector Activation (WP-3)
- Objective: a submitted handoff automatically becomes a connector record, is validated, and imports into real `submissions`/`submission_items` on a flag-gated, observable, stoppable worker.
- Scope: boot-time worker lifecycle (behind `partner_connector_enabled`, clean shutdown), handoff→record sweep (idempotent via existing `ensureConnectorRecordForHandoff`), super-admin GLOBAL connector-flag + emergency-stop write path (closes G4-DISC-01), ops visibility of worker state.
- Deps: Gate 1 merged (flag admin + mounted intake for E2E). Migrations: NONE. Effort: ~1.5–2 agent-days.
- Acceptance: E2E on disposable PG17: portal submit → handoff → record → validated → imported exactly-once with owner resolution + MV-SUB ref; flag OFF = worker never starts; emergency stop halts claims; kill/restart mid-import = no duplicates (existing fault suites re-run green).
- Prohibited: routes.ts mount block, client, wallet services, any core-table DDL.

### GATE 4 — Credit Loop (WP-4) ⚠️ owner approval required before Stage 5
- Objective: prepaid credits actually gate grading work: reserve on submit, consume on import, admin HTTP surface to grant/adjust credits, minimal partner billing UI.
- Scope: migration 0033 (hygiene: widen ledger entry_type CHECK with 'consumption'; RLS on partner_owner_invariant_tenants; drop duplicate invitation index) + migration 0034 (G6D credit-hold integration REWRITTEN against current main from branch `codex/partner-g6d-submission-credit-integration` — branch migrations are NEVER applied as-is); wire reserve/consume/release into submit + import; G6C credit-admin HTTP endpoints (FIRST ledger write surface — mandatory hostile review); billing.tsx minimal balance+ledger view.
- ⚠️ Protected: 0034 adds a trigger + FK touching `public.submissions` — explicit owner approval of the manifest before editing; design must guarantee the hold can never block non-partner submissions.
- Deps: Gates 1+3. Effort: ~2–3 agent-days + hostile review.
- Acceptance: submit with insufficient credits fails closed pre-handoff; consume writes `entry_type='consumption'` linked to reservation; balance can never go below active reservations (existing triggers re-proven); non-partner submission lifecycle provably unaffected (regression suite on core submission flow).
- Rollback: rollback-0033/0034 scripts authored with fail-closed guards, staging-first.

### GATE 5 — Status Feedback / Increment C (WP-5)
- Objective: partner sees real MintVault-side progress (received → grading → graded/complete) on their submission detail.
- Scope: read-only status mirror keyed on connector import provenance (`partner_connector_imports.destination_submission_id`), surfaced via partner submission API + detail page. NO writes to core tables; poll/mirror pattern, no schema change if achievable via provenance join (preferred); else additive mirror table (Director approval first).
- Deps: Gate 3. Effort: ~1–1.5 agent-days. Parallel with Gate 4 (disjoint files; seam = submission-detail read path only).
- Acceptance: status transitions on the core submission appear to the partner within one refresh; zero grade-detail leakage beyond agreed fields; tenant isolation proven (partner A cannot read partner B's linked submission state).

### GATE 6 — Pilot Readiness & Staging E2E (Lead-driven + one small WP)
- Objective: one real partner org on staging completes the whole loop with evidence.
- Scope: staging env provisioning (PARTNER_DATABASE_URL/PARTNER_ADMIN_DATABASE_URL/PARTNER_CONNECTOR_DATABASE_URL roles + PARTNER_MFA_ENC_KEY — owner/secret actions), BYPASSRLS runtime verification on the live roles, service-tier seeding + owner pricing sign-off, flag activation via Gate-1 API, pilot org + invited user, scripted E2E: invite→enrol→login→customer→submission→submit→import→credits consumed→status visible; runbook + kill-switch drill (emergency stop) + evidence pack.
- Deps: Gates 1–5. Effort: ~1–2 days incl. owner actions. Migrations: 0031/0032 already on staging; 0033/0034 applied staging-first under approval.
- Deliberately deferred (the last 10–20%): Stripe top-up, readiness/pilot-auth tables (manual owner authorisation suffices for one shop), origin labels, storefront.

## 5. File ownership map (hard boundaries)

| Area | Owner |
|---|---|
| server/routes.ts (partner mount block only) | WP-1 |
| server/partner/app.ts, flags.ts, public-routes.ts, admin-routes.ts (flag endpoints) | WP-1 |
| server/config.ts (PARTNER_* env validation) | WP-1 |
| client/src/pages/partner/**, components/partner/**, hooks/use-partner-session.tsx, lib/partner-api.ts, App.tsx (partner block) | WP-2 |
| server/partner/connector-*.ts, NEW server/partner/connector-runtime.ts, server/index.ts (worker boot lines only) | WP-3 |
| server/partner/partner-wallet*/credit*/submission-service credit seams, migrations 0033/0034, billing.tsx | WP-4 (later) |
| partner submission read/status mirror + submission-detail.tsx | WP-5 (later) |
| .claude/controlled-code-lead/** , INDEX.md | Lead only |

NEVER touched by any WP: shared/schema.ts core tables, server/storage.ts, MVGS files, Stripe/webhook code, admin auth (mv.sid), labels/cert rendering, cert_counter, existing migrations.

## 6. Branch / worktree map

| WP | Branch | Worktree |
|---|---|---|
| WP-1 | psp/wp1-runtime-mount | isolated worktree |
| WP-2 | psp/wp2-onboarding-ux | isolated worktree |
| WP-3 | psp/wp3-connector-driver | isolated worktree |
| Integration | integration/partner-shop-pilot-r1 | Lead-owned |

Merge order: WP-1 → WP-3 → WP-2 (WP-2 can land any time; no server overlap). Each WP: hostile review before integration merge. All branches cut from `6b30136f`.

## 7. Migration ownership

- Gates 1/2/3/5: ZERO migrations (hard acceptance criterion).
- Next free number: **0033** (0025 reserved grading-concurrency; 0027 reserved G6D historical; 0028/0029 contested — do not use; parity test pins inventory).
- 0033 hygiene + 0034 credit-hold: Gate 4 only, staging-first via scripts/db/migrate.ts, journal SELECT on BOTH endpoints before sequencing, rollback scripts mandatory.
- Branch migrations from b000f89c / 74f6f785 are DEAD ARTIFACTS — rewrite-only, never applied.
- Prod: FROZEN for this programme. Prod journal must be re-inventoried before any future prod release (0026/0030/0031/0032 pending there; deploy-before-migrate would 500 approvals — known critical).

## 8. Risk register (programme-level)

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Flag semantics split (global vs tenant) enables wrong surface | High | Gate 1 makes global flags canonical for platform switches + audited write path; tests pin resolution semantics |
| R2 | First HTTP write surface over credit ledger | High | Gate 4 hostile review mandatory; append-only triggers already enforce; idempotency keys |
| R3 | G6D trigger on submissions blocks core pipeline | High | Owner-gated manifest; trigger scoped to rows WITH holds only; core-flow regression suite |
| R4 | Stale WIP branches applied by mistake (0020 dead-shape trap) | High | Branch migrations declared dead here; parity test + runner duplicate-reject; rewrite-only rule |
| R5 | Staging BYPASSRLS/env misconfig → silent zeros or fail-open | Med | Gate 6 runtime verification (capability probes exist); fail-closed checks already in code |
| R6 | In-process rate limits on multi-machine staging | Med | Pilot = low volume; document; durable store deferred post-pilot |
| R7 | Pricing unapproved → pilot shows wrong money | Med | Owner sign-off in Gate 6 before flag-on; tiers are staging-only values |
| R8 | Concurrent sessions touching main mid-programme | Med | concurrent-session-discipline before every dispatch/merge; integration branch serializes |
| R9 | Prod accidentally deployed with pending migrations | Crit | Prod frozen; safe-deploy only; explicitly out of programme |
| R10 | PUM hostile-review enumeration missing from record | Low | Accepted: remediation trail 8b0752e3 + green CI; note in ledger |

## 9. Testing strategy
- Every WP: `npm run check`, full `npm test` (LC_ALL=C LANG=C), `npm run lint`, plus the partner PG17 suites relevant to its scope; new behaviour requires new tests in the same suite family; CI wiring verified (suites must actually RUN — historical "green while skipped" trap).
- Gate 3/4: disposable-PG17 E2E + fault-injection reruns; Gate 4 core-submission regression proof.
- Gate 6: scripted staging E2E with captured evidence (responses, journal, ledger rows), per silent-failure-prevention.

## 10. Integration / staging / production strategy
- Integration: Lead merges WPs into integration/partner-shop-pilot-r1 in dependency order; hostile review per WP; single PR to main per release slice; CI green + review clean before merge; INDEX.md + ledgers updated at every transition.
- Staging: owner-gated deploy of merged main; env/secrets provisioning owner-approved; flags ON staging only, via Gate-1 API; migrations staging-first.
- Production: NO prod action in this programme. Prod release is a separate future programme (migration sequencing 0026→0035, deploy, flags remain OFF, then owner launch decision).

## 11. Effort & readiness estimate
- WP-1 ≈ 1d · WP-2 ≈ 1–1.5d · WP-3 ≈ 1.5–2d · WP-4 ≈ 2–3d · WP-5 ≈ 1–1.5d · Gate 6 ≈ 1–2d · reviews/integration ≈ 2d ⇒ **10–13 agent-days**.
- Calendar with owner gates: **~2–3 weeks** to a staging pilot. Programme completes ~85% of remaining launch work (deferring Stripe top-up, storefront, origin labels, device/QA phases).

## 12. Stage 3 verification notes (Lead)
- createPartnerApp zero non-test callers — verified by grep.
- Flag write gap — verified (single tenant-scoped INSERT at admin-routes.ts:239).
- Wallet/connector dead code — verified (no callers outside server/partner; submissions.ts hit is the unrelated customer-credit system).
- Master dashboard IS on main — routes.ts:2802 (task ledger stale; corrected here).
- Branch objects b000f89c / 74f6f785 / 70dbc79c exist; 0020 shape conflict with 0031 confirmed by R2 via git show with line cites.
