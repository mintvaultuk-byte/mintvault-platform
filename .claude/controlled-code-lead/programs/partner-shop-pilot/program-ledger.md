# Programme: partner-shop-pilot (PSP)

**Role:** Programme Director / Chief Architect / Integration Controller (Lead session)
**Created:** 2026-07-29
**Objective:** One fully operational partner shop processing real grading submissions on STAGING.

## Stage 0 — Baseline (2026-07-29)

- Repo: /Users/cornelius/mintvault-platform, origin/main
- HEAD: 6b30136f9ac4507bfacf13ff8743417278d73e61 (DETACHED — no branch checked out)
- Matches owner-stated verified baseline: YES
- Dirty state: INDEX.md modified; untracked governance dirs (four-build-release, catalogue-manager, partner-user-management-hostile-review)
- Production: untouched per owner brief; partner flags OFF everywhere
- Task: READ-ONLY programme reconstruction + planning. NO implementation, NO merge, NO deploy authorised.
- Protected systems in play (planning constraints): shared/schema.ts, auth/session, middleware, Stripe/wallet, submission workflow, grading workflow (MVGS — hard protected), certificate system, Project Control.

## Stage 1 — Review plan

Four read-only reviewers, non-overlapping scopes:
- R1 (controlled-reviewer): governance-history reconstruction from .claude/controlled-code-lead partner dirs
- R2 (database-reviewer): partner data model, migrations, RLS, migration ownership
- R3 (backend-reviewer): partner server surface, flags, mounting, wallet/credit services, submission seams
- R4 (frontend-reviewer): partner portal client surface

## Status
- [x] Stage 0 baseline
- [x] Stage 2 reviewer reports (R1 governance, R2 database, R3 backend, R4 frontend — all received 2026-07-29)
- [x] Stage 3 Lead verification (spot-checked: createPartnerApp zero callers; flag write gap; dead wallet/connector code; master dashboard IS merged — its task ledger is stale; WIP branch objects confirmed)
- [x] Programme plan delivered → programme-plan.md; Opus packages → package-wp1/wp2/wp3-prompt.md

## Delivered artefacts (2026-07-29)
- programme-plan.md — full reconstruction, dependency graph, 6 gates, ownership/branch/migration maps, risk register, strategies
- package-wp1-prompt.md — Runtime Mount & Flag Control (Gate 1)
- package-wp2-prompt.md — Onboarding Completion, client-only (Gate 2)
- package-wp3-prompt.md — Connector Activation (Gate 3)

## Wave 1 dispatch (2026-07-30) — OWNER AUTHORISED
- Baseline re-verified at dispatch: origin/main == 6b30136f (fetch performed; zero new commits; no psp/* branches pre-existing).
- WP-1 (Opus, isolated worktree, branch psp/wp1-runtime-mount) — DISPATCHED, in progress
- WP-2 (Opus, isolated worktree, branch psp/wp2-onboarding-ux) — DISPATCHED, in progress
- WP-3 (Opus, isolated worktree, branch psp/wp3-connector-driver) — DISPATCHED, in progress
- Prompts issued = package-wp1/wp2/wp3-prompt.md verbatim + DISPATCH ADDENDUM (owner control rules, mandatory report format, READY FOR FABLE REVIEW / BLOCKED terminator). Prompt files updated to match dispatched text.
- Report handling: Director verifies branch/commits/diff-vs-boundary/protected files/tests-actually-ran/cross-package collisions before acceptance. No integration until all three individually accepted.

## Wave 1 report log
- 2026-07-30 WP-1: BLOCKED (correctly) — objective-2 portal gate vs existing public-routes suite fixture. Director ruling issued: one-line fixture amendment authorised; objective-4 fail-closed deviation accepted; remove dead export; re-report. Branch psp/wp1-runtime-mount @ cd39d1b5 verified in-boundary, no protected files.
- 2026-07-30 WP-1 (remediated): READY FOR FABLE REVIEW @ 1327c8e9 (amended tip). Director verification: fixture diff is exactly the authorised one-line seed addition; boundary clean; assertPartnerPortalEnv removed (zero refs); 562 non-test lines. public-routes suite 2/2 green on fresh DB. Hostile review dispatched (security lens, diff-scoped). Risks logged: live public routes now require partner_portal_enabled global row (no-op today, load-bearing at onboarding — supported write path is the new PUT /api/super-admin/partner-flags); PARTNER_MFA_ENC_KEY must accompany PARTNER_DATABASE_URL wherever set.
- 2026-07-30 WP-2: READY FOR FABLE REVIEW @ ab7f9a4c. Director verification: all 13 files within client/src+tests, no leakage, 675 non-test lines. Existing wizard-UI-suite edit ratified (defect-coupled). Hostile review dispatched (frontend lens, diff-scoped). OUT-OF-SCOPE FINDINGS LOGGED: (a) no production password-reset delivery adapter registered (server/partner/delivery.ts — reset flow cannot complete E2E; must be dispositioned before Gate 6; reset URL /partner/reset?token= must be confirmed when adapter is wired); (b) wizard `input: any` at ~583/584/820 left per scope; (c) shared node_modules missing declared devDep happy-dom → two existing render suites silently unrunnable on this machine (env hygiene, not code).

- 2026-07-30 WP-3: BLOCKED on objective 3 only; objectives 1/2/4 delivered @ bf9c018b. Director verification: boundary clean (no routes.ts/client/wallet/migrations), index.ts +22/−7 minimal hook. RULING: objective 3 SUPERSEDED by WP-1's global flag surface (partner_connector_enabled + partner_emergency_stop are in the canonical list flags.ts:21-22; WP-1's PUT /api/super-admin/partner-flags is the audited global write path — same storage.writeAuditLog approach WP-3's agent identified as the only clean no-migration option). G4-DISC-01 closed by WP-1. No re-dispatch. Hostile review dispatched (backend lens).
  DEFERRED (H): additive migration extending chk_partner_connector_admin_actions_type with set_global_flag/set_emergency_stop so G4 ledger can record global-control actions — post-pilot, owner-gated.
  FOLLOW-UP PACKAGE CANDIDATE (wave 1.5): 14 existing connector suites silently skip in CI (~250 tests incl. exactly-once/fault-injection proofs never run — env pairs unset in ci.yml); blocked partly by cluster-wide role-name collisions between suites (partner_connector_app_test created/dropped by two suites → parallel-worker flakes). Un-skip must be its own bounded package.
  RISKS LOGGED: PARTNER_ADMIN_DATABASE_URL falls back to MINTVAULT_DATABASE_URL (divergent envs would sweep the wrong DB; BYPASSRLS probe can't catch it); connector URL set without partner URL = silent quiet poll (fail-closed but invisible in logs — status endpoint does show it); N Fly machines = N pollers (safe by SKIP LOCKED/UNIQUEs, but noted); WP-1 and WP-3 both edited ci.yml same block → integration conflict expected, integration agent to resolve additively.

- 2026-07-30 WP-2 hostile review (frontend lens): FINDINGS, no Crit/High. F1 medium (session hook treats status 0/502/504 as signed-out → false "session ended") — remediation dispatched to WP-2 agent (reuse "unavailable" state, minimal diff + 1 test). F2 medium = reset-delivery adapter gap (already ledgered; server follow-up; NOTE: /partner/reset?token= is now a client contract the future email template must match; server-side timing oracle on reset request logged as H). F3 (map on .code not .message) H-logged; F4 (no recovery-code regen UI) H-logged for a later package; F5 timing oracle H-logged. Review confirmed: secret hygiene clean, no client auth decisions, contracts match server source, 17/17 tests real and passing on subject commit.

- 2026-07-30 WP-2 ACCEPTED FOR INTEGRATION. Final head f55e045c (ab7f9a4c + F1 follow-up). Director-verified: 2-file minimal diff, discriminator status 0 || >= 502 → "unavailable", 20/20 suite green, mutation-checked. Proof level: Locally verified (no live server can exercise the portal until WP-1 integrates).

- 2026-07-30 WP-1 hostile review (security lens): FINDINGS, F1 HIGH — mounting exposes otpauthUri (embeds TOTP seed) + recoveryCodes to the /api body logger; F2 Med PII logging; F3 Med kill-switch split-brain (admin vs runtime DB URL) + missing BYPASSRLS preflight on flag router; F4 Med gate tests shadowed by public router; F5-F9 low. Gate architecture confirmed sound (no fail-open, no main-app blast radius, Stripe webhook untouched, CSRF/IP-allowlist apply). REMEDIATION DISPATCHED: R1 index.ts BODY_LOG_SUPPRESSED_PREFIXES += "/api/partner" (narrow ownership amendment, one array literal); R2 capability preflight + post-commit effective re-read via resolveGlobalFlag; R3 mount-only gate tests + coherence test; R4 limiter before requireSuperAdmin; R5 registration-order invariant comment. DEFERRED: F5 (gate-path DB cost/body limit — pilot volume acceptable; cross-package cache implications), F6 (public slice coherence gate — restate claim).
- 2026-07-30 WP-3 hostile review (backend lens): FINDINGS, no Crit/High. Exactly-once/tenant-isolation/boot-safety/drain confirmed sound with constructed adversarial interleavings. REMEDIATION DISPATCHED: R1 failed-record requeue via existing retry primitives + failed/retryable_failed backlog counters; R2 runtime requires explicit PARTNER_ADMIN_DATABASE_URL (park admin_url_not_pinned); R3 runtime-local flag read distinguishing flag_store_unreachable from flag_disabled; R4 machine-unique claimant string; R5 two-driver concurrency test. DEFERRED: F5 zombie-scheduler generation counter, F6 sweep dead-letter, handoff pending→applied product question.

- 2026-07-30 WP-1 ACCEPTED FOR INTEGRATION. Final head f6b2ef22 (1327c8e9 + R1–R5 follow-up, no amend). Director-verified: index.ts confined to BODY_LOG_SUPPRESSED_PREFIXES + comment (region L285 — disjoint from WP-3's boot hunk L668). Mount suite 27/27 with MUTATION-VERIFIED gate coverage (deleting each gate fails exactly its test); TOTP-seed log exposure closed with a load-bearing test; kill-switch write now preflighted (503 on non-BYPASSRLS role, write never reaches DB) + effective read-back (409 PARTNER_FLAG_NOT_EFFECTIVE on split-brain). Ops notes: /api/partner bodies fully suppressed from request log (debug via server console.error); 409 from flag PUT means control-plane split, not retry.

- 2026-07-30 WP-3 ACCEPTED FOR INTEGRATION. Final head 33c4cbe3 (bf9c018b + R1–R5, exactly 3 declared files, boundary-verified). Cycle now sweep→process→requeue→recover; three-valued gate (open/closed-by-flag/blind→flag_store_unreachable with park budget); admin URL pinned (admin_url_not_pinned park); machine-unique claimants; 15/15 suite + 201 existing connector tests unchanged. Agent's residual "BLOCKED" = objective 3, ALREADY RULED superseded by WP-1's flag surface — block void. Residual risks logged: no dead-letter cut-off (deferred F6); parked driver needs restart to recover (visible on /worker/runtime); R2 pins URL but cannot verify intended target DB.

## ALL THREE PACKAGES ACCEPTED (2026-07-30)
WP-1 f6b2ef22 · WP-2 f55e045c · WP-3 33c4cbe3 — all boundary-verified, hostile-reviewed, remediated, accepted. Wave 1 code phase complete. Proof level: Locally verified (disposable PG17). Next: controlled integration plan for integration/partner-shop-pilot-r1 (owner pre-authorised in GO order), separate integration agent, order WP-1 → WP-3 → WP-2 to be reconfirmed against final diffs.

## Integration r1 COMPLETE + Director-verified (2026-07-30)
- integration/partner-shop-pilot-r1 @ da08d06d (merges dc34fd60 WP-1, 9488e0b1 WP-3, da08d06d WP-2; only ci.yml conflicted, union resolution; index.ts auto-merged exact-union, Director re-grepped survival).
- Gates: tsc clean; lint 0 errors (−2 warnings vs baseline); build OK (partner chunks present); full suite 0 test failures (3567 passed; 5 env-dependent module-load failures, all pre-existing class); 8/8 PG17 suites exact (175 tests).
- Seam proofs (integrated code): flag flip via WP-1's real PUT route observed by WP-3 runCycle same-process no-restart (5/5, incl. emergency stop); log suppression proven behaviourally on the BUILT server (control body logged, /api/partner bodies absent, 503 body over-the-wire but 0 occurrences in log); boot hook fires (not_configured event).
- FOLLOW-UP QUEUED (before pilot go-live): commit regression tests for both seams — the temporary proofs were not committed; WP-1's R1 test is source-text-only and passes even if the logger middleware were deleted. Also noted: printable-grade-safety is timeout-sensitive under load (not touched by this wave); full-suite module-load baseline is 5 files not ~28 (brief figure stale — correct baseline going forward).
- Proof level: Wave 1 = Integration verified (local). NOT staging, NOT production.

## Wave 1.5 dispatch (2026-07-30) — OWNER AUTHORISED
Baseline verified pre-dispatch: origin/main 6b30136f unmoved; integration r1 da08d06d; WP heads unmoved. No drift.
- P1 seam regressions (psp/wp15-seam-regressions from da08d06d) — DISPATCHED. Owns: new seam suite + request-logger extraction from index.ts. No ci.yml (reuses PARTNER_MOUNT_RT_* + self-created DB).
- P2 reset email (psp/wp15-reset-email from da08d06d) — DISPATCHED. Owns: delivery.ts default reset adapter + additive server/email.ts fn. Link contract /partner/reset?token=. No ci.yml.
- P3 connector CI (psp/wp15-connector-ci from da08d06d) — DISPATCHED. Owns ci.yml EXCLUSIVELY + 14 connector test files (role isolation) + executed-suite hard assertion.
Zero shared files by design; full parallel. Design: wave15-design.md. Post-hardening gate + PR prep per owner order; merge only on explicit owner authorisation. Gate 4 blocked.

## Wave 1.5 report log
- P2 @ 77785617 READY: production reset adapter (RESEND_API_KEY = configured, mirrors invitation fallback), additive sendPartnerResetEmail, link ${APP_URL||https://mintvaultuk.com}/partner/reset?token=, constant-error wrapper discards provider error (no token/recipient/account-existence leak), 10 tests (6 mocked-transport + 4 PG17 own-DB). Boundary verified: exactly 4 files, email.ts additive (−1 line trivial). Hostile review (security lens) SUFFERED 4 API failures; partial output captured F1 Medium = timing side channel on the request route distinguishing existing vs unknown accounts (pre-existing design tradeoff, widened by real delivery work). Review MUST be completed before P2 acceptance — re-dispatch fresh reviewer.
- P1 @ c494169a BLOCKED→RULED: seam suite (10/10 PG17, real composition, positive control + performed mutations) + behaviour-preserving request-logger extraction. Conflict: WP-1 mount suite asserts the prefix constant exists as TEXT in index.ts. RULING: authorised deleting ONLY that source-grep block (successor comment pointing at the seam suite); it would pass with the middleware deleted, so coverage strictly increases. Accepted corrections: module-load baseline is 28 in a worktree without npm ci (not 5); 503 body wording is the public router's, seam assertion correctly gate-agnostic.
- P3 @ ebe71140 BLOCKED→RULED: 12 suites wired and proven (223/223 executed, 0 skipped) + role-collision fix (service vs validation-service shared cluster-wide role names) + negative-tested execution assertion script. Corrections ACCEPTED: fileParallelism already sequential when TEST_DATABASE_URL set; LC_ALL not needed on CI locale (both brief assumptions wrong). RULING: authorised wiring the 4 migration suites with minimal precondition (audit_log + stub certificates; NOT drizzle-kit push — agent proved it wrong: real certificates lacks `secret`, needs pgvector) and NARROW amendment of 6 stale assertions (journal counts → derive dynamically, never a new magic number; rollback-chain → assert correct fail-closed behaviour). Prohibited: weakening any behaviour/isolation/exactly-once/rollback-SAFETY assertion; any of the 6 that proves a genuine defect must STOP and return unwired.

- 2026-07-30 P1 ACCEPTED FOR INTEGRATION @ 11ba88f4 (c494169a + authorised amendment). Director-verified: amendment confined to the authorised block; agent IMPROVED on the literal instruction by importing the real exported constant + rule instead of a bare comment (keeps the dependent loop/enrol assertions alive and asserting against real code) — accepted, coverage strictly higher than a comment would have left. Mount suite 27/27, seams 10/10, runtime 15/15, full suite 0 failures, module-load set identical to baseline. Mutations (i) and (ii) both proven to fail the right tests, reverted.
- 2026-07-30 P2 hostile review RE-DISPATCHED (fresh security reviewer, incremental-output instruction) after 4 consecutive API failures killed the first. P2 NOT accepted on partial evidence. Carry-over signal to confirm: request-route timing side channel (existing vs unknown account).

- 2026-07-30 P2 hostile review (2nd attempt) COMPLETE: verdict NEEDS MORE WORK. F1 HIGH ("/partner/reset page does not exist") **REJECTED BY DIRECTOR AS REVIEWER ERROR** — reviewer grepped the repo working tree (detached at 6b30136f, pre-Wave-1) instead of the branch baseline; proof: da08d06d:client/src/App.tsx:268 has `<Route path="/partner/reset">` and both page files exist. ⚠️ RECURRING TRAP: the main worktree sits at 6b30136f, so any reviewer must be told to read via `git show <branch>:<path>` / `git grep <rev>`. Add this to future review prompts.
  ACCEPTED + dispatched: F2 timing oracle (decouple send from response, fire-and-forget with non-rejecting catch); F3 limiter keyed on attacker-supplied email — SCOPE AMENDMENT granted for server/partner/rate-limit.ts, IP bucket must always apply, consume drops body keyFn (STRENGTHENS, no conflict with the no-weakening rule); F4 silent failure (import inside try + redacted signal with no token/address/account-existence); F5 use APP_BASE_URL helper if semantics identical; F7 restore all overwritten env vars.
  NO ACTION (logged): F6 token minted before delivery; unmounted duplicate reset route in routes.ts; **invitation limiter has the SAME email-keying defect (rate-limit.ts:96-101, self-documented in-repo) — separate future package, deliberately out of P2 scope.**
  CORRECTION: email.ts diff is +31/−0 (the −1 was in delivery.ts) — email.ts is strictly additive.

- 2026-07-30 P3 ACCEPTED FOR INTEGRATION @ ac468060 (ebe71140 + ruling follow-up). Director-verified: zero production files touched; journal counts now DERIVED (expectedPartnerJournalCount from listMigrationFiles + exact filename equality), not a new magic number. ALL 16 connector suites wired and executing: 268/268, 0 failed, 0 skipped. Execution-assertion re-negative-tested on the 16-entry manifest (missing env → 0 executed → exit 1). Agent discharged the STOP clause correctly: investigated all 6 assertions, found NO production/migration defect, all fail-closed; rollback refusals now assert the SAFETY property (nothing half-dropped, journal intact, planMigrations still consistent) rather than being weakened.
  OPEN ITEMS LOGGED (owner-visible, out of package): (1) rollback-partner-connector-g1.sql lacks an explicit 0014 guard — surfaces raw PG dependency error instead of the house "refuses to run" message; fail-closed either way, cosmetic. (2) The rollback chain cannot unwind below 0018 because migrations 0018/0022/0023/0024 ship NO rollback scripts — believed deliberate, needs owner confirmation as a design position.

## ALL THREE WAVE 1.5 PACKAGES ACCEPTED: P1 11ba88f4 · P3 ac468060 · P2 657ad3dd
- P2 ACCEPTED @ 657ad3dd (77785617 + R1–R5). Director-verified: 5 files, all authorised (public-routes.ts was named in the R1 instruction). Fire-and-forget is `void deliverResetToken(...).catch(() => {})` — synchronous catch, cannot reject. Limiter re-keyed: consume drops keyFn (IP), request gets an IP bucket (10/15m, own namespace to avoid starvation) PLUS an additional per-account bucket — non-vacuity proven by restoring the old keying and watching both new tests fail. Redacted failure signal RESET_DELIVERY_FAILED_SIGNAL emitted (constant text, no token/address/account hint), both dynamic imports moved inside try. 14/14 targeted green, full suite 0 failures, lint identical.
- ENV NOTE: a shared PG container on :55433 was removed mid-run by a concurrent session; P2 correctly spun up its own rather than touching another package's infra. Wave-1.5 agents should not share containers.

## Wave 1.5 integration ROUND 1 — BLOCKED (2026-07-30)
Result branch: integration/partner-shop-pilot-r1-wave15 @ af8b774b (3 clean --no-ff merges, ZERO conflicts). The canonical ref integration/partner-shop-pilot-r1 was NOT moved (checked out in another agent worktree) — it still points at da08d06d; fast-forward to the wave-1.5 result is pending re-integration after the fix.
- Gates A/B/D/E all PASS: tsc clean; lint 0 errors (2494 warnings, −2 vs baseline); build OK; full suite 0 test failures (3574 passed; module-load failing set IDENTICAL to baseline at 5 files with node_modules installed — confirms the earlier 28 was purely a missing-happy-dom worktree artefact); ZERO migrations added or modified; all 7 named verifications individually evidenced by named tests; changed-file set = 40 files, no grading/cert/admin/MVGS/schema production file touched.
- Gate C all suites at expected counts incl. 268/268 connector, 0 skipped, 10/10 seams.
- ⚠️ BLOCKER: tests/partner-connector-fault-injection.test.ts kills connections by design; vitest reports the resulting "Connection terminated unexpectedly" as an UNHANDLED ERROR → vitest exits 1 despite 21/21 (and 268/268) PASSING. CI's Test step therefore fails and Build never runs. Cause: P3's correct wiring un-skipped a suite with a latent unhandled rejection. Remediation dispatched to P3 (fix at source by owning the expected error; scoped vitest allowance only if impossible; explicit exit-code reporting required).
- Secondary logged: two suites share DBs in ci.yml vs its own one-DB-per-suite rule (seams↔mount, reset-integration↔public-routes) — P3 to verify self-provisioning and document or add DBs. Also: printable-grade-safety has a 5s timeout margin that flakes under load (pre-existing, untouched by this wave, worth watching in CI).

## P3 exit-code blocker FIXED @ 11e878b7 (2026-07-30) — Director-verified
Reproduced first (21/21 passed, exit 1), fixed AT SOURCE (option 2; no vitest allowance needed): the test now attaches an 'error' listener to the very client whose backend it terminates, so the expected event is owned by the test that causes it. Fault injection byte-identical; all 21 assertions untouched; +19 lines (listener + rationale), +8 ci.yml comment; no server/**. AFTER: fault-injection exit 0, full 16-suite connector run 268/268 exit 0, assertion script exit 0.
Secondary RESOLVED by verification not change: partner-integration-seams and partner-reset-delivery-integration each self-provision their own database (they use the shared env pair only as a SERVER coordinate) — no ci.yml DB additions needed; verified exception documented in ci.yml.
⚠️ CARRY-FORWARD (P3 flagged, outside package): `npm test` with no DB env still reports 3 errors from the SAME latent-unhandled-rejection class in other suites. Harmless today (those files fail to load anyway), but ANY future wave that wires them will hit the identical exit-code trap. Check exit codes, not just test counts, whenever un-skipping a suite.

## Wave 1.5 integration ROUND 2 DISPATCHED (fresh agent; P3 head now 11e878b7; explicit exit-code capture mandated on every test command)

## Wave 1.5 integration DISPATCHED (2026-07-30) — separate integration agent, merge order P1 → P3 → P2 into integration/partner-shop-pilot-r1, plus the owner's full post-hardening gate (A–E incl. migration topology = zero migrations, and the 7 named verifications).

## 2026-07-30 — ENVIRONMENT VERIFICATION (owner-authorised, read-only, no secret values read/printed)
Method: `flyctl secrets list` NAMES ONLY on both apps + unauthenticated HTTP probes. Apps: `mintvault` (prod) and `mintvault-v2` (staging — identified by its STAGING_ONLY secret; there is no "mintvault-staging" app).
**FINDING: ZERO PARTNER_* secrets exist on EITHER app.** No PARTNER_DATABASE_URL / PARTNER_ADMIN_DATABASE_URL / PARTNER_MFA_ENC_KEY / PARTNER_CONNECTOR_DATABASE_URL anywhere. Confirmed behaviourally: staging GET /api/partner/session → 404 (surface absent from the deployed build, not merely flag-disabled).
- **DB ISOLATION RULING: NOT PROVISIONED** — a 4th outcome outside the owner's 3-way tree. F1 (unauthenticated /api/partner DB amplification) has no live precondition: no partner pool exists to saturate and the surface fails closed without the URL. F1 CANNOT become live without a provisioning action that is itself owner-gated. Per the owner's fail-closed rule I did NOT open the PR; escalated for ruling. HARD PRECONDITION RECORDED: when provisioned, the partner DB must be a distinct Neon project/endpoint from prod MintVault.
- **APP_URL RULING: PRESENT on both apps; staging-correctness UNABLE TO VERIFY without reading the value.** Canonical-redirect probe inconclusive (staging /api/version → 200, no redirect). MANDATORY STAGING PRECONDITION: confirm APP_URL on mintvault-v2 points at the staging origin BEFORE RESEND_API_KEY can produce a partner reset email (wrong value = real partner emailed a production link). No live reset email sent; no flag enabled; no config modified.

## 2026-07-30 — WP-16 login limiter (finding F2) @ fa01d694, branch psp/wp16-login-limiter (worktree /private/tmp/psp-limiter-wt)
partnerLoginIpLimiter (namespace partner_login_ip, 15min/30, failClosed, default req.ip key) mounted BEFORE the retained per-account bucket. Director-verified boundary: 5 files, additive. TWO independent mutation proofs (each call site isolated). trust-proxy=1 semantics asserted for what the config ACTUALLY produces (rightmost XFF authoritative because Fly appends), not an unspoofable-header claim.
DIRECTOR DECISION RECORDED: authorised extending to the shadowed duplicate at server/partner/routes.ts as COMPLETING F2 (same defect, second location, one line-swap from being live), not as widening. Deletion of the duplicate deliberately NOT done — scheduled as its own package.
⚠️ NEW RISK SURFACED: the shadowed duplicate has NO emergency-stop / portal_enabled / login_enabled gates. If the registration-order invariant at server/routes.ts:2798 ever broke, login would be rate-limited but UNGATED — the kill switch would silently stop working on login. This raises the priority of the duplicate-deletion package. Under hostile-review verification.
CARRY-FORWARD: in-process MemoryRateLimitStore = per-machine buckets (real budget 30 × N machines, cleared on restart) — the shared store is what completes this control; trust-proxy=1 invariant must be re-checked if a CDN/WAF is ever placed in front of Fly; max:30 uncalibrated (no production partner traffic yet).

## WP-16 COMPLETE @ 33709fe5 (3 commits) — hostile-reviewed, Director-verified
Hostile review verdict: NO Critical, NO High. Core fix confirmed sound (binds first unconditionally both sites, fail-closed, unspoofable under trust-proxy=1, no namespace collision, 429 leaks nothing, handler bodies byte-identical, both mutation proofs honest).
⚠️ **DIRECTOR ERROR CORRECTED (recorded for accountability):** I relayed to the owner the implementer's claim that the shadowed duplicate route has NO emergency-stop/portal_enabled gates. FALSE — mount.ts:143-149 composes partnerApiRouter behind all four gates; only the per-route partner_login_enabled check is missing. I passed on an agent claim without verifying it. LESSON: verify agent security claims before relaying them to the owner, exactly as I verify their code.
Remediations landed: R1 IPv6 /56 normalisation at the shared key construction (the original suite was structurally blind — every simulated IP was IPv4; identity-mutation proves total bypass without it; /56 chosen over /64 with the /48 residual stated), R2 req.ip ?? socket ?? "unknown" (+ IPv4-mapped forms fold in both spellings), R3 both false comments corrected, R4 fail-closed CI guard + 3 key-derivation tests placed OUTSIDE the DB gate so they can never be skipped. Suite 11 tests; 4 independent mutation proofs across the package.
OWNER DECISIONS PENDING (logged, not implemented): S2 per-machine memory store (real budget 30 × N machines, cleared on restart — shared store completes the control; docblock now states this accurately); S3 shared-NAT partners share 30 attempts and successful logins consume budget (skip-on-success would fix without weakening anti-spray).
NEXT PACKAGE (pairs naturally): `acct` helper still keys on raw req.ip (rate-limit.ts:161 — not a bypass since the normalised IP bucket binds first, but weaker than it looks for IPv6) + delete/collapse the shadowed duplicate route.

## Final integration + owner's full re-verification DISPATCHED (separate agent, branch integration/partner-shop-pilot-r1-final from b6b4019e, merging psp/wp16-login-limiter; exit codes mandated on every command; includes the login-limiter mutation verification and both topology assertions).

## FINAL STATE (2026-07-30) — integration/partner-shop-pilot-r1-final @ 1eb252e2
Merge of WP-16 into b6b4019e: ZERO conflicts. Director-verified independently: 43 files, migrations 0, shared/ 0, protected production files (grader/mvgs/labels/certificate-document/storage/stripe) 0. origin/main still 6b30136f.
Owner's final re-verification ALL GREEN with explicit exit codes: check 0 / lint 0 errors (2494 warnings, −2 vs baseline) / build 0; 11 partner+seam suites all exit 0 at expected counts (mount 27, onboarding 20, reset 6+6, login-limiter 11, seams 10, runtime 38, public 2, capability 5, user-mgmt 1, final-owner 2); all 16 connector suites 268 executed / 0 skipped / all exit 0 + assertion script exit 0; login-limiter mutation PROVEN to discriminate at HTTP-route level (3 tests fail under identity mutation, tree clean after restore).
Gate B exit 1 decomposes entirely to the 5 documented env-gated module loads + the known printable-grade-safety 5s timeout flake (passes in isolation 46/48; PROTECTED file, not modified).
TWO HOSTILE REVIEWS: NO Critical, NO High.
Noted for owner: partner-user-management-migration executes only 1 test and partner-public-routes-integration only 2 — genuine counts (0 skipped), but thin relative to the surface they cover; candidate for a coverage package.
Watch-on-first-deploy: server/index.ts now starts the connector runtime on boot and drains on shutdown (fire-and-forget, no-ops without PARTNER_CONNECTOR_DATABASE_URL) — the single place this work touches the main app lifecycle.

## PR #271 OPEN, ALL CHECKS GREEN, HOLDING (2026-07-30)
Pushed integration/partner-shop-pilot-r1-final @ 1eb252e2 under owner authorisation (origin/main re-verified 6b30136f immediately before). PR #271 → main. mergeable=MERGEABLE, mergeState=CLEAN, head 1eb252e2.
CI: Lint/TypeCheck/Test/Build PASS (8m15s, includes all 268 connector tests) · CodeQL SAST PASS · CodeQL alert gate PASS (after dismissal) · gitleaks PASS · dependency review PASS. 5/5 green.
CODEQL DISMISSALS (owner Option A, evidence-checked first): #175 js/missing-rate-limiting @ server/partner/routes.ts:134 and #174 @ server/partner/public-routes.ts:67 — both dismissed as "false positive" with evidence notes; both routes verified at 1eb252e2 to carry `partnerLoginIpLimiter, partnerLoginLimiter`. Precedent matched: #173 dismissed identically 2026-07-18. NOTE: GitHub caps dismissal comments at 280 chars.
**#5 js/missing-token-validation @ server/index.ts:236 was NOT dismissed — correctly.** The owner's condition was "only if the gate is treating the line-shifted existing alert as new". It is NOT: #5 was created 2026-06-25, is the same alert number already open on main, and the gate counted only 2 new alerts (#174/#175). Dismissing it would have closed a genuine pre-existing finding under a ruling that did not cover it. It remains open on main exactly as before.
CodeQL analysed ref refs/pull/271/merge @ synthetic merge commit 5c988117 (GitHub's PR merge preview of 1eb252e2 + main) — normal, not drift.

## Next authorised action
Receive and verify WP reports. Then (already owner-authorised in the GO order): produce controlled integration plan for integration/partner-shop-pilot-r1, order WP-1 → WP-3 → WP-2 (reconfirm against actual diffs), integration performed by a SEPARATE integration agent under Director prompt.
Explicitly NOT authorised: merge to main, deploy, flag enabling anywhere, Gate 4 (migrations 0033/0034, wallet HTTP writes, ledger changes, Stripe top-up, submissions-flow modification), prod anything.

## Corrections to prior records found during reconstruction
- tasks/partner-master-dashboard/task-ledger.md says "local only, unmerged" — STALE: dashboard is merged & mounted (server/routes.ts:2802) at 6b30136f.
- INDEX.md indexed zero partner tasks/programs — corrected this session (PSP row added).
- G6A–C wallet work has no governance task dir; 0016/0017 prod application has no approval record — noted as accepted historical gaps.
- Branch codex/partner-auth-invitations-rbac migration 0020 is DEAD (shape-conflicts with merged 0031); 0021 is salvage-by-rewrite only.

## ✅ MERGED TO MAIN (2026-07-30 09:54:46Z) — owner-authorised
PR #271 MERGED. Merge method: merge commit (repo's established method, cf PR #270); NOT squashed — full package history preserved for audit.
- Merge commit / new origin/main: **7630bf19ff4574e8e75dd73a6aff9a46e9f4e48d**
- Previous main: 6b30136f (re-verified unmoved immediately before merge; mergeState CLEAN, 5/5 checks green, head exactly 1eb252e2 as authorised)
- 24 commits added. All 14 package commits verified present as ancestors of main (WP-1 1327c8e9/f6b2ef22, WP-2 ab7f9a4c/f55e045c, WP-3 bf9c018b/33c4cbe3, P1 11ba88f4, P3 ac468060/11e878b7, P2 77785617/657ad3dd, WP-16 4c6e8a71/fa01d694/33709fe5).
- Post-merge topology re-verified on main: 43 files, migrations 0, shared/ 0, protected production files 0. 26 numbered migrations on disk = unchanged.
- CodeQL post-merge: #174/#175 dismissed (false positive, evidenced); #5 open and untouched at its original line 235.
- ENVIRONMENTS UNTOUCHED: prod /api/version = commit 6f182624 (unchanged); staging = 6b30136f (unchanged). No deploy, no provisioning, no flags, no env mutation.

## PROGRAMME STATE AFTER MERGE
Gates 1–3 of PARTNER SHOP PILOT COMPLETION are now ON MAIN but DORMANT: no partner DB provisioned anywhere, all partner flags OFF, portal fails closed (503/404). Proof level = Merged to main; NOT staging-verified, NOT production-deployed.
NEXT: staging-readiness PLAN ONLY (owner order) — prepare, do not execute. Gate 4 remains fully blocked.

## Staging-readiness plan PREPARED (2026-07-30) — NOT EXECUTED
File: STAGING-READINESS-PLAN.md (16 sections, Phases 1-12 per owner order).
Phase 1 verified read-only at prep time: main 7630bf19 · staging mintvault-v2 @ 6b30136f (pre-Wave-1; partner surface ABSENT, /api/partner/session 404) · prod mintvault @ 6f182624 · ZERO PARTNER_* secrets on either app · APP_URL + RESEND_API_KEY + RESEND_DOMAIN_VERIFIED present on both (values NOT read) · staging = 1 running machine (lhr), min_machines_running=1, auto_stop=off · no partner DB objects anywhere · 9 canonical flags confirmed from source.
Key plan positions: distinct Neon PROJECT preferred (a same-project branch may share an endpoint and cannot demonstrate separation); migrator must use the DIRECT non-pooler endpoint (recorded pooler-leak incident); runner must NOT apply core migrations to the partner DB (STOP condition); APP_URL proof gates ALL email (simplest safe method = temporarily unset RESEND_API_KEY, prove the captured URL, then restore); flag ladder stops at partner_connector_enabled; partner_grading_enabled + partner_payments_enabled NEVER enabled pre-Gate-4, with an explicit containment assertion (destination submission draft/unpaid, zero ledger rows).
NOTE for the executing session: the single-machine fact makes the per-machine rate-limit store effectively global TODAY — that assumption breaks the moment staging scales.
6 owner decisions raised; recommended first action = confirm staging APP_URL (only item both blocking and cheap, and the one misconfiguration that could reach a real person).

## 2026-07-30 — FIRST STAGING PILOT ATTEMPT: SAFE STOP (no objects created)
Owner brief: verify staging partner flags, then create 1 fictional org + 1 ACTIVE Main location +
1 OWNER identity + 1 invitation, and send exactly one staging invitation email to mintvaultuk@gmail.com.

**RESULT: SAFE STOP at the owner's own precondition. ZERO writes issued anywhere.**

### Baseline reconciliation (drift found and resolved)
- Local worktree still detached at 7630bf19. `git fetch` shows **origin/main has advanced to 352274aa**
  ("merge: land partner pilot flag controls"), +9 commits, 17 files — landed by a concurrent session.
- STAGING mintvault-v2 is deployed at **352274aa** — exactly origin/main. No staging/main drift.
- Ledger entries above (staging @ 6b30136f, partner surface absent, ZERO PARTNER_* secrets) are now STALE.
  Staging now HAS: PARTNER_DATABASE_URL, PARTNER_ADMIN_DATABASE_URL, PARTNER_CONNECTOR_DATABASE_URL,
  PARTNER_MFA_ENC_KEY, PARTNER_DB_POOL_MAX, PARTNER_CONNECTOR_WORKERS (names only; no values read).
  The partner DB has therefore been provisioned and the surface deployed since the last entry.
- New on origin/main: `createPartner` is now ONE transaction creating org + profile +
  a default `'Main location'`/`'ACTIVE'` row (partner-management-service.ts:301-352). The
  "no canonical location-create API" gap recorded earlier is CLOSED.

### Flag verification (unauthenticated, read-only, zero side effects)
Method: `resolveGlobalFlag` is uncached (live DB read per request, flags.ts) and the flag gates run
BEFORE body validation, so an empty-body POST discriminates flag state with no auth attempt and no write.
| Flag | Evidence | Verdict |
|---|---|---|
| partner_portal_enabled | GET /api/partner/session → **401** (passed all 4 mount gates incl. requirePortalEnabled) | **TRUE** |
| partner_emergency_stop | same 401 (gate 3 passed) | FALSE (correct) |
| partner_login_enabled | POST /api/partner/auth/login {} → **503 "partner login unavailable"** (route-specific body, not the generic gate body) | **FALSE** |
| partner_onboarding_enabled | POST /api/partner/invitations/accept {} → **503 "partner onboarding unavailable"** | **FALSE** |
| connector / grading / payments | NOT VERIFIABLE unauthenticated | unverified |
Not a DB outage: portal resolved TRUE through the same runtime pool and same function, so the two
FALSE results are genuine flag state, not `resolveGlobalFlag`'s fail-closed catch.

### Owner precondition triggered
Brief: "If onboarding or login is still disabled, safe-stop without creating anything." BOTH are disabled.
No organisation, location, identity, invitation or email was created or attempted.

### Second, independent blocker (would have stopped this even with flags ON)
Every canonical Super Admin partner API is behind `requireAdmin`/`requireSuperAdmin`. Creating the pilot
requires authenticating to staging with ADMIN_PASSWORD + ADMIN_PIN. **The Lead does not handle owner
credentials** — this is a standing safety boundary, not a governance gate the owner can waive by prompt.
Consequence: the creation steps must be performed by the owner in the Super Admin panel, or by a path
that does not route the owner's password through the assistant.

### Production
mintvaultuk.com /api/version = **6f182624** — unchanged. /api/partner/session = 404 (surface absent).
Production untouched.

### Next authorised action
None until the owner (a) enables partner_onboarding_enabled + partner_login_enabled via
PUT /api/super-admin/partner-flags/:flag in the panel, and (b) rules on who performs the authenticated
creation calls. Gate 4 (connector/grading/payments/credits) remains fully blocked.

## 2026-07-30 — PARTNER MANAGEMENT & ONBOARDING UX v1 (owner-authorised implementation)
Branch `psp/partner-management-ux-v1` @ **4d1a7d49**, worktree /private/tmp/psp-pmux-wt, from origin/main 352274aa.
**ZERO migrations. Local commit only — not pushed, not merged, not deployed.**

### Key finding that shaped the whole task
`partner_profiles` ALREADY has address_line1/2, city, postcode, country, primary_phone, website,
primary_email, health_note, and `extractProfileFields` already accepted them. The pilot's "address
cannot be entered" pain was **purely a client gap** — the UI sent only `trading_name` via a
`window.prompt`. So items 1 and 7 needed no schema work at all.
Also: `partner_organisations.status` has **no CHECK constraint** (plain text), so a new status value
would be app-level only — relevant to the deferred DRAFT item.

### Delivered (6 files changed, +1 test file, 1668 insertions)
Server: `updatePartnerLegalName` (audited `profile_updated`, shared profile-version lock);
`findDuplicates` + read-only `GET /partners/duplicate-check` (registered BEFORE `/partners/:partnerId`
— ordering now pinned by a test); `amendPendingInvitation` + `PATCH .../users/:userId/invitation`
(revoke-and-reissue, never edit-recipient-in-place); new error code INVITATION_NOT_AMENDABLE → 409.
Client: full company-details form replacing window.prompt; invitation editing; duplicate scan →
confirmation summary → create; checklist percentage with Device/Credits as `unavailable` and excluded
from the total; contacts/branding prompts → accessible in-modal fields; shared server-error mapper.

### Verification (all exit codes captured)
tsc clean · eslint **0 errors** (2493 warnings, −1 vs baseline 2494) · build OK ·
full suite **3672 passed** vs clean-baseline-worktree **3593** = exactly **+80**, zero regressions
(baseline re-measured at 352274aa in a disposable worktree, not taken from this ledger).
Failing-file set identical to baseline: 5 env-gated module loads + the known load-sensitive
`printable-grade-safety` 5s flake (PROTECTED file, untouched, passes in isolation 46/48).
**3 mutation proofs**: email-duplicate-blocking → 4 tests fail; checklist-percentage denominator →
2 fail; route reordering → 2 fail. Tree restored green (82/82) after each.

### ENV NOTE (resolved a long-standing gap)
`happy-dom` is a DECLARED devDependency that was never installed in the shared node_modules — the
issue logged as WP-2 finding (c). Installed with `--no-save --no-package-lock`; package.json and
package-lock.json verified byte-unchanged. This matters: `partner-pilot-flag-controls-ui.test.ts`
RENDERS the real list page component, so without it the only test that actually exercises the
modified component could not run. It now passes (109/109 across the 4 partner UI suites).

### DEFERRED — require a migration, NOT written (owner instruction honoured)
1. **DRAFT status** (brief item 6): app-level for the status column itself, BUT the audit CHECK
   constraint has no draft action and the status lifecycle/FSM would need extending. Bundled with (3).
2. **TEST PARTNER / STAGING ONLY flag** (item 10): needs a new column on partner_organisations or
   partner_profiles. No column exists and none should be faked into `internal_tier`.
3. **Precise audit actions**: `chk_partner_management_audit_action` (0015, re-issued 0031) is a fixed
   list. Rename is recorded as `profile_updated` and invitation-amend as `partner_user_invited` —
   accurate but coarse. `legal_name_changed` / `partner_invitation_amended` / `duplicate_override`
   need one additive ALTER … DROP/ADD CONSTRAINT.
Also deferred (no migration, just unbuilt): invitation Expire/Regenerate as distinct verbs, activity
timeline enrichment beyond the existing endpoint, keyboard focus-trap in modals.

### Next authorised action
Owner review of the branch. NOT authorised: push, merge, deploy, migration, flag change.

## 2026-07-30 — OPUS-LED MULTI-AGENT HOSTILE REVIEW of psp/partner-management-ux-v1
Reviewed head 4d1a7d49 → repaired head **7195f17f**. Base origin/main 352274aa (re-verified unmoved).
6 read-only specialists (backend, security, frontend, tests, schema, product), non-overlapping scopes.
Controller independently reproduced every blocking claim; DB-backed runtime proofs run by the
controller only (dedicated PG17 container on :5571 — other sessions' containers deliberately untouched).

### Controller-reproduced blocker-class findings
- **Checklist branding bug (mine).** `hasBranding: !!detail.data?.branding` — getPartnerDetail returns
  {organisation, profile, primaryContact} and NEVER branding. Bar capped at 83% forever, i.e. exactly
  the defect the helper's own doc comment claims to fix. FIXED + pinned in unit and runtime tests.
- **Two test mutations survived 82/82** (reproduced by hand, not taken on trust): (q) profile PATCH
  route bypassing `extractProfileFields` → mass assignment; (o) dropping `as const` + a field from
  PROFILE_FIELDS → contract test goes vacuous because `indexOf("] as const")` = -1 makes slice(0,-1)
  swallow the file. Both closed.
- **Delivery lie.** Server returns DELIVERY_NOT_CONFIGURED / DELIVERY_FAILED with HTTP 200; client
  discarded it and always said "re-sent". Converged finding from backend + product agents. FIXED.
- **Failed duplicate check rendered as "No similar partner found."** FIXED (in-modal alert).
- **Validation lockout.** Stricter-than-legacy validators blocked on UNTOUCHED stored values, so a
  website stored as "acme.co.uk" prevented ALL saves. FIXED (only changed fields block).

### Also fixed
Partial-save state incoherence (retry blamed a third party for our own half-write); Escape not closing
the new dialogs; partners list never invalidated under staleTime:Infinity; address/notes editable but
never displayed; limiter keyed on hand-parsed X-Forwarded-For (repo ruled against this same
anti-pattern earlier today, 4c6e8a71/33709fe5); partner-management response bodies (email/phone/
postcode/VAT) not suppressed from the request log; amend left NO audit row when rejected; post-commit
delivery failure turned a committed amend into a 500; false docblock about before_state.

### Verification
- **23 runtime proofs** on real PG17 with the realistic non-superuser role model — all 14 the owner
  required, plus repair proofs. These caught a bug source-level tests could not: a blanket ORDER BY
  referencing an alias one query lacked.
- Clean full-suite comparison (shared-DB var removed from BOTH runs to eliminate a PRE-EXISTING
  parallel collision — baseline showed 12 failures with it, branch 1): **baseline 3593 passed / 0
  failed → branch 3693 passed / 0 failed = +100, zero regressions.**
- tsc 0 · eslint 0 errors (2493 warnings, −1 vs baseline) · build 0 · prettier clean on all new files
  (pre-existing files were already unformatted at base — deliberately not reformatted) ·
  git diff --check clean · gitleaks 0 on the commit range and changed scope.
- 4 repair mutations verified to fail the right tests; tree restored green each time.

### SCOPE EXPANSION (declared)
`server/lib/request-logger.ts` was NOT in the original 7-file set. One-list addition suppressing
partner-management response bodies, fixing a confirmed PII-logging finding on the new endpoint.
`tests/partner-management-admin-ui.test.ts` — ONE assertion relaxed from a literal `e.key === "Escape"`
to a shape, because the handler was refactored to an early return; behaviour preserved and extended.

### DEFERRED — owner decisions, NOT implemented
1. **address_county column** — the pilot address (Test Suite 1 / MintVault Pilot Centre / Strood /
   Rochester / Kent / ME2 2AA) has six lines and the schema has five fields. No county column exists
   anywhere. Faithful capture needs a MIGRATION → owner-gated, deliberately not written.
2. **requireAdmin → requireSuperAdmin** on this router (both sibling super-admin routers use the
   stricter tier). Behaviour-identical today (single admin account) but it is auth code → owner-gated.
3. Draft mode + TEST PARTNER flag — already deferred, migration-bound.
4. organisation_kind / onboarding_date / internal_tier displayed but unsettable (pre-existing).
5. Delete-a-partner, multi-location, invitation expiry/delivered-at display, focus trap in dialogs.
6. Phone duplicate probe: "+44…" vs "0…" forms don't match (advisory-only false negative; pinned).

### HARD DEPLOY PRECONDITION (schema agent F1, controller-accepted)
"Zero migrations" is true RELATIVE TO A DATABASE ALREADY AT 0032. `partner_user_invited` is permitted
by 0031's CHECK but NOT by 0015's; partner_invitations / partner_users.first_name,last_name /
uq_partner_invitations_one_live_per_user arrive in 0031/0032. **Before any deploy, confirm on the
specific target host** that chk_partner_management_audit_action is the 18-value version and those
objects exist. There is no repo evidence 0031/0032 are applied to either Neon host.

### Next authorised action
Owner review. NOT authorised: push, merge, deploy, migration, flag change, staging/prod writes.

## ✅ 2026-07-31 — LANDED TO MAIN: Partner Management & Onboarding UX v1
Merge commit / new **origin/main = `add695f25c8d480877d8d4cbbd8581f9a7c1b357`** (previous main 352274aa).
Method: `git merge --no-ff` in a FRESH isolated landing worktree from verified origin/main. No squash,
no rebase, no amend, no cherry-pick. ZERO conflicts.
- Parents: 352274aa (base) + 7195f17f (reviewed repaired head).
- Ancestry preserved: 4d1a7d49 (implementation) AND 7195f17f (hostile-review repairs) both present.
- **Merge tree a754c37a === reviewed branch tree a754c37a** — byte-identical, so nothing entered
  through the merge. `git diff 7195f17f..merge` empty.
- Exactly 10 files vs base; 0 migrations, 0 lockfile/manifest, 0 env/Fly/CI, 0 grading/cert/payment/
  Stripe/label, 0 shared/.

### Landing evidence (all exit codes captured)
- Focused partner suites, SERIAL, one disposable DB each: **223 passed / 0 failed / 0 skipped**
  (ux 99, ux-runtime 23, admin-ui 18, pilot-flags 7, test-hooks 4, integration 26,
  onboarding-matrix 18, portal-mount 28).
  ⚠️ METHOD NOTE: passing env via `env $VAR ...` word-splitting silently caused onboarding-matrix and
  portal-mount to SKIP (1 passed/17 skipped and 1/27). Re-run with proper exports → full 18 and 28.
  Skips were NOT counted as passes; this is exactly why the owner's "do not count skipped" rule matters.
- Invitation/auth suites: 81 passed / 0 failed / 2 skipped.
- Full suite on the merge commit: **3693 passed / 0 failed / 803 skipped**; 5 failed FILES = the
  documented env-gated module loads (auth-security-migration, rarity-structured-migration, vq-backend,
  vq-fetch-art-stored-pointer, vq-higgsfield-observability). Identical class to baseline (3593/0).
- tsc 0 · build 0 · eslint 0 errors (2493 warnings) · changed-file eslint 0 errors (8 warnings) ·
  git diff --check clean · gitleaks 0 on 352274aa..merge AND 0 in the changed scope.
- Prettier: 4 pre-existing files still unformatted — PROVEN unformatted AT BASE 352274aa by extracting
  the base blobs and checking them. All 6 files this branch created/rewrote are Prettier-clean.

### 🔴 DEPLOYMENT PRECONDITION (recorded, NOT satisfied by this landing)
The target partner DB must ALREADY carry 0031 + 0032. Verified from migration history:
`partner_user_invited` appears 0 times in 0015 and IS in 0031's 18-value
chk_partner_management_audit_action; partner_invitations + partner_users.first_name/last_name created
in 0031; uq_partner_invitations_one_live_per_user + final-owner trigger in 0032.
**Invitation amendment 400s/500s until 0031+0032 are applied.** No repo evidence they are applied to
either Neon host. NO MIGRATION WAS RUN DURING LANDING.

### Confirmed NOT done
No deploy (staging /api/version still reports commit 352274aa — the pre-landing build), no migration,
no flag change, no partner data created/edited/revoked, no invitation or email sent, live pilot
untouched, production untouched.

### Next authorised action
STAGING-ONLY deployment + live verification. NOT production.

## ✅ 2026-07-31 — STAGING DEPLOYED: add695f2 (Partner Management UX v1)

### Phase 1 — migration precondition: **PASSED** (live DB, not inferred from files)
Read-only inspection inside the staging machine (`flyctl ssh console` + pg, schema facts only, no
secret values printed). ⚠️ LEDGER CORRECTION: the 2026-07-30 entry "ZERO PARTNER_* secrets on either
app" is now **STALE** — staging DOES have PARTNER_DATABASE_URL, PARTNER_ADMIN_DATABASE_URL,
PARTNER_CONNECTOR_DATABASE_URL, PARTNER_MFA_ENC_KEY, PARTNER_DB_POOL_MAX, PARTNER_CONNECTOR_WORKERS.
Partner DB = Neon `neondb`, PostgreSQL **17.10**.
- Journal: 26 entries INCLUDING **0031_partner_user_management.sql** and **0032_partner_final_owner_invariant.sql**.
- `partner_invitations` present; `partner_users.first_name` + `last_name` present.
- `uq_partner_invitations_one_live_per_user` present, correct partial predicate (PENDING/SENT/DELIVERY_FAILED).
- `chk_partner_management_audit_action` = the **18-value** version, includes `partner_user_invited`.
- Final-owner invariant: 3 triggers + `partner_owner_invariant_tenants` table.
→ The deployment precondition recorded at landing is SATISFIED on staging.

### Phase 2 — deployment
`scripts/safe-deploy.sh staging` from a clean worktree at add695f2. GUARD 1 passed (not behind
origin/main); GUARD 2 verified the LIVE server. **staging = v443, /api/version commit `add695f2`**,
/health 200, /ready ready, 1 machine (lhr) 1/1 checks passing. Rollback image recorded:
registry.fly.io/mintvault-v2:deployment-01KYTBF9N0PZFV6VQDJKBXS3M5 (v442 = commit 352274aa).
No migration executed. No env changed. **PRODUCTION UNTOUCHED — mintvaultuk.com still 6f182624, last
prod release v1065 (Jul 28).**

### Phase 3 — flags: already correct, NOTHING CHANGED
Exactly 3 global rows, all TRUE: partner_portal_enabled, partner_onboarding_enabled,
partner_login_enabled. connector/grading/payments have **NO ROW AT ALL** → resolve false, fail-closed.
Behaviourally re-verified on the new build: /api/partner/session 401, login 400, accept 400 (all past
the flag gate, failing only on empty bodies).

### Phase 4 — existing staging partner data (read-only)
TWO organisations, both PENDING, each with exactly one ACTIVE "Main location":
- `7b60e9e9-e822-495f-a97e-6bed8eb80709` "sophie pokemon" (20:53:34) — stray earlier test record
- `5a277964-254d-45a1-a657-0c7449dc3b25` "MintVault Pilot Partner One Ltd" (21:01:53) — the pilot
**ZERO partner_users, ZERO partner_invitations, ZERO credit-ledger rows.** Both profile rows exist but
trading_name/address/all fields are NULL. So the owner created the orgs on 2026-07-30 but never
completed the trading name, address or the owner invitation.

### 🔴 PHASES 5 & 6 NOT EXECUTED — cannot be done without the owner's admin session
Every canonical Super Admin write is `requireAdmin`-gated; verified live on the new build:
POST /partners → 401, POST /partners/:id/users → 401, PATCH /partners/:id/profile → 401.
The owner's standing instruction is that I never handle their admin password, PIN, cookies or session
tokens, and direct DB writes are prohibited by this authorisation. Both permitted paths are therefore
closed to me. Handed to the owner as an exact UI click sequence. NO invitation was sent.

### Phase 7 — owner journey (verified from the deployed code)
/partner/invite?token= → set password (min 10 chars, confirm) → "sign in and set up an authenticator
app" → /partner/login?setup=1 → MFA enrol (mandatory; recovery codes) → /partner/dashboard.
Nav (partner-shell.tsx): Dashboard, Submissions, Users, Locations, Billing, Help, Security & Account —
each permission-gated. Billing and Locations are honest "coming soon" pages, not dead links.
Tenant isolation = ENABLE+FORCE RLS keyed on partner_current_tenant() on every tenant table.

### Next authorised action
Owner completes trading name, address and the owner invitation via the Super Admin UI, then accepts
the invitation personally. NOT authorised: production deploy, migrations, flag changes, credits,
connector/grading/payments.

## 2026-07-31 — PARTNER USER MANAGEMENT & ADMIN UX V2 — PHASE 1 INVESTIGATION COMPLETE
Branch `psp/partner-user-management-v2` created from origin/main add695f2 (worktree /private/tmp/psp-pum2).
**NO CODE WRITTEN. Stopped at the owner's mandated migration-boundary gate.**

### Already EXISTS server-side but NOT exposed in the UI (no migration, no new endpoint)
`listPartnerUsers` ALREADY returns first_name, last_name, email, status, last_login_at, created_at,
role, invitation_status, **invitation_expires_at**, **invitation_delivered_at**. The Users table renders
only a subset. Columns `mfa_enabled` + `mfa_required` exist on partner_users but are NOT in the SELECT
(one-line addition).
Existing routes already cover: invite, amend invitation, resend, revoke, change role, set status
(suspend/reactivate/remove), revoke sessions, contacts add/update/deactivate, branding upsert.

### Buildable with NO migration (new route composing EXISTING primitives)
- **Admin-initiated password reset**: `createPasswordResetToken(tenantId,userId)` (server/partner/auth.ts:155)
  + `deliverResetToken(email,token)` (delivery.ts:54) already exist, and the audit action
  **`partner_user_password_reset_initiated` is ALREADY in the 18-value CHECK but has ZERO implementation**
  (only referenced at partner-management-service.ts:142 in the union). Pure composition.
  ⚠️ server/partner/auth.ts is PROTECTED auth code — CALL its exports, do not edit it.
- **MFA reset / force re-enrolment**: partner_mfa_methods.status ('PENDING|ACTIVE|DISABLED'),
  partner_recovery_codes, partner_users.mfa_enabled + **mfa_required** all exist. Mechanism needs no schema.
- Contacts: `is_primary` + `active` columns exist → view/edit/mark-primary/archive all supported.
- Branding: display_name, primary/secondary/accent_colour, support_email, support_website all exist →
  colour picker + support email are pure UI over existing columns.
- Status-change safety, connector disabled-state, display formatting, profile-completion explanation:
  all client-only.

### 🔴 MIGRATION BOUNDARY — the exact items that CANNOT be done honestly without a migration
1. **A precise audit action for MFA reset.** `chk_partner_management_audit_action` has 18 values and
   NONE covers it. Reusing `partner_user_sessions_revoked` or `..._password_reset_initiated` would
   mislabel a security-relevant action — the exact dishonesty pattern the last review penalised.
   NOTE: `partner_audit_events.action` IS unconstrained text, so a precise record is possible THERE;
   the constrained admin ledger is the problem. Owner decision required.
2. **Force-password-change-on-next-login.** No such column exists on partner_users
   (columns are: password_hash, status, credential_version, mfa_enabled, mfa_required,
   failed_login_count, locked_until, last_login_at, first_name, last_name). `credential_version` bumps
   invalidate sessions but do NOT force a password change. Migration-bound.
3. **Secure logo upload.** `logo_r2_key` is explicitly "reference only; no upload integration in G5".
   No presigned partner-scoped upload path exists. Deferred per the owner's own instruction.
4. **address_county** (carried forward from the previous pass).

### PROFILE-COMPLETION ANSWER (item 6) — root cause found, NO contract change needed
`profileHasDetail` requires: `trading_name` AND (`primary_email` OR `primary_phone`) AND `address_postcode`.
Entering trading name + address is NOT enough — **a contact email or telephone is also required**, and
neither was entered. The fix is to SHOW which fields are missing, not to relax the rule.

### Next authorised action
Owner ruling on the 4 migration-boundary items, then a separate authorised build pass for the
no-migration scope. Nothing has been implemented, committed, merged or deployed.

## 2026-07-31 — FIRST-OWNER INVITATION BLOCKER FIXED + MIGRATION 0033
Branch `psp/partner-user-management-v2` @ **2793c797** (from origin/main add695f2). Local only.

### 🔴 ROOT CAUSE — "Partner role is not configured." (PARTNER_ROLE_NOT_CONFIGURED)
`seedPartnerRbac()` (server/partner/permissions.ts) was called from **13 TEST files and ZERO
production code paths**. Migration 0001 CREATEs partner_roles/partner_permissions/
partner_role_permissions but never POPULATES them. Every partner suite seeded RBAC in its own
beforeAll — which is exactly why 3600+ tests passed while the deployed product could NEVER issue its
first invitation. Verified read-only on staging: **partner_roles=0, partner_permissions=0,
partner_role_permissions=0**.
CLASSIFICATION: **code** (missing call site) surfacing as missing data. NOT migration, NOT seed-script,
NOT staging-specific — every environment fails identically. No canonical Super Admin route exists to
seed roles, so it could not be fixed by configuration.

### FIX
`bootstrapPartnerRbac()` invoked at boot in server/index.ts beside startConnectorRuntime. Idempotent
(ON CONFLICT DO NOTHING), fail-soft, no-ops without PARTNER_ADMIN_DATABASE_URL. Seeded from the
TypeScript constants so roles cannot drift between code and SQL.

### MIGRATION 0033 (the ONE owner-approved additive migration)
+4 values: partner_user_mfa_reset, partner_invitation_amended, partner_legal_name_changed,
partner_duplicate_override. 18 originals preserved verbatim. rollback-0033 exists and REFUSES to run
if any row already uses a new value. Rename + amend now use precise actions instead of borrowed ones.
⚠️ partner_duplicate_override is PERMITTED but NOT YET WIRED (create-flow still carries the override
in the audited reason string) — deliberate, reported honestly.

### NEW SERVICES (composition only — no new auth logic; server/partner/auth.ts NOT edited)
sendPartnerUserPasswordReset (existing createPasswordResetToken + deliverResetToken; no temp
password, token never returned, honest delivery status) · resetPartnerUserMfa (disables methods,
burns recovery codes, mfa_required=true, credential_version bump, session revoke; no secret read).
Users list now returns mfa_enabled/mfa_required.

### EVIDENCE
tests/partner-rbac-bootstrap.test.ts — 10 proofs on real PG17, deliberately NOT seeding RBAC in
beforeAll. Reproduces the blocker, proves the fix, idempotency, token hashing, delivery honesty,
duplicate blocking, and all 3 required migration properties. Rollback proven BOTH ways (succeeds
clean, refuses with evidence rows).
Full suite **3696 passed / 0 failed** vs baseline 3693/0. +9 skipped = DB-gated proofs, not counted.
tsc 0 · eslint 0 errors · build 0 · diff --check clean · gitleaks 0 on range and changed scope.
Two tripwires fired correctly and were updated in-pattern (migration-inventory pin; G6B rollback
later-migration guard). Two audit-contract tests rewritten to read the NEWEST constraint-defining
migration instead of hardcoded 0031 — the staleness the previous review predicted.

### ⚠️ NOT DONE — the larger User Management V2 UI build
Backend + migration + blocker are complete. The UI work (richer Users table rendering, contact
management, branding UI, connector disabled-state, display formatting, profile-completion
explanation, status-change safety modals) is NOT implemented. Owner said the blocker was priority;
reporting the remainder honestly rather than half-shipping it.

### DEPLOY NOTE
0033 must be applied to staging BEFORE deploying this branch, else amend/rename 500 on the CHECK.
Next: hostile review, then owner-authorised staging migration + deploy.

## 2026-07-31 — HOSTILE REVIEW of the RBAC blocker fix → repaired head 3d9f8177
Branch psp/partner-user-management-v2: 2793c797 (fix) → **3d9f8177** (review repairs). Base add695f2
re-verified unmoved. Local only. 12 files, exactly 1 forward migration + its rollback.

### CONTROLLER-FOUND BLOCKER (against my own fix)
**The fail-soft bootstrap was SILENT — the original defect's failure mode, reproduced.** On failure it
logged and returned; /ready only checks `certificates`, and the partner readiness endpoint only
checked the BYPASSRLS capability. So a failed bootstrap left the app reporting fully healthy while
invitations stayed broken.
RULING (owner asked which of 3 options): keep fail-soft — a partner reference-data fault must never
take grading/certificates out of service (precedent: connector parks visibly, portal 503s) — but make
it OBSERVABLE on the surface that already exists for partner readiness.
`GET /api/super-admin/partner-management/readiness` now reports RBAC state and 503s with
`PARTNER_RBAC_NOT_SEEDED`. Core /ready deliberately unchanged. State re-read per probe (not a stale
boot snapshot). `not_configured` treated as healthy.

### TWO REAL MUTATION GAPS CLOSED
1. Deleting the PRODUCTION startup call SURVIVED — tests called seedPartnerRbac() directly, i.e. the
   exact shape of the defect (test-only seed masking missing wiring). Now a test drives
   bootstrapPartnerRbac() itself + a source assertion pins the index.ts call on the listen path.
2. Removing MFA session revocation SURVIVED — test asserted credential_version only. Now seeds a live
   session and asserts it is revoked.
METHOD CORRECTION: my "PARTNER_OWNER omitted" mutation was a NO-OP (targeted a quoted string that does
not exist; codes live in shared/partner-schema.ts). Redone correctly → 12 failures. Never uncovered.

### ALL 8 REQUIRED MUTATIONS NOW CAUGHT
bootstrap call removed(1) · PARTNER_OWNER omitted(12) · role-perm seeding removed(3) · ON CONFLICT
weakened(11) · original audit action omitted(3) · unapproved 5th action(1) · MFA session revoke
removed(1) · mfa_required unset(1). Tree restored green after each.

### PERSONALLY VERIFIED
Idempotency crux: partner_roles.code and partner_permissions.code are NOT NULL UNIQUE;
partner_role_permissions has PK(role_id,permission_id) — every ON CONFLICT has a real arbiter.
Production path: bootstrapPartnerRbac is inside the UNCONDITIONAL httpServer.listen callback
(NODE_ENV only affects host binding).
21 runtime proofs on real PG17: blocker reproduction, production-entrypoint fix, idempotency,
partial-seed repair, 3 concurrent bootstraps, complete role→permission mappings, unknown-role
fail-closed, readiness observability, token hashing, duplicate blocking, password reset
(hash-only/expiring/single-use/tenant-scoped/non-ACTIVE refused), MFA reset (methods disabled, codes
burned, sessions revoked, re-enrolment forced, no secret in audit), migration 0033 (18 preserved,
4 accepted, unknown rejected, legacy rows valid), rollback both ways.

### GATES
tsc 0 · eslint 0 errors (2493 warnings) · build 0 · changed-file eslint 0 errors · changed-file
prettier clean · diff --check clean · gitleaks 0 on range and scope · full suite 3696 passed / 0
failed (baseline 3693/0). +skipped are DB-gated, NOT counted as passes.

### ⚠️ AGENT PANEL REDUCED — declared
Owner asked for 6 specialist agents; I dispatched 2 (startup/concurrency, migration+security) due to
context budget, and they had not returned by report time. ALL findings above are my own direct
verification. The independent-lens coverage the owner asked for is therefore INCOMPLETE.

### DEPLOY SEQUENCE (unchanged, still owner-gated)
Apply 0033 to staging FIRST, then deploy. Deploying code first → rename/amend 500 on the old CHECK.

## 2026-07-31 — PHASE 1 STOP: MIGRATION-NUMBER CONFLICT (0033 claimed twice)
Branch psp/partner-user-management-v2 @ 8e67dbbb, clean, unchanged. Phases 2-3 NOT started.

Phase 1 verification passed on 5 of 6 checks (clean worktree; head correct; all 4 reviewed commits in
ancestry; exactly one 0033 ON MY BRANCH; 0034 free). Check 6 FAILED:

**TWO DIFFERENT FILES CLAIM MIGRATION 0033 ACROSS BRANCHES**
- psp/partner-user-management-v2 : migrations/0033_partner_audit_action_precision.sql
- wip/variant-b-migration-rbac-seed @ 2e38ed7e : migrations/0033_partner_rbac_seed.sql
scripts/db/migrate.ts rejects duplicate migration numbers by NUMERIC value up front, so if both ever
reach one tree the runner refuses to run ANY migration. Per the owner's Phase 1 rule ("Stop if any
branch or migration conflict remains") I stopped before creating 0034.

RESOLUTION (for owner approval, one line of work): keep 0033 = audit-action precision (already
reviewed, proven, and depended on by the deployed-code ordering); renumber the RBAC seed to 0034 as
the owner's own hybrid design already specifies. Variant B's own commit says "superseded by hybrid",
so nothing is lost — it stays preserved on its WIP branch.

⚠️ CONCURRENT-SESSION HAZARD: the MAIN repo worktree (/Users/cornelius/mintvault-platform) has been
moved by another session — it is now on branch wip/variant-b-migration-rbac-seed @ 2e38ed7e and is
DIRTY. At the start of this session it was detached at 7630bf19. origin/main is unmoved (add695f2).
Anyone running migrations or builds from the main worktree is NOT on main.

Variant B work confirmed PRESERVED (Phase 1.3 satisfied) — named branch + own commit, nothing
uncommitted at risk on my side.
