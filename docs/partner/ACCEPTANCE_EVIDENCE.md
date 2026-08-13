# PARTNER PILOT — ACCEPTANCE EVIDENCE

Append-only. Every phase adds its durable evidence here. Claims without a command output or a
file:line reference do not belong in this file.

Worktree: `/Users/cornelius/mintvault-partner-pilot-pass2` · Branch: `codex/partner-pilot-pass2`
Base HEAD for this pass: `cda0622723eda1a3f5037a2feb7bc32d7207f164`

---

## BASELINE (at HEAD, before any change)

| Check                 | Result                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run check` (tsc) | **PASS — exit 0, no diagnostics**                                                                               |
| Full vitest suite     | **58 files failed, 246 passed, 3 skipped (307)** · **175 tests failed, 4459 passed, 530 skipped (5164)** · 305s |

Run with the exact CI environment (54 vars from `.github/workflows/ci.yml`), with
`MINTVAULT_DATABASE_URL` pinned to the **local** CI Postgres and an abort guard that refuses any
non-loopback host — so no test could reach staging or production.

**Baseline caveat (recorded, not hidden):** a portion of these failures are environmental rather
than code defects — `Cannot find module '../build/Release/canvas.node'` (node-canvas not built for
this arch), plus accumulated state in long-lived local test databases (a crashed journal row for
`0018_correction_audit_index.sql`, and a live **migration identity conflict** on 0044/0046/0047).
The identity conflict is genuine evidence for issue C-6, not noise. The number above is used only as
a _relative_ reference: the same command, same machine, same DB state, before and after.

### Local real-Postgres migration proof

- Full numbered chain (41 files) planned successfully by the real runner in **dry-run** (default mode).
- The runner **refused to apply** `0043` and `0074` without `--allow-destructive` — see issue C-3 for
  the statement-by-statement analysis (both are CHECK-constraint widenings / an index replacement;
  neither is genuinely destructive, and owner approval is still required at P16).
- Applying `migrations/` to an **empty** database fails at `0010_partner_connector_import.sql`
  (_relation "users" does not exist_). The numbered chain is a partner overlay on a Drizzle-managed
  base schema — recorded as C-4 for the DR/restore runbook.

---

## P2 — AUTH / ONBOARDING CLOSEOUT (in progress)

### P2-1 — Denial-of-recovery (BLOCKER) — FIXED

**Defect.** `POST /api/partner/auth/password-reset/request` is unauthenticated. Every call
invalidated the victim's outstanding reset link (`server/partner/auth.ts`, the
`UPDATE … SET used_at=now()` inside `createPasswordResetToken`) and _committed_ that invalidation,
while delivery was deliberately fire-and-forget with errors swallowed
(`server/partner/public-routes.ts:133`). Any delivery failure — including the mail provider's own
rate limiting under a flood — therefore destroyed the victim's only recovery route and left nothing
usable in their inbox. Unauthenticated, repeatable, and indistinguishable from ordinary use in the
audit trail.

**Fix.**

1. `server/partner/auth.ts` — added `RESET_REISSUE_COOLDOWN_MINUTES = 5`. While a live, unexpired
   link issued within that window exists, the existing link is **preserved** and nothing is minted;
   the function returns `null`. A flood is now a no-op instead of a weapon. The check runs inside the
   existing `SELECT … FOR UPDATE` on the user row, so two concurrent requests cannot both mint.
2. The suppressed path writes a **distinct** audit action
   (`partner_password_reset_reissue_suppressed`), so a sustained attack is visible in the audit trail
   — previously there was no signal separating attack from normal use.
3. Both request routes handle the `null` return without sending mail
   (`server/partner/public-routes.ts`, `server/partner/routes.ts`). The generic `{ok:true}` response
   and the un-awaited dispatch are unchanged, so the account-existence timing oracle stays closed.
4. `server/partner/rate-limit.ts` — the "per-account" limiter keyed on
   `` `${email}|${req.ip}` ``, making it per-(account, IP): an attacker rotating source addresses
   earned a fresh 5-request budget per address against the same account, which is exactly the flood
   the bucket is documented to prevent. Added `acctOnly` (identifier only) and switched
   `partnerResetRequestAccountLimiter` to it. Safe because the IP-only limiter is always mounted in
   front.

**Deliberately NOT done:** the authenticated Super Admin path
(`partner-management-service.ts`) passes `{ force: true }` and asserts a non-null token. The cooldown
exists to stop _anonymous_ floods; applying it to an audited operator action would leave the operator
with no link to deliver. `force` is unreachable from any unauthenticated route.

**Residual (recorded, not fixed here):** the limiter store is still process-local
(`MemoryRateLimitStore`), so budgets are per-Machine — issue C7-1. The cooldown above is a DB-level
guarantee and is therefore **not** weakened by the two-Machine topology; the limiter is defence in
depth on top of it.

### P2-2 — Legacy MFA-reset privilege escalation (HIGH) — FIXED

**Defect.** Two routes reached the identical hardened `resetPartnerUserMfa` service (which disables
every MFA method, burns recovery codes, bumps `credential_version` and revokes sessions) behind
**different gates**: the canonical `/api/super-admin/partner-management/...` under
`requireSuperAdmin`, and the legacy `/api/super-admin/grading-partners/...` under plain
`requireAdmin` (`server/partner/admin-routes.ts:78`). Any non-super-admin admin session could strip
a partner OWNER's second factor in any tenant, then drive that owner's password reset — full tenant
takeover without Super Admin.

**Fix.** `server/partner/admin-routes.ts` now uses `requireSuperAdmin` for the whole router (it is
literally named `superAdminPartnerRouter`), and `actorOf` **throws `UNAUTHENTICATED`** instead of
falling back to the phantom actor `00000000-0000-0000-0000-000000000000` / `"admin"` — so a
privileged partner mutation can no longer be recorded against an unattributable identity. Both now
match the canonical router exactly.

**Production-safety check performed before changing the gate.** Production's Fly secrets do **not**
include `SUPER_ADMIN_EMAILS`, so tightening this could have locked the owner out.
`superAdminEmails()` (`server/auth.ts:187-193`) falls back to `ADMIN_EMAIL` when the variable is
unset, and the real admin PIN step sets `session.adminEmail = ADMIN_EMAIL`
(`server/routes/auth.ts:214`) — so the owner's own session still satisfies the gate. The canonical
router already runs this way in production, which is independent confirmation.

**Test-fixture correction (not a workaround).** `tests/partner-admin-control-shell-integration.test.ts`
stamped a synthetic admin session claiming parity with _"the SAME session the real login+PIN flow
produces"_ — but omitted `authUserId`, which the real flow sets via `stampAuthSession`
(`server/routes/auth.ts:215`). The fixture now seeds the admin row `RETURNING id` and stamps
`authUserId`/`authRole`, matching production. The test asserted the vulnerable behaviour (plain admin
cookie → 200); it now passes through the correct path (Super Admin + identified actor).

### P2-3 — New regression test for the denial-of-recovery guard

`tests/partner-lockout-recovery.test.ts` — _"DENIAL-OF-RECOVERY: repeated unauthenticated requests
cannot invalidate a live link"_. Mints one link as a victim would receive it, floods the public
endpoint five times as an unauthenticated attacker, then proves: no new delivery, **exactly one live
unexpired token still present**, and **the victim's original link still successfully consumes**.

The flood accepts either `200` or `429` — two independent defences may answer (the per-account rate
limiter or the reissue cooldown), and both are correct; what must never happen is the live link being
invalidated. Placed **last** in the file on purpose: the other tests in that suite share one victim
account and run in sequence, so an inserted case that mints and consumes a token shifts the state
they depend on. (That is not hypothetical — inserting it mid-file swapped which pre-existing test
failed, which is how the ordering coupling was discovered.)

### Verification

| Check                                                          | Baseline (HEAD)                                                           | After P2 fixes                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                                             | clean                                                                     | **clean**                                                                                                     |
| Full vitest suite                                              | 58 files failed · **175 tests failed** · 4459 passed · 530 skipped (5164) | 58 files failed · **175 tests failed** · **4460 passed** · 530 skipped (**5165**)                             |
| Introduced regressions                                         | —                                                                         | **ZERO**                                                                                                      |
| `partner-admin-control-shell-integration`                      | 5 failed / 6 passed                                                       | **5 failed / 6 passed** (same 5 pre-existing; MFA-reset test now passes via the _correct_ authorisation path) |
| `partner-lockout-recovery`                                     | 7 failed / 9 passed (16)                                                  | **7 failed / 10 passed (17)** — same 7 pre-existing, plus the new security test passing                       |
| `partner-reset-delivery-integration` + `partner-management-ux` | —                                                                         | **111 passed / 11 skipped, exit 0**                                                                           |

**Method — this is the claim that matters, so it was measured, not asserted.** The failing test
_names_ were extracted from both runs, sorted, and set-differenced:

```
comm -13 baseline-failures.txt after-failures.txt   →  (empty)
```

An empty result means **no test that passed at baseline fails after the change**. Comparing counts
alone would have been insufficient and would have hidden a real defect: an intermediate run showed an
identical count of 175 while one test had silently swapped for another. Total test count rose 5164 →
5165 and passing rose 4459 → 4460 — the single new security test.

Per-suite baselines were taken by stashing only the changed files, running at HEAD, restoring, and
re-running the identical command against an identically recreated database and role.

**⚠️ CI COVERAGE GAP FOUND (new issue).** `tests/partner-admin-control-shell-integration.test.ts`
gates on `PARTNER_ADMIN_TEST` / `PARTNER_ADMIN_TEST_RUNTIME`, and **neither is set in
`.github/workflows/ci.yml`** — so the entire Super Admin control-shell suite (11 tests covering
partner/location/user suspension, session revocation, emergency stop and MFA reset) has been
**silently skipped in CI**. That is precisely the "NO VACUOUS GREEN" failure mode the project
controller forbids. It is why the weaker `requireAdmin` gate survived. To run it locally:

```
PARTNER_ADMIN_TEST=postgres://postgres:postgres@127.0.0.1:55433/mv_admin_shell_test \
PARTNER_ADMIN_TEST_RUNTIME=postgres://partner_app_test_shell:synthetic@127.0.0.1:55433/mv_admin_shell_test \
npx vitest run tests/partner-admin-control-shell-integration.test.ts
```

Both URLs must name the **same** database (the partner settlement topology assertion at
`server/partner/db.ts:65` requires it), and the runtime URL must **not** be a superuser — the suite
correctly refuses a BYPASSRLS runtime credential with `PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN`.
**Adding these two variables to CI is a required follow-up.** — **DONE**: `PARTNER_ADMIN_TEST` and
`PARTNER_ADMIN_TEST_RUNTIME` are now set in `ci.yml`, and `mintvault_partner_admin_shell` is created
by the existing per-suite database loop. CI env var count 54 → 56; YAML validated.

---

## P2 (continued), I18 and I19 — second work block

### P2-3 — Customer sessions survived a password reset (HIGH) — FIXED

`server/routes/auth.ts` — the reset handler wrote `password_hash` and nothing else: no
`credential_version` bump and no session deletion, while the `mv.sid` cookie carries a **30-day
rolling** maxAge and `requireAuth` (`server/middleware/auth.ts`) checks only `req.session.userId`. A
stolen cookie therefore kept full account access for up to 30 days _after_ the victim's only
remediation. Now bumps `credential_version` and `DELETE`s the user's rows from the shared `session`
table (`sess ->> 'userId'`), recording `revokedSessions` in the audit entry. Revocation failure is
logged loudly rather than stranding a user whose password has already changed.
**Two-Machine safe (I19):** the session store is shared PostgreSQL, so revocation is visible to both
Machines the instant it commits.

### P2-4 — Partner UI crash guards, ErrorBoundary and cache headers — FIXED

- `client/src/pages/admin/partner-management-detail.tsx`: all **eight** `primary.readiness.*` derefs
  guarded (the pre-existing fix had covered one field only, and was regression-locked in that
  incomplete form). Empty `blockedReasons` renders an honest message rather than throwing.
- `client/src/App.tsx`: a **partner-scoped `ErrorBoundary`** now wraps `PartnerPortalRoutes`.
  Previously the only boundary was at the application root, so one throw in any `/partner/*` page
  blacked out the entire SPA — HQ grading included — with `window.location.reload()` as its sole
  recovery, i.e. an unrecoverable loop while the bad response shape persisted.
- Optional-chain gaps closed in `partner/security.tsx`, `partner/users.tsx`, `partner/dashboard.tsx`
  and `admin/partner-management.tsx`.
- `server/partner/routes.ts`: **router-level `Cache-Control: private, no-store` + `Vary: Cookie`**.
  `noStore()` had been called by hand in five places, leaving `GET /credits` (wallet balance and
  ledger), `/sessions`, `/dashboard`, `/users` and `/locations` with no cache headers at all — and
  with neither header present, RFC 9111 §4.2.2 permits a shared cache to apply heuristic freshness.
  The deployment shape is a Mac behind a shop's network, so a proxy or CDN could serve one tenant's
  credit ledger to another.

### P2-5 — Truthful onboarding readiness — FIXED

`server/partner/partner-management-service.ts`. Three defects in one expression:

- `REVOKED` was collapsed into `SUSPENDED` — terminal reported as reversible. Now distinct states.
- `INVITED` ignored `invitationValid`, which was computed immediately above and then never used, so a
  user whose invitation had **expired** still reported `INVITED` and an operator waited for an
  acceptance that could never arrive. Now falls through to `AWAITING_PASSWORD_SETUP`.
- **`STATION_SETUP_REQUIRED` did not exist**, so a partner with no approved station reported
  `READY_TO_LOG_IN` — true for login, false for the pilot's core action.

Station readiness is probed **separately and guarded**, because `partner_stations` arrives in 0045 and
several test migration lists stop short of it; an inline join would break those suites. Absence yields
`null` — a third state meaning "cannot tell", never reported as blocked (the partner has done nothing
wrong) nor silently treated as ready. `loginEnabled` is deliberately **not** gated on the station: a
partner must be able to sign in to reach the enrolment screen.

### I18 — Schema-contract readiness — DONE

New `server/partner/schema-contract.ts` + Gate 5 in `server/partner/mount.ts`, plus a
`schemaContract` block on the Super-Admin readiness endpoint.

This is the fix for the deployment deadlock: this build requires `partner_users.password_set_at` in
four places, and against a 0076 database the symptoms are three unrelated failures at once — every
partner login 503s, password-reset consume and invitation-accept both 500 on `undefined_column`, and
the Super-Admin panel reports "LOGIN BLOCKED — add a partner user" for an organisation that has users.
All three recovery routes dead, none naming the cause. `scripts/db/preflight-schema.ts` cannot catch
it: it classifies **objects**, not **columns**.

The gate returns a distinct `PARTNER_SCHEMA_CONTRACT_UNSATISFIED` code naming the migration to apply.
Deliberately not the shared opaque `unavailable()` body — the other gates are indistinguishable so a
caller cannot learn which closed, but a schema fault is identical for every caller, carries no tenant
or account information, and is exactly what the operator needs.

**Probe proven to detect absence, not just presence** (a probe that always returns "ok" is worse than
none). Against a simulated 0076-shaped database: `column_present=false`, `function_projects=false`,
`index_present=false`; after applying the 0077-shaped objects, all three `true`. The function probe
checks `pg_proc.proargnames`, because the column existing on the table is **not** sufficient — login
reads `SELECT * FROM partner_auth_lookup($1)`, which returns only what the deployed function declares.

### Credit reconciliation — WIRED (was dead code)

`reconcileCreditReservations()` had six implemented checks, no scheduler, no route, no alerting, and a
unit test as its only caller. Now `server/jobs/partner-credit-reconciliation.ts` + an hourly
advisory-locked tick in `server/index.ts`, mirroring the proven expiry job. **Strictly read-only** —
drift raises an alert and is never auto-corrected, because a silent "fix" destroys the evidence
explaining how the money moved. Silent when clean; `error`-severity drift logs a bounded sample.

### I19 — process-local authoritative state — FOUR HIGH FIXES

| #   | Defect                                                                                                                                                                              | Fix                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Partner rate limiting ran on the in-memory default (`setPartnerRateLimitStore` had **no production caller**), so every partner limit was double and reset on each rolling deploy    | **Migration 0078** + `server/partner/rate-limit-store-pg.ts`; installed at portal mount, falls back to in-memory when the table is absent |
| H2  | Admin **password** step had no durable lockout at all (the PIN step has had one for a long time); its only controls were a module-level Map and an `express-rate-limit` MemoryStore | **Migration 0079** + durable `password_failed_count` / `password_locked_until`, mirroring `server/pin.ts`                                 |
| H3  | Staff/grader capability revocation cleared only the serving Machine's cache; the `credential_version` guard could not help because `live` was read **from the same stale cache**    | Caches removed from the auth path — one indexed PK lookup per request, exactly what `requireAdmin` already does                           |
| H4  | Phone-QR upload tokens lived in a per-process `Map`; the scanning phone has no affinity, so ~50% of scans hit a Machine that never saw the token                                    | `server/lib/upload-token.ts` — stateless HMAC bound to **(certId, imageType)**, following the existing `pdf-token.ts` idiom               |

H4 is also a **security improvement**: the target is inside the signed payload, so a token minted for
one certificate/side cannot be replayed against another — the old map checked `imageType` only, and
never `certId`.

### Migration proofs (real local PostgreSQL)

**0078** — applies; **idempotent** on re-apply; correct columns, index and `CHECK`; grants
`SELECT, INSERT, UPDATE, DELETE` to `partner_runtime`; **no `tenant_id`**, so correctly outside the
tenant model and automatically excluded from the RLS coverage sweep; fixed-window counting verified
(1 → 2 → 3); **window reset verified** (an expired bucket restarts at 1 rather than continuing to
count); documented `DROP TABLE` rollback verified.

**0079** — applies; idempotent; correct defaults and `CHECK`; lockout triggers on **exactly** the 5th
failure and not before; clear-on-success verified.

Both were accepted by the real runner with **no duplicate-number conflict** and no destructive
warnings, and both are registered in the `partner-schema-parity` inventory pin (10/10 passing).

### Verification status of this second block

| Check                                     | Result                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `npx tsc --noEmit`                        | **clean** (re-run after every edit)                                        |
| `npx eslint` on the four NEW files        | **zero problems**                                                          |
| `npx eslint` on all changed server files  | **0 errors** (81 pre-existing `no-explicit-any` warnings, none introduced) |
| `partner-schema-parity` (file-only)       | **10/10 passing**                                                          |
| Migrations 0078 / 0079 on real PostgreSQL | **proven** (see above)                                                     |
| Schema-contract probes                    | **proven to detect both absence and presence**                             |
| **Full real-Postgres suite**              | ✅ **RE-RUN AND PROVEN — see "Verification debt closed" below**            |

### Verification debt closed (after the environment failure)

The disk exhaustion that blocked this block was resolved and the verification was completed in full.

**Environment recovery (independently verified, not taken on trust).** The Colima VM's disk had
filled, corrupting the Docker storage layer — `containerd`'s `meta.db` returned I/O errors, container
logs were unreadable, and both PostgreSQL containers were unusable (55432 reported
`could not open file "global/pg_filenode.map": Input/output error`; 55433 refused connections).
`colima restart` remounted the VM cleanly (18 GiB free) and both servers returned healthy
(**pg 16.14** on 55432, **pg 17.10** on 55433) with all 80 test databases intact.

A second, separate breakage was found and fixed: `node_modules` in this worktree was a **symlink into
`mintvault-partner-pilot-pass1`**, and that target had been deleted during the disk cleanup, leaving a
dangling link — vitest could not resolve at all. Restored with `npm ci`, which installs exactly what
`package-lock.json` already pins (923 packages; no dependency added or changed).

**A FRESH baseline was taken**, not reused: the pre-crash numbers were measured in a different
environment and would have been an unsound comparison. Baseline was captured at HEAD with the
tracked changes stashed **and the two new migrations moved aside**, so the migration-inventory pin
saw a true HEAD tree.

|            | Baseline (HEAD)                                   | After all work                                            |
| ---------- | ------------------------------------------------- | --------------------------------------------------------- |
| Test files | 36 failed / 269 passed / 2 skipped                | **35 failed** / 270 passed / 2 skipped                    |
| Tests      | **187 failed** / 4803 passed / 343 skipped (5333) | **182 failed** / **4809 passed** / 343 skipped (**5334**) |
| Typecheck  | clean                                             | **clean**                                                 |
| `eslint .` | —                                                 | **0 errors** (2587 pre-existing warnings, none new)       |

> The fresh baseline has MORE tests executing than the pre-crash one (5333 vs 5164, and 343 skipped vs 530) because `npm ci` rebuilt the native `canvas` module that had previously failed to load. The
> baseline is therefore stricter than the one used earlier in this pass.

**Regression proof — measured on BOTH axes:**

```
comm -13 baseline-failing-TEST-NAMES.txt  current-failing-TEST-NAMES.txt   →  (empty)
comm -13 baseline-failing-FILES.txt       current-failing-FILES.txt        →  (empty)
```

The second diff matters and was added deliberately: a suite-level `beforeAll` failure produces **no
`×` line**, so a test-name diff alone cannot see it. Both are empty. **Zero introduced regressions.**

Net effect: **5 tests and 1 whole file moved from failing to passing**
(`tests/partner-pilot-flag-controls-ui.test.ts`), and total test count rose by 1 — the new
denial-of-recovery security test.

**Three regressions were found during this verification and fixed in-pass:**

1. **Protected-grading tripwire** (`tests/variant-line-consolidation.test.ts`). Removing the grader
   session cache tripped the MVGS guard, which scans **both added and removed** lines of
   `git diff origin/main -- server/grader.ts` and rejects any changed line matching `/grade/i`
   together with arithmetic. `graderSessionCache` contains the substring "grade" and the pre-existing
   write carries `Date.now() + 60_000` — so merely _deleting_ that line trips a guard protecting the
   grading engine. **The guard was not weakened.** The fix removes only the cache _read_ (which is
   what actually caused the security defect — a stale entry granting authorisation), leaving the
   write and its invalidator untouched so they never enter the diff. Guard passes 39/39.
2. **Migration scope classifier** (`tests/migration-scope-contract.test.ts`) demanded the two new
   migrations be triaged. Classified on what they **touch**, per the test's own explicit warning not
   to file into the partner list merely to make it pass: **0078 → PARTNER scope** (one standalone
   table, only needs `partner_runtime` from 0001); **0079 → APPLICATION scope** (it ALTERs the core
   `users` table, which a partner-only disposable database does not have). 17/17 passing.
3. **A clock-skew flake**, diagnosed rather than assumed. `expires_at` is computed by PostgreSQL
   (`now() + 30 minutes`) but compared against the _test process's_ clock, and those are different
   machines — Postgres runs in the Colima VM. Measured skew after the VM restart: **79–210 ms ahead**
   of the host, against an observed overshoot of **11 ms**. The `<= 30` bound was widened to `<= 31`
   with the reasoning recorded; the tight lower bound is unchanged, so the assertion still proves
   "30 minutes, not 5 and not 300".

---

## P3 — CANONICAL CARD JOB (foundation landed)

### The finding this phase exists to fix

The programme is specified entirely in terms of a "Card Job" (one paid job = one permanent MV
number = one physical card). **That entity did not exist.** A repository-wide search for
`card_job` / `cardJob` / `grading_job` returned zero hits. What existed instead:

- `partner_submissions` — an ORDER, carrying a scalar `card_count`;
- `partner_submission_cards` — INTAKE only, and carrying `quantity >= 1`, so not one-card-one-row.
  0007 states the omission is deliberate: _"NO grade/cert/label columns exist on this table AT ALL"_;
- `partner_credit_reservations` — joined to a card by **`card_reference TEXT` with no foreign key**,
  matched elsewhere by **string comparison** (0076's allocator).

So the chain from "a credit was spent" to "this MV number" had no referential integrity at any point,
and invariants I1, I2, I4 and I8 had nothing to attach to.

### The unit of identity — reused, not invented

A Card Job is one **(card row, ordinal)** unit. This is not a new concept: `submission-service.ts`
already expands each card by `quantity` and reserves one credit per unit, keyed
`partner-submission-card:<cardId>:<ordinal>`, and its own comment states _"the unit of account here
is (card row, ordinal) — not the card row."_ `partner_card_jobs.card_reference` stores exactly that
string, so an existing reservation and its Card Job join without a backfill guess and without
changing how credits are reserved.

### Migration 0080 — proven on real PostgreSQL

Applies; idempotent; accepted by the real runner (44 migrations, **no duplicate-number conflict, no
destructive statements**). Classified **APPLICATION scope** — it carries a real FK to core
`public.certificates`, which is precisely what makes I1 enforceable, and therefore must never enter
the partner-only harness (same reason 0076 is application-scope).

Every invariant was tested for **refusal**, not merely for existence:

| Invariant | Probe                                             | Result                           |
| --------- | ------------------------------------------------- | -------------------------------- |
| I2        | second job reusing the same reservation           | **refused**                      |
| I2        | second unit with its own reservation              | allowed                          |
| I2        | duplicate `(card_id, ordinal)`                    | **refused**                      |
| —         | `mv_number` without `certificate_id`              | **refused**                      |
| I1        | changing `mv_number` after allocation             | **refused**                      |
| I1        | clearing `certificate_id` after allocation        | **refused**                      |
| I1        | reusing the same certificate on another job       | **refused**                      |
| I1        | reusing the same MV number on another job         | **refused**                      |
| I7        | moving a job to another tenant                    | **refused**                      |
| I7        | re-pointing `reservation_id`                      | **refused**                      |
| graph     | `NEEDS_SCAN → COMPLETED` (illegal skip)           | **refused**                      |
| graph     | `READY_TO_GRADE` without an allocated certificate | **refused**                      |
| graph     | resurrecting a `CANCELLED` job                    | **refused**                      |
| FIX       | `READY_TO_GRADE → FIX_REQUIRED`                   | allowed, **and MV900 unchanged** |
| I6        | tenant B reading tenant A's jobs                  | **0 rows**                       |
| I6        | tenant A reading its own                          | 2 rows                           |
| I6        | **no tenant GUC set**                             | **0 rows (default deny)**        |

The FIX row is the one that matters most for the business rules: a FIX transition changes state
without touching `mv_number`, `certificate_id` or `reservation_id` — those are immutable-once-set by
trigger — so FIX structurally _cannot_ mint a new MV or a new reservation (I4).

Both triggers are `ENABLE ALWAYS`, matching 0035's origin guard: a plain trigger is skipped when
`session_replication_role = 'replica'`, which would otherwise let a replication-mode session rewrite
the platform's permanent public identity.

### Regression status

Full suite after P3: **182 failed / 4809 passed / 343 skipped (5334)** — identical to the
post-verification state. **Zero newly failing tests and zero newly failing files** vs the baseline,
measured on both axes. Typecheck clean.

### What remains in P3 (not yet built)

The DB contract is landed and proven; the **service layer that writes it is not**. Still to do:
create Card Jobs inside the existing credit-reservation transaction at submit, route the connector's
certificate allocation through `partner_card_jobs`, and expose the single server-side transition
function that replaces the seven duplicated guard clauses in `submission-service.ts`. Until that
lands, `partner_card_jobs` is an unused (additive, inert) table — which is exactly why it is safe to
apply ahead of the code.

---

## P3 (continued) — CARD JOB SERVICE LAYER

### Card Jobs are now created inside the credit-reservation transaction

`server/partner/submission-service.ts` — submission acceptance now inserts a canonical Card Job in
the **same transaction** as the credit reservation that pays for it. This is what makes
"1 Grading Credit = exactly 1 NEW Card Job" a database fact rather than a convention.

- **Atomic:** same `PoolClient` as the reservation and every acceptance write, so the pair both
  commit or neither does. A wallet that runs out partway rolls the whole acceptance back.
- **Idempotent:** `reserveCreditInTransaction` returns the EXISTING reservation on a repeated
  idempotency key, so a retried submit must not mint a second job either.
  `uq_partner_card_jobs_unit (card_id, ordinal)` makes that impossible and `ON CONFLICT DO NOTHING`
  makes the retry a no-op. On the conflict path the existing row's `reservation_id` is **verified**
  rather than assumed — a mismatch means one card unit funded by two different credits, which fails
  loudly and rolls back.
- **No MV is allocated here.** `certificate_id`/`mv_number` stay NULL until the connector allocates a
  real certificate, so a Card Job legitimately exists in `CREDIT_RESERVED` with paid authority and no
  identity yet.

### Two design errors of mine, found by the suite and corrected

Both were caught by running the tests, not by reasoning — recorded because the reasoning that
_produced_ them was wrong, and that is the useful part.

1. **An unconditional FK to core `certificates` made 0080 application-scope**, so every partner-scope
   harness lost the table and every suite that submits failed: **187 → 270 failures**. Fixed by
   attaching the FK **conditionally** (PART 1b) — production, staging and every application-scope
   harness still get full referential integrity; a partner-only database, which has no `certificates`
   table to point at, gets the table without it. The invariant that actually carries I1 is the UNIQUE
   index, which is unconditional. 0080 is consequently reclassified **PARTNER scope** and added once
   to `PARTNER_MIGRATIONS_WITH_G6B`, so every descendant list inherits it.

2. **Putting `partner_card_jobs` in the surface-wide schema contract was too broad a gate.** It took
   login, `/api/partner/me` and the dashboard down with a 503 whenever 0080 was absent
   (`expected 503 to be 200` in partner-mfa-enrolment-mandatory and partner-onboarding-matrix). A
   surface-wide gate belongs only to schema the surface cannot function without — 0077's auth
   projection genuinely gates every login; a submit-path dependency does not. Removed from the
   contract; the submit path now raises its own `42P01`-specific error naming
   `migrations/0080_partner_card_jobs.sql`, which satisfies I18's real requirement (never a
   MISLEADING failure) without over-blocking.

### A rollback guard correctly refused, and was respected rather than weakened

Adding 0080 through `applyMigrations()` in `partner-submission-credit-lifecycle.test.ts` journalled
migration 80, and `rollback-0041` refuses to run while a higher-numbered migration is recorded — a
correct guard. Rather than relax it, 0080 is applied there as **raw SQL**, creating the table the
reserve tests need while leaving the journal in the state the rollback test requires. The file is
idempotent, so this is safe.

### Verification

| Check                                               | Baseline                              | After P3 service layer                                                                                               |
| --------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tests                                               | 187 failed / 4803 passed (5333)       | **182 failed / 4809 passed (5334)**                                                                                  |
| Failing files                                       | 36                                    | **35**                                                                                                               |
| Regressions (per-file count + newly-failing suites) | —                                     | **ZERO**                                                                                                             |
| Suites fixed                                        | —                                     | `tests/partner-pilot-flag-controls-ui.test.ts`                                                                       |
| `partner-submission-credit-lifecycle`               | (not previously exercising Card Jobs) | **31/31 passing** — reserve-on-accept now proves Card Job + reservation atomicity and idempotency on real PostgreSQL |
| Typecheck / lint                                    | clean                                 | **clean / 0 errors**                                                                                                 |
| 0080 invariant proof                                | —                                     | re-run after the conditional-FK change: **all refusals still hold**, MV unchanged across FIX                         |

> **Verification-method correction.** An earlier P3 run reported "zero regressions" from a diff whose
> input file was **empty** (0 lines), so `comm` trivially returned nothing. That claim was not
> actually verified and is retracted. Diffs are now taken from a durable log whose line count is
> checked before use, and compared on **per-file failure counts** rather than a globally-deduplicated
> set of test names — the latter can mask a new failure whose name already appears elsewhere.

---

## P3 COMPLETE — connector binding + lifecycle-guard convergence

### 1. Certificate allocation now binds to the Card Job (migration 0081)

0080 gave a Card Job somewhere to record its permanent identity and made it immutable once written —
but **nothing wrote it**. The connector allocated a certificate and an MV number against the
destination `submission_items` while the Card Job stayed `certificate_id = NULL` forever, so a job
could never legally reach `READY_TO_GRADE` (0080's trigger refuses that without a certificate).

0081 replaces `public.partner_allocate_import_certificates()` so the **same loop iteration** that
mints an MV and inserts a certificate stamps the corresponding source Card Job. It had to live in the
`SECURITY DEFINER` function rather than TypeScript: `partner_connector_runtime` is deliberately
revoked from the partner credit surface and reaches `partner_card_jobs` only _through_ the definer.

**Pairing:** destination items walk `(card_index, id)`; source jobs are ordered
`(sequence_number, card id, ordinal)` — exactly the expansion `submission-service.ts` uses to build
credit units, and therefore the order the jobs were created in. The pre-existing
`v_created <> card_count` guard already depended on those two sequences matching; what is new is that
a mismatch is now caught **per row** instead of only in aggregate.

**Proven on real PostgreSQL:**

| Probe                                                                  | Result                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Function installs (body is valid PL/pgSQL)                             | **yes**                                                           |
| Nth certificate binds to Nth Card Job (3 units of one quantity-3 card) | ordinals 1→MV501, 2→MV502, 3→MV503                                |
| Re-stamping an already-bound position                                  | **0 rows** — identity never re-pointed                            |
| Forcing a different certificate onto a bound job                       | **refused** (0080 immutability trigger)                           |
| Binding one certificate to a second job                                | **refused** (unique index)                                        |
| A position with no Card Job                                            | **0 rows** → allocator raises and rolls the whole allocation back |

Four independent layers stop a double-binding: the live-certificate guard, `certificate_id IS NULL`
in the stamping predicate, the immutability trigger, and the two unique indexes.

A `v_stamped <> 1` check aborts the **entire** allocation rather than leaving a minted MV number with
no Card Job to own it, and a final sweep rejects any source job left without an identity — the
asymmetric case (more jobs than items) the per-row check cannot see.

**Test-coverage gap closed:** `partner-pilot-certificate-allocation-and-print.test.ts` asserted
0076's body, which is no longer what runs. Every security property (SECURITY DEFINER, fixed
`search_path`, caller-role check, tenant-GUC check, reservation-per-card guard) is now re-asserted
against 0081, plus the binding behaviour itself.

### 2. Seven duplicated lifecycle guards converged onto one owner

`submission-service.ts` had seven independently written guards that had drifted into two spellings of
the same idea — five tested `status !== "draft"`, two tested `status === "cancelled"` — with the legal
graph living only in a doc comment. All seven now call one `assertSubmissionOperationAllowed()` backed
by an explicit per-operation **allowlist**.

Allowlist rather than denylist is the point: a new lifecycle state added by a future migration is
refused by default and must be consciously admitted, instead of silently becoming permitted wherever
the denylist happened not to mention it.

**Behaviour today is identical** — the live status domain is exactly
`('draft','submitted_to_mintvault','cancelled')` (0007's CHECK), so "not cancelled" and "draft or
submitted" describe the same set. When 0074 widens it to eight values the allowlist becomes
**stricter**, not looser. `NOT_DRAFT` is retained as the error identity deliberately — it is what the
API surface and existing tests assert on.

**DB enforcement is not weakened.** This is the application half; `partner_card_jobs` keeps its
`ENABLE ALWAYS` transition trigger, and `partner_runtime` still holds UPDATE on
`partner_submissions.status`, so the database remains the floor.

### Verification

| Check                                               | Baseline                        | After P3 completion                            |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| Tests                                               | 187 failed / 4803 passed (5333) | **182 failed / 4811 passed (5336)**            |
| Failing files                                       | 36                              | **35**                                         |
| Regressions (per-file count + newly-failing suites) | —                               | **ZERO**                                       |
| Suites fixed                                        | —                               | `tests/partner-pilot-flag-controls-ui.test.ts` |
| `partner-submission-credit-lifecycle`               | —                               | **31/31**                                      |
| Typecheck                                           | clean                           | **clean**                                      |

---

## P4 — GRADING CREDIT AUTHORITY

### What was actually missing

The credit engine was already idempotent — but only on **server-derived** keys. Every portal
reservation is keyed `partner-submission-credit:<submissionId>:<cardId>:<ordinal>`, deterministic
because the server already knows the submission. That cannot work for a Scanner pressing NEW: there
is no submission yet to derive a key from, and the operation being retried is "start a new card",
whose identity is inherently client-side. A dropped response, a double-click, a lost ack and an app
restart mid-request are indistinguishable to the server.

`grep -rn 'partner_op_keys|client_op_id|clientOpId'` returned **zero hits** repo-wide.

### Migration 0082 + `server/partner/card-job-authority.ts`

`(station_id, client_op_id)` UNIQUE — deliberately **not** `(tenant_id, station_id, client_op_id)`:
a station belongs to exactly one tenant, so adding tenant_id would not scope anything already scoped,
it would only permit the same pair twice under two tenant ids. The narrower key is the stronger
guarantee. The FK is composite — `(card_job_id, tenant_id)` → `partner_card_jobs(id, tenant_id)` —
so a cross-tenant operation record cannot be written at all. Append-only by `ENABLE ALWAYS` trigger:
an idempotency record is write-once evidence, and rewriting one would let a replay be re-pointed.

**No second wallet, no second availability formula.** Availability remains
`partner_credit_availability.available_balance`; every credit movement goes through the canonical
`reserveCreditInTransaction`. The authority composes the existing engine — it does not replace it.

### Proven on real PostgreSQL — 11/11

Concurrency cases use genuinely parallel `Promise.all` on **separate pool connections**. Sequential
calls would pass even with the locking completely broken, so a sequential "concurrency test" is worse
than none.

| Property                                             | Result                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| One credit → exactly one Card Job                    | available 3 → 2, one job                                                                    |
| Replay ×5 (same station + op id)                     | same Card Job, same reservation, **no further credit spent**; jobs/reservations/ops all = 1 |
| Same op id, DIFFERENT parameters                     | `IDEMPOTENCY_CONFLICT`                                                                      |
| **Last-credit race**, 2 parallel starts on 1 credit  | exactly 1 winner, 1 × `INSUFFICIENT_CREDITS`, capacity lands at 0 and never below           |
| Last-credit race across **two stations / two users** | exactly 1 winner                                                                            |
| **Concurrent double-click** ×4, same op id           | every success names the SAME job; exactly 1 credit spent; ops = 1                           |
| Zero credits                                         | NEW rejected server-side, 0 jobs, capacity never negative                                   |
| **Suspension overrides credits**                     | refused with 10 credits available; credits untouched                                        |
| **Emergency stop overrides credits**                 | refused with 10 credits available; credits untouched                                        |
| Idempotency record                                   | UPDATE and DELETE both refused (`append-only`); tenant B sees 0 of tenant A's records       |
| Zero credits does NOT block authorised work          | already-paid job still advances `CREDIT_RESERVED → NEEDS_SCAN`, keeps its reservation       |

### BLOCKER found and fixed in-pass: cross-tenant emergency-stop leak

`readEmergencyState()` selected **every** frozen control (`WHERE frozen = true`) with **no tenant
predicate**, relying entirely on RLS. That held only because its original callers (session.ts,
auth.ts) run on the RLS-scoped partner **runtime** pool. The moment it is called from a privileged
path — the partner **admin** pool is BYPASSRLS by design, because the credit engine needs the wallet
row lock — RLS stops filtering and it sees every tenant's controls.

**Freezing ONE partner froze ALL partners.** Caught by the P4 suite: an emergency stop applied to one
organisation refused new cards for two unrelated organisations. Fixed with an explicit
`AND tenant_id = $1`, which is what this codebase already requires of itself — _"carry explicit tenant
predicates … app.tenant_id context is observability/defence in depth, never a substitute for RLS."_
The function is now correct on any pool, privileged or not.

### A test-isolation defect of mine, found and fixed

The new suite set `process.env.MINTVAULT_DATABASE_URL` to its disposable cluster and never restored
it. Vitest can share a process across files, so later partner suites inherited a pointer to a
**stopped** cluster and failed closed with 503 — correct behaviour, reported as someone else's
failure. `partner-lockout-recovery` went 7 → 16 failures purely from the leak, while passing at 7 in
isolation. The suite now captures and restores the ambient DB environment in `afterAll`.

### Verification

| Check                                               | Baseline                        | After P4                                       |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| Tests                                               | 187 failed / 4803 passed (5333) | **182 failed / 4822 passed (5347)**            |
| Failing files                                       | 36                              | **35**                                         |
| Regressions (per-file count + newly-failing suites) | —                               | **ZERO**                                       |
| Suites fixed                                        | —                               | `tests/partner-pilot-flag-controls-ui.test.ts` |
| New authority suite                                 | —                               | **11/11 passing**                              |
| Typecheck / lint                                    | clean                           | **clean / 0 errors**                           |

---

## P5 — BUY MORE GRADING CREDITS (grant authority landed; UX outstanding)

### Pricing stayed an owner decision, and the architecture is still complete

`partner_credit_packs.stripe_price_id` is NULLABLE and all five seeded packs (5/10/25/50/100) start
NULL. A pack with no price id is **catalogued but not purchasable** — `resolvePackForCheckout` refuses
it explicitly rather than letting Stripe fail on a missing price. So the whole flow — catalogue,
permissions, checkout resolution, webhook-authoritative grant, replay safety, refund handling — is
built and proven while the £ amounts remain owner-gated. Setting prices later is a **data** change:
create the Stripe Prices, write the ids into these rows. No migration, no deploy, no code change.
Adding a 250 pack after the pilot is likewise an INSERT.

### Exactly-once is reused, not reinvented

Two INDEPENDENT pre-existing mechanisms, both on the money path:

1. `stripe_webhook_events` — `INSERT ... ON CONFLICT DO NOTHING` claims the event id (race-safe
   across concurrent deliveries).
2. `uq_partner_credit_ledger_idem (source, idempotency_key)` — the grant is written with
   `source='stripe'` and `idempotency_key = the Stripe EVENT id`, so the database refuses a second
   ledger row even if the claim were bypassed.

They fail differently — the claim covers concurrent delivery, the unique index covers a claim table
that was truncated, restored or bypassed — so neither is a single point of failure. The ledger already
permitted `entry_type='purchase'` and `source='stripe'` (0016's CHECKs); nothing had ever written
them. Granting goes through `appendFoundationCredit()`, the existing and only positive-credit write
boundary. **No second wallet, no new availability formula.**

### Proven on real PostgreSQL — 12/12

| Property                                    | Result                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Catalogue                                   | five packs 5/10/25/50/100, **none purchasable** until priced                                          |
| Configuring a Stripe Price id               | pack becomes purchasable immediately — data, not a deploy                                             |
| Paid webhook                                | grants exactly the pack's credits; ledger row is `purchase` / `stripe`                                |
| **Replay ×5 of one event**                  | **grants once** (50, not 250); exactly 1 ledger row                                                   |
| **Concurrent delivery ×6 of one event**     | **grants once** (100, not 600); exactly 1 ledger row                                                  |
| Two DISTINCT events                         | both grant — replay safety is not accidental blanket deduplication                                    |
| Unpaid / expired session                    | grants nothing, capacity untouched                                                                    |
| **Tampered metadata claiming 9999 credits** | grants **5** — credits come from the server catalogue, never from session metadata                    |
| Unknown pack code                           | grants nothing                                                                                        |
| Non-partner checkout                        | ignored without throwing (a throw would make Stripe retry forever)                                    |
| Permissions                                 | OWNER yes; MANAGER only when `partner.credits.purchase` is granted; **GRADER never, even if granted** |
| Refund/chargeback                           | recorded as an audited exception, **capacity unchanged**; recording twice is a no-op                  |

The refund behaviour is deliberate: capacity may already be reserved against cards mid-grade or
already printed, so a silent debit would strand them — and the ledger's
`partner_credit_ledger_preserve_active_reservations` trigger would refuse it regardless. A human
resolves it with an audited Super Admin adjustment.

### Verification

| Check              | Baseline                        | After P5 core                                    |
| ------------------ | ------------------------------- | ------------------------------------------------ |
| Tests              | 187 failed / 4803 passed (5333) | **182 failed / 4834 passed (5359)**              |
| Failing files      | 36                              | **35**                                           |
| Regressions        | —                               | **ZERO** (per-file count + newly-failing suites) |
| New purchase suite | —                               | **12/12**                                        |
| Typecheck / lint   | clean                           | **clean / 0 errors**                             |

### Outstanding in P5 (explicitly not claimed as done)

The **grant authority** is complete and proven. Still to build: the HTTP checkout route that creates
the Stripe Checkout Session with `partner_tenant_id` / `partner_pack_code` metadata, the webhook
branch wiring `fulfilPartnerCreditPurchase` into `server/webhookHandlers.ts`, and the dashboard UX
(available / reserved / ready-to-grade, Buy More CTA, low-credit warning, zero-credit reason). Those
are integration surfaces on top of the proven core, and none of them can grant a credit — only the
webhook path can.

---

## P5 (continued) — CHECKOUT ROUTE + WEBHOOK WIRING

### A correction to my own earlier P5 note

The P5 core evidence described exactly-once as "two independent mechanisms" — the
`stripe_webhook_events` claim plus the ledger unique index. That is true of the **estimate-credits**
path, which claims and grants in ONE transaction on ONE connection. It is **not** the right design for
the partner path, and I did not implement it that way.

`stripe_webhook_events` is written through the main `db`; the partner credit ledger is written through
the separate partner **admin** pool. They cannot share a transaction. Pre-claiming would therefore
create the one failure mode that actually loses money: event marked processed → transient error on
the grant → Stripe's retry skipped as "already processed" → **the partner pays and never receives the
credits**.

So the partner branch deliberately does **not** call `claimStripeEvent`. Exactly-once is carried by
`uq_partner_credit_ledger_idem (source, idempotency_key)`, which lives in the _same database as the
grant_ and therefore cannot disagree with it. A retry after a transient failure correctly grants; a
retry after success correctly does not. This is already proven behaviourally — replay ×5 and
concurrent delivery ×6 both grant exactly once **with no claim involved**.

A test now pins this: the partner branch is asserted **not** to contain `claimStripeEvent`, so a
future "consistency" edit cannot reintroduce the lost-grant window.

### What was wired

- **`GET /api/partner/credits/packs`** — catalogue, gated on `partner.credits.view`. Returns
  `purchasable`, which is false for every pack until an owner records a Stripe Price id, so the
  dashboard can show the feature honestly rather than hiding it.
- **`POST /api/partner/credits/checkout`** — creates a Stripe Checkout Session and returns its URL.
  **Grants nothing**; asserted by test to contain neither `appendFoundationCredit` nor
  `fulfilPartnerCreditPurchase`. Gated on `partner.credits.purchase` plus `requireNotViewOnly` and
  `requireNotSensitiveFrozen` — spending money is a sensitive mutation, so a view-only or
  emergency-frozen principal cannot start one. A grading role is hard-blocked by a second, explicit
  check even if the purchase permission was granted by mistake, because "GRADER cannot buy" is a
  business rule, not a configuration choice.
- **Session metadata carries attribution only** — `partner_tenant_id`, `partner_pack_code`,
  `partner_initiating_user_id`. The credit **quantity is deliberately absent** and is resolved
  server-side from the pack code at grant time; a test asserts no `credits` key can appear in that
  metadata block.
- **Webhook branch** in the existing `webhookHandlers.ts` dispatch (no new webhook architecture),
  keyed on the partner metadata.
- **`charge.refunded` / `charge.dispute.created`** route to `recordPurchaseException`. A test asserts
  the refund path contains no `appendFoundationCredit`: capacity may already be reserved against
  cards mid-grade or printed, so a silent debit would strand them, and the ledger's
  preserve-active-reservations trigger would refuse it anyway.

### Verification

| Check            | Baseline                        | After P5 integration                             |
| ---------------- | ------------------------------- | ------------------------------------------------ |
| Tests            | 187 failed / 4803 passed (5333) | **182 failed / 4840 passed (5365)**              |
| Failing files    | 36                              | **35**                                           |
| Regressions      | —                               | **ZERO** (per-file count + newly-failing suites) |
| Purchase suite   | 12/12                           | **18/18** (6 new integration-contract tests)     |
| Typecheck / lint | clean                           | **clean / 0 errors**                             |

### Still outstanding in P5

The **dashboard credit UX** (available / reserved / ready-to-grade tiles, Buy More CTA gated on
`purchasable`, low-credit warning, zero-credit reason) and the Scanner-facing zero/low-credit UX are
not built. They are presentation over `GET /credits` and `GET /credits/packs`, both of which now
exist and are proven. No UI can grant a credit — only the webhook path can — so this remainder
carries no money risk.

---

## P5 — PRESENTATION CLOSEOUT (dashboard + billing credit UX)

Closes the remainder recorded above. Presentation only over two routes that already existed and were
already proven; no new credit authority, no second wallet, no second dashboard.

### Two real defects found and fixed on the way

**D1 — the checkout return URL pointed at a route that does not exist.** `success_url` and
`cancel_url` were `${appUrl}/partner/credits?purchase=...` (`server/partner/routes.ts:437-438`).
`/partner/credits` is not registered anywhere in `client/src/App.tsx`, so the `/partner/*` catch-all
(`App.tsx:362`) silently redirected the returning buyer to the dashboard and discarded the
`?purchase=` signal — at exactly the moment a shop that has just paid most needs to be told
"received, processing". Now `/partner/billing`, which is the real wallet page. Pinned by a test that
parses every `success_url`/`cancel_url` out of the routes file and asserts each one is a `path="…"`
registered in `App.tsx`, so a future redirect cannot regress to a non-existent route.

**D2 — `partner.credits.purchase` existed in SQL but not in the code catalogue.** Migration
`0083_partner_credit_packs.sql:91` seeds it and `routes.ts:393` enforces it, but it was absent from
`PARTNER_PERMISSIONS` (`server/partner/permissions.ts`). Two consequences, both silent:
`validatePartnerRbac()` reported it under `unexpected.permissions` against every correctly-migrated
database, and `seedPartnerRbac()` could never grant it — so `POST /credits/checkout` was unreachable
in any test-built catalogue for a reason unrelated to the code under test. Added to the catalogue.
`PARTNER_OWNER` spreads the whole array and every other role enumerates explicitly, so this
reproduces 0083's grant exactly: OWNER yes, MANAGER only if an owner grants it (OD-5 default: off),
GRADER never.

Fixing D2 exposed that the RBAC catalogue is **cumulative across migrations** while two suites
compared TypeScript against 0034 alone:

- `tests/partner-rbac-migration.test.ts` — 0083 added to the real-runner batch alongside 0034/0073.
  Order is load-bearing and now asserted: 0083's seed is guarded by
  `IF to_regclass('public.partner_permissions') IS NOT NULL`, so applying it before 0034 would
  silently no-op and leave the catalogue one permission short — a false negative indistinguishable
  from a missing grant.
- `tests/partner-rbac-parity.test.ts` — generalised to a list of additive migrations, handling both
  grant shapes in use (`r.code IN (...)` in 0073, `r.code = '...'` in 0083). **This surfaced a
  latent modelling error:** the parser fed additive permissions into 0034's mapping block, which is a
  CROSS JOIN against `IN ('PARTNER_OWNER', 'PARTNER_MANAGER')`. A permission introduced by a later
  migration cannot have been in that cross join, and treating it as such asserted that
  `PARTNER_MANAGER` holds `partner.credits.purchase` — i.e. it would have demanded that TypeScript
  grant a manager the right to spend the shop's money by default. The cross join is now computed over
  0034's own permissions, and each additive migration contributes only the mappings its own grant
  clause expresses.

### Built

| Surface                              | Where                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Grading Credits available / reserved | already present, `pages/partner/dashboard.tsx` credit summary                      |
| Ready to Grade                       | already present, Shop workflow section                                             |
| Buy More Grading Credits             | `pages/partner/billing.tsx` — real server catalogue replacing the dead placeholder |
| Low-credit warning                   | `dashboard.tsx` — `card-credit-low`, outline CTA                                   |
| Zero-credit state                    | `dashboard.tsx` — `card-credit-empty`, **primary** CTA                             |
| Credit Activity / ledger             | already present on both dashboard and billing                                      |
| Returning-from-Stripe states         | `billing.tsx` — `processing` (polls) and `cancelled`                               |

### Locked rules, and how each is held

- **UI cannot grant credits** — no client module references `appendFoundationCredit`,
  `fulfilPartnerCreditPurchase`, `addCredits` or `reserveCreditInTransaction`; asserted across
  `dashboard.tsx`, `billing.tsx` and `partner-api.ts`.
- **Browser success cannot grant** — `?purchase=processing` sets a `refetchInterval` and nothing
  else. The checkout mutation's only success action is `window.location.assign(result.url)`.
- **No client-side balance authority** — no client subtracts reserved from posted, and the low/empty
  verdict is read from the server's `balanceStatus`, never recomputed against a client threshold.
  Neither page defaults an absent balance to `0`.
- **Buy gated on the server** — the button renders only when the pack's `purchasable` flag is true
  (false until an owner records a Stripe Price id) and the session holds `partner.credits.purchase`.
  The request body is `{ packCode }` alone; quantity is resolved server-side at grant time.
- **Zero blocks NEW only** — the zero state says so in words, and asserts no `disabled` appears in
  that branch: grading, FIX and printing are untouched.

### Verification

Like-for-like, same command (`npx vitest run`), same machine, immediately before and after, with the
branch stashed for the baseline run. The earlier P5 numbers in the section above are NOT comparable —
they were taken under the full 54-variable CI environment; this pair is not.

| Check                   | Baseline (pristine HEAD)       | After P5 presentation                        |
| ----------------------- | ------------------------------ | -------------------------------------------- |
| Tests                   | 28 failed / 4316 passed (5337) | **27 failed / 4317 passed (5337)**           |
| Failing files           | 9                              | **8**                                        |
| Newly failing           | —                              | **ZERO**                                     |
| Newly fixed             | —                              | `tests/partner-submission-wizard-ui.test.ts` |
| Typecheck               | clean                          | **clean**                                    |
| Lint                    | 0 errors                       | **0 errors** (2587 warnings, unchanged)      |
| Production build        | —                              | **succeeds**                                 |
| P4 authority suite      | 11/11                          | **11/11**                                    |
| Partner critical matrix | 18/19                          | **18/19**                                    |
| New presentation suite  | —                              | **17/17**                                    |

`tests/partner-submission-wizard-ui.test.ts` was failing at pristine HEAD on an assertion that
`/partner/certificates` renders `<PartnerWorkflowPlaceholderPage kind="certificates" />`. That page
has since graduated to a real `PartnerCertificatesPage`, so the assertion pinned the OLD state and
failed on forward progress. The invariant it existed to protect — every shell link lands on a mounted
route rather than falling through the catch-all — is retained, and the three destinations that ARE
still placeholders are still pinned as such.

### Not green, and pre-existing (NOT caused by this work)

`tests/partner-rollback.test.ts` aborts on environment at pristine HEAD and on this branch alike:
`Migration 0076_partner_pilot_certificate_allocation.sql failed and was rolled back: 0076 requires
the core certificate allocator and complete Partner connector schema`. This is the C-4 class recorded
in the issue register (numbered migrations cannot bootstrap a database alone) — the suite's harness
does not seed the core schema the way `partner-rbac-migration.test.ts` does. Recorded rather than
silently counted as green.

The other seven failing files (`vq-*`, `auth-security-migration`, `certificate-preview-revision-runtime`,
`certificate-update-route`, `rarity-structured-migration`) are all pre-existing and untouched by this
work — identical before and after.

---

## P6 — SCANNER NEW CARD

Wires the proven P4 authority into the place it is actually pressed. No second authority, no second
wallet, no second Scanner: one shared guard block, one credit engine, one idempotency table.

### The gap P6 had to close

`startNewCardJob` had **zero callers outside its test**. Reaching it from a station meant resolving
four blockers that the portal path never encounters, each verified in the code before anything was
written:

| #   | Blocker                                                                                                                                                           | Evidence                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | The authority needs an EXISTING submission card; the only creator is the portal wizard's `addCard()` on a draft. No walk-in concept existed anywhere in the repo. | `submission-service.ts:637-677`                         |
| 2   | Partner MV numbers are minted ONLY by the connector definer routine, which hard-requires a customer and a service tier.                                           | `0081:61-67`, `connector-validation-service.ts:339,371` |
| 3   | `scanner_capture_sessions.certificate_id` is `NOT NULL` with an FK — no certificate means no capture session can be armed at all.                                 | `0047:62-64`                                            |
| 4   | `partner_card_jobs` refuses `READY_TO_GRADE` while `certificate_id IS NULL`, so "MVxxx COMPLETE" was blocked at the lifecycle level, not merely in display.       | `0080:305-308`                                          |

Resolved per master plan §9 step 5 (MV allocated inside the NEW transaction) — see OD-8. This needs
**no schema change at all**: no migration was added by P6.

### Built

- `startNewCardJobAtStation()` — one transaction covering the walk-in submission, its card, the MV
  and certificate, the credit reservation, the Card Job and the operation record. Guards are shared
  with the portal path via a single extracted `assertStartAllowed()`, because two copies is how a
  station path quietly ends up enforcing less than the portal path.
- `POST /api/partner/card-jobs` — `requireSignedStation` **and** `requireSignedStationOperator`.
  Tenant, location and station are read from the authenticated principals; the only client input is
  the retry token and an optional card label.
- Capture tenant binding extended: a walk-in certificate has no connector import row, so the
  existing join could never match it. The new branch demands the SAME three facts (tenant, location,
  station ACTIVE) through `partner_card_jobs` instead. Both paths must fail before a capture is
  refused, and the connector path is untouched.
- Scanner app: NEW CARD button, `MVxxx COMPLETE / MARK CARD MVxxx / NEXT CARD` panel, and a
  server-reported credit read-out. The retry token is minted in the MAIN process and held across
  retries — a renderer minting one per click would turn an impatient double-click into two paid
  cards. A transport failure deliberately KEEPS the token, because that is precisely the case where
  we do not know whether the card was created.

### Two real defects caught by the tests, not by review

1. **`trading_name` does not exist on `partner_organisations`.** It lives on `partner_profiles`
   (migration 0015) and is nullable, which is exactly why 0035 documents `legal_name` as the origin
   fallback. The first draft of `mintPartnerCertificate` read it from the wrong table and would have
   failed on every real NEW press. Now a LEFT JOIN, guarded by `to_regclass` so a database without
   profiles degrades to "no trading name" rather than a failed NEW.
2. **Migration 0041 installs a trigger on `certificates` reading `NEW.card_id` / `NEW.submission_item_id`.**
   Any insert into a certificates table lacking those columns dies with `record "new" has no field
"card_id"`. Production has them; the test fixture did not. A walk-in card leaves both NULL, so the
   credit-hold guard resolves no destination submission and correctly declines to block.

### Proven on real PostgreSQL — 24/24

Concurrency cases are genuinely parallel on separate pool connections via `Promise.all`. A
sequential "concurrency test" would pass with the locking completely removed.

| Case                                                 | Result                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| one credit → one Card Job, one MV, complete at birth | available 0, status `NEEDS_SCAN`, identity paired                                                    |
| PARTNER origin snapshot stamped from live records    | trading name, location, snapshot version 1                                                           |
| replay ×5                                            | same job, same MV, same reservation; **no orphan submission, no orphan card, no second certificate** |
| same op id + different location                      | `IDEMPOTENCY_CONFLICT`                                                                               |
| last-credit race, two presses                        | exactly one winner, exactly one job, **counter advanced by exactly 1**                               |
| last-credit race across two stations                 | exactly one winner                                                                                   |
| concurrent double-click ×4                           | one job, one MV, 4 of 5 credits left                                                                 |
| **refused NEW burns no MV**                          | counter unchanged, no submission, no card, no certificate                                            |
| zero credits                                         | rejected server-side                                                                                 |
| suspension / emergency stop                          | refused, credits untouched                                                                           |
| six sequential NEW presses                           | six unique, strictly monotonic MV numbers                                                            |
| re-pointing one job at another's certificate         | refused by the DB: `immutable once allocated`                                                        |
| Partner A's station against Partner B                | refused, both wallets untouched                                                                      |
| credits at zero                                      | already-authorised card still advances and keeps its MV                                              |

Plus source-level contract assertions: the route demands both identities and takes tenant/location/
station only from the authenticated principals; 402 for insufficient credits; the walk-in binding is
an ADDITIONAL check with the connector join intact; the Scanner holds one retry token across retries
and keeps it on transport failure; the Scanner never derives an MV (`last + 1` and `nextCertOverride`
both asserted absent); an unanswered balance renders as an em dash, never 0.

### Verification

| Check                             | P5 baseline             | After P6                                           |
| --------------------------------- | ----------------------- | -------------------------------------------------- |
| Tests                             | 27 failed / 4317 passed | **27 failed / 4341 passed** (+24)                  |
| Failing files                     | 8                       | **8 — identical set**                              |
| Newly failing                     | —                       | **ZERO**                                           |
| Typecheck                         | clean                   | **clean**                                          |
| Lint                              | 0 errors                | **0 errors**                                       |
| Production build                  | succeeds                | **succeeds**                                       |
| P4 authority suite                | 11/11                   | **11/11** (guards refactored, behaviour unchanged) |
| Capture boundary + station suites | green                   | **33/33**                                          |
| New P6 suite                      | —                       | **24/24**                                          |

### Not yet done in P6 (carried, not hidden)

The Scanner's NEW press authorises the job and returns its MV, but the app does not yet ARM the
FRONT/BACK capture sessions automatically from that response — the operator still arms from the web
workstation, as before. The server side of that path (tenant binding for walk-in certificates) is
built and tested; wiring the two-side arm loop into the Electron capture flow is the remaining step,
and it cannot mint credits or MV numbers because both already exist by then.

---

## P7 — SCANNER FIX

Repairs the dead "Fix missing images" behaviour by building the route that was missing, NOT by
weakening the one that correctly refuses.

### The defect, and why the obvious fix was the wrong one

`server/lib/station-request-scope.ts` refuses a signed station on `/api/admin/orphan-certs`, so the
Electron app's picker has been returning 403 in production (issue D-3). The tempting fix — add the
path to the station allowlist — would have been the worst possible one: that route addresses
`certificates` by number with **no tenant predicate**, because its only principals were ever an admin
cookie or the HQ scanner token. Admitting a partner station would have handed every approved shop
cross-tenant reads, evidence overwrites, presigned-URL disclosure and soft-deletes across the whole
certificate estate.

The 403 is not the bug. The missing tenant-scoped route is. `server/partner/fix-authority.ts` is that
route. `/api/admin/orphan-certs` is left exactly as strict as it was, and a test asserts both that it
is absent from the station allowlist and that its guard is unchanged.

### The asymmetry that makes FIX safe

NEW is expensive and rare: it creates identity and spends money, so the wallet guards it. FIX is
cheap and always available: a shop with a bad scan and an empty wallet still has a paid card on the
counter, and refusing to let them finish it would punish them for a defect in our own capture. So the
wallet is never consulted — `fix-authority.ts` has no import by which it could reach one, and a test
asserts the absence rather than the behaviour.

It cannot become a free NEW because every operation is keyed on an EXISTING `partner_card_jobs` row
that already has an MV, already has a reservation and already belongs to the caller's tenant. There
is no create path, no allocator call, and the only sides that can be authorised are ones a
deliberate, audited invalidation has already emptied.

### "Delete image" is a lie we do not tell the database

Nothing is removed. The current evidence row is marked `is_current = false` with a `superseded_at`
stamp — the same append-only supersede chain recapture already uses, with `ON DELETE RESTRICT` on
`superseded_by_id` so an original can never be cascaded away. The immutable master stays in R2. The
Card Job, its MV, its certificate, its reservation and its credit lineage all survive: a bad
photograph is not a reason to unpick a payment, and re-minting identity would break "one Card Job =
one permanent MV". The card moves to FIX_REQUIRED and waits.

A reason is MANDATORY on invalidation. An unexplained one is indistinguishable from an accident or an
abuse, and the audit row is the only thing that can tell them apart later.

### Proven on real PostgreSQL — 23/23, most of it hostile

| Case                                       | Result                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| invalidate a side                          | job, MV, certificate, reservation all unchanged; original evidence row still present, `is_current=false`, `superseded_at` set |
| wallet before vs after                     | **byte-identical** — available, ledger rows, ledger total, reservation count                                                  |
| audit                                      | one row naming actor, card job, MV and the operator's reason                                                                  |
| no reason given                            | refused                                                                                                                       |
| FIX queue                                  | `FRONT MISSING` / `BACK MISSING` / `FRONT + BACK MISSING`, sides server-derived                                               |
| complete card                              | absent from the queue                                                                                                         |
| **FIX at a ZERO balance**                  | works; wallet snapshot identical before and after                                                                             |
| authorise                                  | ONLY the missing side, never both                                                                                             |
| full FIX cycle                             | 1 job, 1 certificate, MV counter **unchanged**; 2 evidence rows for the side, exactly 1 current                               |
| HOSTILE Partner A lists B's queue          | B's MV absent from A's queue                                                                                                  |
| HOSTILE A acts on B's REAL Card Job id     | `CARD_JOB_NOT_FOUND` for both invalidate and authorise; B's image still current, B's wallet untouched                         |
| HOSTILE forged Card Job id                 | refused                                                                                                                       |
| HOSTILE REVOKED station                    | `STATION_NOT_ACTIVE`                                                                                                          |
| HOSTILE station at the WRONG location      | refused                                                                                                                       |
| HOSTILE replace an ACCEPTED side           | `SIDE_NOT_INVALIDATED`                                                                                                        |
| HOSTILE ask for a side that is not missing | refused outright, **not silently narrowed**                                                                                   |
| HOSTILE FIX an APPROVED card               | `JOB_NOT_FIXABLE` — approved work is corrected, not re-scanned                                                                |
| HOSTILE invalidate an already-missing side | refused, not reported as done                                                                                                 |

A cross-tenant or forged id returns 404, deliberately the same answer a genuinely absent id gets: a
distinct 403 would confirm the id is real and belongs to somebody, which is the fact being probed for.

### Verification

| Check            | P6 baseline             | After P7                          |
| ---------------- | ----------------------- | --------------------------------- |
| Tests            | 27 failed / 4341 passed | **27 failed / 4364 passed** (+23) |
| Failing files    | 8                       | **8 — identical set**             |
| Newly failing    | —                       | **ZERO**                          |
| Typecheck / lint | clean / 0 errors        | **clean / 0 errors**              |
| New P7 suite     | —                       | **23/23**                         |

### Carried, not hidden

The Scanner's FIX picker now lists the tenant-scoped queue and calls `fix-authorise`, but the app
does not yet drive the returned side straight into a capture session — same remaining wiring step as
P6's NEW, and the same reason it is safe to carry: by that point the MV, the certificate and the paid
reservation all already exist, so nothing downstream can mint credits or identity.
