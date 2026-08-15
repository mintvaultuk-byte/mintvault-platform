# RELEASE BLOCKER REPAIR — Partner Shop Grading (2026-08-15)

Supersedes `RC-RECORD-PUSHED.md` for identity, findings and gate results. Scope: fix RC-F9,
RC-F10, RC-F12, RC-F14 and the genuine RC-F11 findings, prove them, push, obtain CI.
No feature development beyond the missing step-up client, no architecture change, no MVGS maths
change, no production action.

## What was wrong, and what fixing it revealed

Every finding in this pass is the same failure mode: **a check that reported nothing instead of
failing.** The step-up server guard was complete and correct, and the product was still broken.
The pinned gate was green, and did not run the three suites that proved it. The runner printed
"green", and had counted nothing. Each fix removes a way for the evidence to be absent rather than
merely adding a test.

## RC-F9 — BLOCKER — FIXED

`requireRecentAuth()` gates five actions (credit purchase, invite, role, status, revoke-sessions).
The server half shipped complete. The client half did not exist: no call to
`/api/partner/auth/step-up`, no `step_up_required` handling, no prompt. A partner met
"Confirm your password to continue." with nowhere to confirm it, so a shop could be blocked from
**buying Grading Credits — the revenue path**.

**The guard was not removed and no endpoint was unprotected.** The missing half was built.

| | |
| --- | --- |
| Mechanism | `client/src/components/partner/partner-step-up.tsx` — `PartnerStepUpProvider` + `usePartnerStepUp().runProtected(action)` |
| Mounted | once, in `PartnerRouteGuard` — the single place that already decides "can this render" |
| Sequence | run the action → ONLY on 403 `step_up_required` prompt → prove against the existing endpoint → retry the ORIGINAL action **exactly once** |
| Applied to | credit checkout (`billing.tsx`) and all four team actions (`users.tsx`) through one code path |

- **Not escalation.** The retry re-issues the same request to the same endpoint; the capability
  guards run again, and `requireRecentAuth` sits AFTER them. Proven: a GRADER is refused by
  capability, is never challenged, and a VALID proof does not change the answer or create a user.
- **Secrets.** Password/second factor live in React state only for the request that carries them and
  are wiped in a `finally`. Never localStorage, sessionStorage, cookie, URL, log or analytics —
  asserted. The server returns no token, so there is nothing to persist.
- **Retry is once.** A second challenge is surfaced, never re-prompted. Looping a password box
  trains users to type passwords into anything that asks.
- **Multi-Machine.** Already correct by construction — the proof is
  `partner_sessions.last_step_up_at`, read back through the database, so there is no process-local
  map to diverge. Now proven, along with session-scoping: another session of the same user is still
  challenged.

### Why the three suites were failing — fixtures, not product

- `PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT` lacked `0086`, so `last_step_up_at` did not
  exist and `recordStepUp` threw → **500 `step_up_failed`**, which read as broken team management.
- `partner-admin-capability`: the router moved `requireAdmin` → `requireSuperAdmin`, so its
  synthetic admin was refused **before** the capability gate. Its assertions had been changed
  503 → 403 to match — which made the file pass while **the BYPASSRLS behaviour it is named after
  went entirely unexercised**. The fixture now declares a real super admin and **the 503 assertions
  are restored**. It also supplies the three `0077` artefacts the new I18 schema contract requires,
  and grants the runtime role SELECT on them: `information_schema.columns` is privilege-filtered,
  which is why only the column probe failed while the `pg_indexes`/`pg_proc` probes passed.

### Tests — the real product flow, never a seeded timestamp

`tests/partner-step-up-ui.test.ts` (NEW, 9 tests, real React rendering): challenge → prove →
retry-once; cancel performs nothing and never retries; wrong password reported and the secret wiped;
second-factor prompt; 429 lockout preserved; nothing in storage or the URL; and **Buy Grading
Credits end to end**, asserting Stripe is reached ONLY after the proof.

`tests/partner-runtime-integration.test.ts` +6 tests over real HTTP: refusal is 403 and never 401
(a 401 would sign the user out mid-task), nothing performed before proof, a wrong password grants
nothing, an EXPIRED proof is challenged again, a revoked session cannot step up, RBAC unchanged.

## RC-F10 — HIGH — FIXED: 36 → 70 critical suites

The three suites that caught RC-F9 were outside the gate. So were 29 others, every one guarded by
an env check that made it **silently skip** rather than fail. CI already provisioned each database
and restricted login, so every value added is copied from `.github/workflows/ci.yml`.

Domains closed: AUTH (lockout decay/recovery, login rate limiting, MFA enrolment and factor
hardening, reset delivery), RBAC (final-owner invariant), STEP-UP, DASHBOARD, CERT/PRINT (partner
origin), the external-partner CONNECTOR intake path, portal mount, submission/workflow APIs, and
the two scanner suites below.

**The expansion immediately paid for itself** — it exposed two further defects (see RC-F15/F16).

## RC-F12 — HIGH — FIXED: the runner could print green having counted nothing

`--json` was optional, and without it the verdict came from the vitest **exit code alone**: every
suite reported `passed=0` and the run still printed "All 36 suite(s) green".

- the rule moves to `scripts/ci/partner-suite-verdict.mjs` so it can be tested
- **JSON evidence is mandatory**: with no `--json` the reports are still collected, to a temp dir
  removed on exit. No path reports a verdict it has not counted.
- missing report, unparseable report, a report not naming the suite, and zero observed tests are all
  `environment_abort`
- an unknown suite **name** exits non-zero instead of silently narrowing the run
- a run with zero total observed assertions refuses to report green
- `tests/partner-suite-runner-integrity.test.ts` (NEW, 14 tests) pins every branch

**CORRECTION to `RC-RECORD-PUSHED.md`.** That record claimed a usage invocation exits 0. **That was
wrong.** It has always called `process.exit(1)`; the earlier check piped the runner into `tail`,
which reports the *pipeline's* status, not node's. The regression test now asserts the real exit
code so the claim cannot be misread again.

## RC-F14 — HIGH — FIXED: two suites that ran in no environment at all

`scanner-production-migration` and `scanner-evidence-staging-service.integration` were gated on env
vars set **nowhere** — not in `ci.yml`, not in the matrix — so `describe.skip` took both files
locally **and** in CI while their presence implied coverage. `scanner-production-migration`
additionally required port **5432 exactly**, which no disposable cluster here uses, so it could not
have run even if the variable were set.

The port list widens to the ports this repository provisions (5432/55432/55433). **Every safety
property is unchanged**: loopback-only host (so a remote Neon staging or production host is still
rejected outright) and the `mintvault_dgn_release_*` name guard. `ci.yml` now provisions
`mintvault_dgn_release_scanner` (pg17) and `mintvault_dgn_evidence` (pg16) and sets both variables.

Verified **executing**, not merely present: **1/1** and **2/2**, matching their `it()` counts.

## RC-F11 — MEDIUM — genuine findings FIXED, false positive documented

| CodeQL finding | Verdict | Action |
| --- | --- | --- |
| `station-routes.ts` `POST /card-jobs` | **genuine** | 120/min per station |
| `station-routes.ts` `GET /stations/fix-queue` | **genuine** | 120/min per station |
| `station-routes.ts` `POST /card-jobs/:id/fix-authorise` | **genuine** | 60/min per station |
| `routes.ts` `POST /auth/step-up` | **FALSE POSITIVE** | the route IS limited, by `partnerMfaLimiter`; CodeQL does not trace this repo's `partnerRateLimit` factory the way it traces `express-rate-limit`. Verified by reading the route. No change, no suppression. |
| `index.ts` `js/missing-token-validation` (CSRF) | **PRE-EXISTING** | equally present on `origin/main`; out of scope for a release repair and unchanged by it |

Budgets come from the physical workflow, not a generic web-form default: scanning is the
high-frequency path, a shift must stay fast, and a limit that interrupts a real batch gets worked
around by staff — which is worse than the abuse it prevents. Keyed **per station**, so one shop can
never consume another tenant's allowance. `passOnStoreError: false`, matching every existing limiter.

`tests/partner-station-rate-limit-budgets.test.ts` (NEW, 6 tests) proves BEHAVIOUR, not wiring: a
legitimate 60-card batch is fully served; an abusive burst 429s with standard headers; a noisy
station does not consume a quiet one's budget; an unidentified caller cannot borrow a real station's
allowance. `tests/release-route-rate-limits.test.ts` pins the wiring and guard ORDER.

**Known limit, already documented in `server/partner/rate-limit.ts` and deliberately not fixed
here:** the store is per-process, so across two Machines the effective ceiling is 2×. A shared store
is infrastructure work, not a release repair; a runaway station is still bounded, per station.

## RC-F15 (NEW) — the rate-limit wiring silently voided three P6 security assertions

Adding the limiters reformatted two route registrations onto several lines.
`partner-station-new-card` and `partner-scanner-fix` locate those routes by **source text**:

```js
stationRoutes.slice(stationRoutes.indexOf('r.post("/card-jobs"'))
```

With the path on its own line that `indexOf` returns `-1`, `slice(-1)` yields the last character,
and three assertions — both station guards present, tenant/location/station taken only from
authenticated principals, `INSUFFICIENT_CREDITS` answered as 402 — ran against an **empty string**.
They failed only because `.toContain` on `""` fails; a `.not.toMatch` in the same block would have
passed while proving nothing.

Both registrations are back on one line with the limiter inserted, each carrying a comment naming
the test that depends on it. 27/0 and 23/0.

## RC-F16 (NEW) — five connector suites could not run under the pinned runner

They aborted with `relation "audit_log" does not exist`. `0018` indexes `audit_log` and `0022`
ALTERs `certificates`; no PARTNER migration creates either and these suites do not seed them.
`ci.yml` has seeded a minimal stub pair for six full-migration-set suites all along — this runner
did **not**, because it DROPs and recreates each database and so discards anything seeded first.

That asymmetry is exactly why they passed in CI and aborted here the moment they entered the gate:
the gate was not wrong about them, it could not run them. The runner now seeds the same stub pair,
byte-equivalent to the CI step, behind an explicit `seedCoreStubs` flag rather than applied blindly.

Deliberately a minimal stub, not a schema push: the real `certificates` has no `secret` column and
these suites insert `cert_id`/`secret` then assert the row survives a rollback.

## Local gate results

| Gate | Result |
| --- | --- |
| **Pinned Partner gate** | **70 suites / 1284 passed / 0 failed / 0 skipped** (was 36 / 691) |
| Protected grading guards (18 files) | **546 passed / 0 failed**, 2 skipped |
| Migration family + rollback (8 files) | **130 / 130** |
| `tests/partner-step-up-ui.test.ts` | 9 / 9 |
| `tests/partner-suite-runner-integrity.test.ts` | 14 / 14 |
| `tests/partner-station-rate-limit-budgets.test.ts` | 6 / 6 |
| `npm run check` | clean |
| `npm run lint` | **0 errors** (2600 pre-existing warnings) |
| `npm run build` | green, incl. `dist/migrate.cjs` 205.3 kB |
| `git diff --check` | clean |

The 2 skipped grading tests are the `skipIf(!isProdArch)` golden label renders; CI runs them
(verified previously: 48 tests in CI against 46 locally).

**No protected grading file is touched by this pass** — verified by diffing the changed-file list
against the MVGS/centering/pristine/grader/label set.

## AT-23 impact — CHANGED since the previous record, read this

The previous pass's delta was UI-only (category B). **It no longer is.** RC-F11 modifies
`server/partner/station-routes.ts`, which is **server runtime behaviour on the station workflow**.

**Classification: category C for the station sections.** AT-23's station/scanner sections must be
re-run on staging against this candidate before production. The remaining delta (partner client
step-up, grading-workstation UI) is client-side and category B, needing a staging UI smoke.

Do **not** claim AT-23 equivalence for the station paths on this SHA.

## Owner-gated, NOT performed

Production deploy · production migrations · production flags · live Stripe · live emails · live
Partner accounts · merging the PR.
