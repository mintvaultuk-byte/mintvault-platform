# PARTNER PILOT — AUTHORITATIVE ISSUE REGISTER

One register, per `docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`. Every entry is backed by file:line or a
command output. Severity follows the controller's rule: a finding is only BLOCKER/HIGH when
**reachability, reproducibility and material impact** are proven — otherwise it is FOLLOW_UP.

Status legend: OPEN · IN-PROGRESS · FIXED · FOLLOW_UP · OWNER-DECISION · BLOCKED

Last updated: 2026-08-13 (P0 complete, P1 archaeology 3/5 agents reported).

---

## 2026-08-19 Partner Network production location form repair

### PNL-LOCATION-001 — Production audit action constraint rejects canonical location creation. BLOCKER

**Status:** PROVEN · **Source:** authenticated-production acceptance report; code/data-path trace at
`client/src/pages/admin/partner-management-detail.tsx`,
`server/partner/partner-management-routes.ts`,
`server/partner/partner-management-service.ts`,
`server/partner/partner-management-errors.ts`, and
`migrations/0084_partner_location_management.sql`.

**Reproduction / reachability:** a Super Admin submits `POST
/api/super-admin/partner-management/partners/:partnerId/locations`. The route accepts the current
free-text reason through `optionalReason`; the canonical service trims the one-string address and
then calls `withAudit(..., 'partner_location_created', ...)`. On production's pre-0084 audit CHECK,
the attempt audit insert fails with PostgreSQL `23514`; the generic mapper returns `VALIDATION_ERROR`
and the UI displayed “A field value is not permitted.” The valid example fields are therefore not
the rejected value; the rejected value is audit `action_type='partner_location_created'`.

**Impact:** no additional Partner location can be created in production, despite the canonical UI,
route, tenant scope and service being reachable.

**Repair:** the UI now uses controlled, stable audit reasons; composes its structured UK address
into the existing nullable string `address`; validates operator input before submission (including
the server's 2–120 character location-name boundary); preserves
the Super Admin route/service/scope; and reports the actual missing audit-schema dependency for the
specific `23514` response. It also restores an encoded address-only Google Maps search action after
a location is stored. No new endpoint, guard, table, column, geocoder, API key, or migration was
created.

**Production migration proof:** the owner-approved scoped runner applied only existing additive
`0084_partner_location_management.sql` atomically (journal 41 → 42). A rollback-only transaction
proved its widened CHECK accepts the canonical location action while retaining current audit actions.
No 0091/0092/0093 migration was applied.

**Proof / test:** the real PostgreSQL 17 service test executes locally against the migration lineage
through 0084 and proves trimmed valid creation, tenant isolation, and attempted/succeeded audit rows.
The separately wired real main-app HTTP/PostgreSQL test covers the same request surface when
`PARTNER_MANAGEMENT_RT_ADMIN` points to a disposable loopback PostgreSQL 17 database; it is skipped
locally because that shared database/container service is unavailable. Authenticated production
acceptance verified the stored active location and its encoded Google Maps destination. `npm run
check`, ESLint (zero errors), `npm run build`, and `git diff --check` pass for the candidate.

---

## 2026-08-19 payment/top-up reconciliation

### PAY-1 — Staging credit packs cannot become purchasable until owner supplies Stripe TEST commercial config. OWNER-DECISION

**Status:** OWNER-DECISION · **Phase:** zero-credit top-up / Stripe TEST acceptance

Read-only staging reconciliation on 2026-08-19 found the safe starting state:

- Staging (`mintvault-v2`) has TEST-shaped Stripe secret/publishable keys and a webhook secret, but
  `STRIPE_ENV` is not declared.
- `partner_credit_packs` contains the five active pilot packs (`PACK_5`, `PACK_10`, `PACK_25`,
  `PACK_50`, `PACK_100`) but all five have `stripe_price_id=NULL` and `stripe_currency=NULL`.

Code now fails closed in this state. Checkout refuses undeclared/mismatched Stripe mode, validates
the configured Stripe Price ID/currency/livemode before returning a Checkout URL, and the verified
webhook requires matching local Checkout provenance (`0097_partner_credit_checkout_sessions.sql`)
before the append-only credit ledger can grant purchase credits.

Owner action required: approve/set staging `STRIPE_ENV=test`, provide the five TEST Stripe Price IDs,
confirm `stripe_currency='gbp'` and VAT/prices, then perform one human Stripe TEST Checkout. Until
that happens, no purchase credits should be granted.

---

## A. ARCHITECTURE-LEVEL FINDINGS (change the shape of the work)

### A-1 — There is no "Card Job" record. BLOCKER (scope-defining)

**Status:** OPEN · **Phase:** P3

The entire programme is specified in terms of a Card Job (one paid job = one permanent MV number).
**That entity does not exist.** `grep -ril 'card_job|cardJob|grading_job'` over `migrations/ server/
shared/ client/` returns **zero hits** (verified directly).

What exists instead:

- `partner_submissions` (`migrations/0007_partner_submissions.sql:56-85`) is an **order**, carrying a
  scalar `card_count integer`, not a row per card.
- `partner_submission_cards` (`0007:91-114`) is intake only. Verified directly: it has **no
  certificate, no MV, no credit and no reservation column**. `0007:88-89` states this is deliberate —
  _"NO grade/cert/label columns exist on this table AT ALL … enforced by omission"_.
- The link from a paid card to an MV number is stitched with **nullable text**, not foreign keys:
  `partner_credit_reservations.card_reference text NOT NULL` and `.submission_reference text`
  (`0017:26-27`), matched by **string comparison** at `0076:165-174`.

**Consequence:** P3 is a build, not a convergence. Invariants I1, I2, I4 and I8 have nothing to attach
to until this record exists. This is the largest single piece of unbuilt work in the programme.

### A-2 — No central lifecycle transition function. HIGH

**Status:** OPEN · **Phase:** P3

The plan requires one server-side transition function. There is none. `partner_submissions.status` is
written by two scattered inline SQL literals — `server/partner/submission-service.ts:461` (cancel) and
`:943` (submit) — with the legal graph existing only as a **doc comment** at
`server/partner/submission-service.ts:13-18`, and enforcement duplicated as ad-hoc guards at `:387`,
`:446`, `:538`, `:584`, `:647`, `:692`, `:796`.

`partner_runtime` holds `SELECT, INSERT, UPDATE` on `partner_submissions` (`0007:191-196`) including
the `status` column, with **no trigger constraining it**. HQ has the equivalent guard
(`migrations/status-transition-trigger.sql:85-88`); Partner does not.

### A-3 — No signed/notarised Scanner app exists. BLOCKER for locked rule 20

**Status:** OPEN · **Phase:** P6 / OWNER-DECISION

Locked business rule 20 states shop users must not need Terminal, Git, npm, DB URLs, API keys or
environment variables, and that install must be: _install app → login/MFA → enrol station → approve →
READY_.

Reality: there is **no Xcode project, no Swift, no `.pbxproj`, no `Info.plist`, no `.entitlements`,
and zero occurrences of `codesign`, `notariz`, `electron-builder`, `Developer ID` or hardened runtime**
anywhere in `scripts/scanner-app/`. The Scanner is an **Electron app installed by `git clone` +
`npm install`** (`scripts/scanner-app/setup-new-mac.sh:60-92`), and each station compiles a 342-line
Objective-C ImageCaptureCore bridge **at runtime** via `/usr/bin/xcrun clang`
(`scripts/scanner-app/lib/lide400-controller.js:154`) — so **Xcode Command Line Tools is a hard
prerequisite on every shop Mac**.

**The current install procedure requires exactly the three things rule 20 forbids: Terminal, Git and
npm.** Packaging/signing is unbuilt work and is on the critical path to "can this Mac go in a shop".

### A-4 — OD-1 is already settled in code; the real decision is different. OWNER-DECISION

**Status:** RESOLVED-BY-EVIDENCE

OD-1 asked which capture engine to use _if both work_. Evidence: only one works.

- Legacy watcher/SilverFast is **hard-dead at the server** — `server/routes.ts:10629-10634` returns
  **HTTP 410 unconditionally** for unbound scanner ingest. The old inbox is actively quarantined to
  `rejected/` (`scripts/scanner-app/lib/watcher.js:308-316`). SilverFast exists only in prose, never
  as code.
- The ImageCaptureCore path is present, wired end-to-end, and unit-tested (35/35).

**OD-1 needs no owner decision.** The genuine owner decision is A-3 (fund packaging/signing) — recorded
as **OD-1′**.

---

## B. CORRECTNESS / INVARIANT DEFECTS

### B-1 — `certificate_number` has a live UPDATE path with no immutability trigger. HIGH

**Status:** OPEN · **Phase:** P3 · **Invariant:** I1

Verified directly at `server/routes.ts:4938-4944`: an **unconditional startup IIFE that runs on every
boot** executes a mass `UPDATE certificates SET certificate_number = …`, wrapped in a `try/catch` that
only `console.error`s (`:4948-4950`) — it **fails silently**.

No `certificate_number` immutability trigger exists anywhere. The only `certificates` triggers are
`trg_certificates_origin_immutable` (`0035:290-308`, guards `origin_*` only) and
`trg_certificates_advance_grading_revision` (`0073:270`). Neither references `certificate_number`.

_Impact classification:_ today the predicate `certificate_number ~ '^MV-[0-9]+$'` matches only the
legacy `MV-000…` form, so it is currently a **no-op** — hence HIGH, not BLOCKER, per the
no-speculative-blockers rule. The defect is the unguarded, un-audited, error-swallowed rewrite path on
the platform's permanent public identity column.

### B-2 — Boot-time runtime DDL on both Fly Machines. HIGH

**Status:** OPEN · **Invariants:** I17, I18

The same IIFE (`server/routes.ts` ~4900-4950) runs `ALTER TABLE certificates ADD COLUMN …` and
`DELETE FROM ebay_price_cache …` on **every boot of every Machine**. With the locked two-Machine
topology and rolling deploys, both Machines execute this concurrently during the mixed-version window.
This is schema mutation from application code, error-swallowed — the opposite of the I18 requirement
that a version prove its schema at startup and **fail closed** with a visible readiness error.

### B-3 — 0053 monotonic allocator guard is absent from this lineage while 0076 grants the very privilege it constrains. HIGH

**Status:** OPEN · **Phase:** P3/P4

Verified directly: `migrations/0053_cert_counter_monotonic_allocator.sql` is **not in the worktree and
not in HEAD** (`git cat-file -e HEAD:… ` fails). It exists only on other branches.

Meanwhile `0076:70-71` grants `UPDATE (last_issued, updated_at) ON public.cert_counter` to
`partner_credit_lifecycle_definer`. The 0053 guard (`trg_cert_counter_monotonic`,
`trg_cert_counter_no_truncate`) that prevents **re-seeding** the allocator is missing on this lineage.
A re-seed makes the next allocated number collide with an already-printed slab.

**Ruling:** 0053's protections must land **before or with** 0076. These must be sequenced together.

### B-4 — Good news, correcting the plan: the MV allocator IS gapless. NOT-A-DEFECT

**Status:** CLOSED (plan recommendation R5 does not apply)

Plan R5 warned the allocator might be a Postgres SEQUENCE (which gaps on rollback). It is not.
`cert_counter` is an allocator **table**, allocated by `UPDATE … RETURNING` inside the caller's
transaction (`server/storage.ts:1430-1451`), so a rollback restores the number. The invariant is
further protected by the type system: `getNextCertId(executor: SqlExecutor)` takes a **required**
executor precisely so no caller can autocommit an increment (`server/storage.ts:1408-1414`). All three
allocation sites wrap allocate+insert in one transaction.

**Residual concern (FOLLOW_UP):** `cert_counter` is created by **application boot code**
(`server/storage.ts:1360-1372`), not by any migration — no migration owns the platform's identity
allocator.

### B-5 — Immutability triggers absent or INSERT-only across the capture/evidence surface. HIGH

**Status:** OPEN · **Phase:** P3 · **Invariant:** I7

| Table                                        | Expected guard              | Reality                                                                                       |
| -------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `partner_submissions.tenant_id/location_id`  | immutable                   | **ABSENT** (RLS blocks cross-tenant move only; same-tenant location rewrite is unconstrained) |
| `partner_station_calibrations`               | immutable scope             | **INSERT-ONLY** trigger (`0045:136-139`) — post-insert all three columns freely rewritable    |
| `scanner_capture_sessions`                   | immutable binding           | **ABSENT** — no triggers, no RLS, no tenant column (`0047:62-81`)                             |
| `scanner_evidence_staging`                   | immutable                   | **ABSENT** — no triggers, no RLS (`0047:95-112`)                                              |
| `certificate_image_evidence`                 | "immutable evidence ledger" | **ABSENT** — `sha256`, `object_key`, `superseded_by_id` all freely UPDATE-able (`0047:20-45`) |
| `partner_submissions.location_name_snapshot` | immutable                   | PRESENT (`0074:186-189`) but **not `ENABLE ALWAYS`**, unlike the 0035/0073 house convention   |

### B-6 — Migration 0075 unapplied ⇒ one station can hold two active capture targets. HIGH

**Status:** OPEN · **Phase:** P6

`0075_partner_station_single_active_capture.sql` is source-only by its own header. It contains only the
partial unique index `uq_scanner_capture_one_active_station`. **Until applied, the single-active-capture
invariant is unenforced.**

---

## C. DEPLOYMENT / MIGRATION STATE

### C-1 — Production is two commits behind; 0077 is not deployed anywhere. HIGH

**Status:** OPEN — see `PHASE0_RECONCILIATION.md` §0.3/§0.4.
Production runs `6f0d59df`. `9a242c6b` (auth onboarding recovery, which _introduces_ 0077) and
`cda06227` (0077 RLS repair) are **not live**. 0077 is unapplied on staging and absent from both
deployed builds.

### C-2 — 0074/0075/0076/0077 all unapplied on staging. HIGH

**Status:** OPEN. Staging journal high-water = **0073** (62 rows, all `applied`). The Plan's claim that
0074-0076 are applied is **false for staging**.

### C-3 — Applying 0074 requires `--allow-destructive`. OWNER-GATED (not actually destructive)

**Status:** OPEN · **Phase:** P16

The runner refuses 0043 and 0074 without the flag. I inspected every flagged statement:

- `0043:52` — `DROP INDEX IF EXISTS uq_partner_submission_credit_holds_active_destination` immediately
  followed by creating a **better** unique index. Benign index replacement.
- `0074:97` and `0074:195` — `ALTER TABLE … DROP CONSTRAINT` + `ADD CONSTRAINT` **in the same
  transaction**, widening two CHECK constraints. 0074's own comment (`:25`) explains this is the only
  way Postgres can widen a CHECK. `0074:84-95` guards it with a fail-loud precheck that raises if any
  unexpected status already exists.

**Verdict: not genuinely destructive** — the linter is a static pattern matcher. Both are CHECK
widenings (new domain is a superset), which is **old-version-safe** and therefore satisfies I17 for the
mixed-version window. **Owner approval is still required for the flag at P16.**

_Caveat:_ neither `DROP CONSTRAINT` carries `IF EXISTS`, so 0074 is not re-runnable if partially
applied — the journal is what prevents that.

### C-4 — Numbered migrations cannot bootstrap a database alone. FOLLOW_UP

**Status:** OPEN (operational fact for the release plan)

Proven locally: applying `migrations/` to an empty database fails at
`0010_partner_connector_import.sql` — _"relation \"users\" does not exist"_. The numbered chain is a
**partner overlay on top of a Drizzle-managed base schema**. Any DR/restore runbook must create the
base schema first.

### C-5 — Staging has only one Fly Machine. HIGH (blocks AT-23)

**Status:** OPEN · **Phase:** P14
Prod = 2 machines (correct, both on the same image). Staging = **1**. AT-23 (multi-Machine state
independence) cannot be executed until staging is scaled to 2. Scaling staging _up_ is permitted;
the production hold forbids scaling prod _down_.

### C-6 — Migration number collisions are real and observable. MEDIUM

**Status:** OPEN (mitigated by discipline)

Nine numbers collide across refs. This is not theoretical — the runner's collision detector **fired
during the baseline test run**:

```
Migration identity conflict — this database already applied a DIFFERENT migration at the same number:
  0044: applied '0044_partner_submission_lifecycle_and_location_snapshot.sql' vs release '0044_partner_mfa_pending_lifecycle.sql'
  0046: applied '0046_partner_mfa_pending_lifecycle.sql'                      vs release '0046_scanner_processing_jobs.sql'
  0047: applied '0047_partner_owner_invariant_tenants_rls.sql'                vs release '0047_scanner_evidence_staging.sql'
```

**Global high-water mark = 0077. New migrations start at 0078**, re-verified against the production
journal before any file is created.

---

## C7. I19 — PROCESS-LOCAL AUTHORITATIVE STATE (plan B-1; two-Machine correctness)

The plan mandated an explicit grep for module-level mutable authoritative state. Done. Results below.
**Good news first:** sessions are Postgres-backed (`connect-pg-simple`, `server/index.ts:239`), Stripe
webhook dedup is DB-backed, MV allocation is a DB row lock, crons use `withAdvisoryLock`
(`server/index.ts:439-449`), partner wallet/credit/reservations are fully DB-backed, and there are
**zero `global.`/`globalThis.` assignments** in `server/` or `shared/`. The credit domain — the money
path — is clean.

### C7-1 — Partner portal rate limiting is entirely process-local. HIGH

`server/partner/rate-limit.ts:34` — `let store: RateLimitStore = new MemoryRateLimitStore();`
(buckets at `:21`). Every `failClosed: true` partner limiter resolves through it: login (10/15min),
login-by-IP (30/15min), MFA (20/15min), **password reset (5/15min)**, invitation accept (10/15min).
`setPartnerRateLimitStore` has **no production caller** — only `tests/`.
**Two-Machine effect:** budgets are silently doubled and every rolling deploy resets all buckets
mid-attack. The module's own header (lines 4-6) calls a shared store an _"INFRASTRUCTURE PREREQUISITE
for production"_, and `:188-194` admits the budget _"is not a global one"_. It ships as if satisfied.
**This is also the control that bounds the denial-of-recovery defect in P2** — the two are coupled.

### C7-2 — Admin _password_ brute-force lockout is process-local with no DB fallback. HIGH

`server/auth.ts:18-19` — `loginAttempts` / `pinAttempts` Maps. The PIN step has a DB-backed lockout
(`checkLockout`, `pin_locked_until`, `server/routes/auth.ts:177`); **the password step has no
persistent counter at all**, and `adminCredentialRateLimit` (`server/routes/auth.ts:63-78`) passes no
`store:`. Doubled budget on the single highest-privilege credential, reset on every deploy.

### C7-3 — Staff/grader capability revocation does not propagate across Machines. HIGH

`server/staff.ts:114` (`staffSessionCache`), `server/grader.ts:286` (`graderSessionCache`). These are
not read caches — they are the only live-authorisation source for `requireStaff` and
`requireCapability`. `invalidateStaffSessionCache` is called after capability change, password reset,
session revocation and account deletion, but clears **this process only**.
The `credential_version` guard does not save it: `requireStaff` compares the session's version against
`live`, and `live` is read **from the same stale cache**, so the stale entry matches and the session
survives. `setStaffCapabilities` never bumps `credential_version`, so it depends entirely on
invalidation. A revoked or **deleted** staff account keeps acting on the other Machine for up to 60s —
while the code comments at `:409-411` and `:580-582` explicitly claim the opposite.

### C7-4 — Phone-QR upload tokens minted/redeemed from a per-process Map. HIGH

`server/routes.ts:8727` `_uploadTokens`; minted at `:8729-8741`, and `:8745-8760` is the **only**
validator with no DB or signed-token fallback. The phone is a separate client with no affinity, so
roughly half of QR scans hit the Machine that never saw the token → `401`. Fails closed (no security
hole) but is a ~50% functional break. The repo already has the correct pattern —
`server/lib/pdf-token.ts` (HMAC, stateless).

### C7-5 — All 73 `express-rate-limit` instances use the default MemoryStore. MEDIUM

No `rateLimit({ … })` call site anywhere passes `store:`. Every published limit is silently 2× and
resets on deploy — including `paymentRateLimit` (10/15min→20) and `preGradeRateLimit` (3/hr→6, which
gates paid Anthropic calls).

### C7-6 — Tier capacity gate decided from a stale per-process cache, duplicated. MEDIUM

`server/routes.ts:1328` and `server/routes/submissions.ts:110` — two independent copies.
`invalidateCapacityCache` (`server/routes.ts:1367-1373`) is **defined but never called anywhere**, so
the only refresh is a 30s TTL. With 2 modules × 2 Machines there are four caches; a tier at 499/500 can
be overshot for up to 30s. Overshoot is bounded by arrival rate, not by `max_active`.

### C7-7 — Vault Quest export: per-Machine counter makes a destructive write. MEDIUM

`server/vault-quest/export-jobs.ts:186` `let activeDurableRenders = 0;` — at `:252-258` a
process-local counter **cancels a durable DB job row** (`cancelExportJob`) and returns 429. If Machine
A is busy and B idle, a job is cancelled rather than left for B to claim.

### C7-8 — Auto-AI dedup and failure backoff are per-process. MEDIUM

`server/scan-ingest-service.ts:1356` `inFlightAutoAi`, `:1362` `lazyAiAttempt` (90s cooldown). FRONT
uploaded via Machine A and BACK via Machine B → both fire the full ~20s Anthropic grade for the same
cert. Double spend plus two concurrent writers to `ai_analysis` (last write wins, so a partial result
can overwrite a complete one).

_(Lower-severity items L1–L7 and a verified NOT-A-DEFECT list — including the correctly fail-closed
`admin-capability.ts`, `mount.ts` definer health, and the deliberately per-process connector claimant —
are recorded in the P1 archaeology notes.)_

---

## C8. CREDIT MODEL — THE PLAN IS WRONG IN THREE PLACES; THE CODE IS RIGHT

The canonical 0016/0017/0041-0043 accounting model is **real, coherent and well-defended. Reuse it
as-is.** Corrections to the plan, each verified:

### C8-1 — There is no cached available balance, and none must be added. PLAN CORRECTION

Plan §9 step 6 says _"decrement cached available"_. **`partner_wallets` has no balance column**
(`0016:30-44`), by explicit design (`0016:4-7`: _"the authoritative available balance is DERIVED …
there is NO mutable authoritative balance column and NO balance-update path"_).
Availability is the view `partner_credit_availability` (`0017:257-279`):
`available_balance = SUM(ledger.amount) − SUM(active reservations)`.
**Adding a cached column would create exactly the parallel balance model the plan forbids.**

### C8-2 — Reservation statuses are lowercase; the plan's SQL would match zero rows. PLAN CORRECTION

DB CHECK (`0017:51`): `'active' | 'consumed' | 'released' | 'expired'`. There is **no `'RESERVED'`**.
The plan's `UPDATE reservation SET status='CONSUMED' … WHERE status='RESERVED'` would affect 0 rows and
violate the CHECK.

### C8-3 — Migration 0057 does not exist. PLAN CORRECTION

`grep -rn "0057"` → zero hits repo-wide. Numbering jumps 0047 → 0073. There is no
purchase-permission migration and no `partner.credits.purchase` permission (only
`partner.credits.view`, `0034:65,109`).

### C8-4 — Exactly-once and CONSUMED→RELEASED are ALREADY DB-enforced. NOT-A-DEFECT

Do not rebuild. Existing guarantees: wallet `FOR UPDATE`
(`partner-credit-reservation-service.ts:273`); conditional UPDATE + rowcount check (`:604-613`);
`uq_partner_credit_reservation_events_terminal` (`0017:118-120`) — one terminal event per reservation,
the strongest single guarantee in the domain; trigger `0017:150-157` + CHECK `0017:57-62` blocking any
terminal→terminal transition; and trigger `partner_credit_ledger_preserve_active_reservations`
(`0017:194-227`) which makes it **impossible for any debit to drive available below active reserved**.

### C8-5 — `reconcileCreditReservations()` is written but NOT WIRED. HIGH — cheapest high-value fix

`server/partner/partner-credit-reservation-service.ts:873-986` implements six reconciliation checks
(`WALLET_BALANCE_MISMATCH`, `NEGATIVE_BALANCE`, `CONSUMED_EVIDENCE_MISSING`, `TERMINAL_EVIDENCE_MISSING`,
`DUPLICATE_TERMINAL_TRANSITION`, `CROSS_TENANT_OR_ORPHAN_REFERENCE`). It has **no scheduler, no route,
no alerting** — its only caller is a test. Compare `expireExpiredReservations`, which _is_ wired
(`server/index.ts:470-474`). The plan's mandatory reconciliation proof already exists in code and just
needs wiring. **Wire it; do not write a new one.**

### C8-6 — Consumption is recorded as `admin_adjustment`. MEDIUM

`0016:71-73` has no `'consumption'` entry type, so the −1 debit is written as `admin_adjustment`
(`partner-credit-reservation-service.ts:628`) — indistinguishable from a genuine negative adjustment or
refund. This has **already caused a reporting bug** (see the comment at `dashboard-service.ts:198-207`).
Any "credits used" figure must count `reservations WHERE status='consumed'`, never negative ledger rows.

### C8-7 — `uq_partner_credit_ledger_idem` is not tenant-scoped. MEDIUM

`(source, idempotency_key)` only (`0016:85-86`), inconsistent with every other idempotency index in the
domain, all of which lead with `tenant_id`. Cross-tenant key collision is possible.

### C8-8 — `stripe_webhook_events` is created at app boot, outside the migration journal. MEDIUM

`server/webhookHandlers.ts:25-32` `CREATE TABLE IF NOT EXISTS`. Not checksum-ratcheted, not journalled
— same class of problem as B-2 and the `cert_counter` note in B-4.

### C8-9 — "Credits" is overloaded across four unrelated systems. HIGH (footgun)

Partner Grading Credits (`partner_credit_ledger`) · Vault Club member credits (`member_credits`) · AI
Pre-Grade credits (`users.ai_credits_user_balance`) · Estimate credits (`estimate_credits`).
**`server/routes/submissions.ts` exports functions literally named `reserveCredit` (`:31`) and
`consumeReservedCredit` (`:64`) that operate on `member_credits`, not the partner wallet** — a direct
name collision with `partner-credit-reservation-service.ts`. A wrong import here silently moves the
wrong balance. Must be called out in the RTM and guarded in review.

### C8-10 — 0042 has a hard operator prerequisite and a shipping-order constraint. HIGH (P16)

`0042:47-65` requires `GRANT partner_credit_lifecycle_definer TO <deployment owner> WITH INHERIT TRUE;`
**or the migration fails**. `0042:25-36` warns that applying 0042 without 0043 leaves multi-card
connector cancellation broken. Rollback order is 0043 → 0042 → 0041. This must be in the rollout runbook.

---

## D. SECURITY / OPERATIONAL

### D-1 — `SCANNER_API_TOKEN` is a dead auth path still deployed as a production secret. MEDIUM

**Status:** OPEN
Exactly one server read (`server/lib/scanner-auth.ts:81`), double-gated at `:89-98` by
`NODE_ENV !== "production"` **and** `MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN === "1"`. It is consumed by
nothing in production and can be rotated out. Station auth is per-station **Ed25519** with the private
key in the macOS Keychain, failing closed rather than falling back to plaintext
(`scripts/scanner-app/lib/station-identity.js:23-25`).

### D-2 — CSRF origin check skipped on mere header presence. MEDIUM

**Status:** OPEN
`server/lib/csrf-origin.ts:72`: `if (req.headers["x-scanner-token"]) return next();` — **no value
check, no env gate**. Low practical exploitability (a browser cannot set a custom header cross-origin
without a passing CORS preflight), but it is defence-in-depth that outlived its reason. Related:
`server/routes.ts:11575` and `:11697` label the audit actor `"scanner-watcher"` purely on that header's
presence, so an admin can mislabel their own cert-image writes and soft-deletes.

### D-3 — The Scanner's "Fix missing images" button is dead in production. HIGH

**Status:** OPEN · **Phase:** P7
`server/lib/station-request-scope.ts:20-25` records the known consequence: an enrolled signed station
receives **403** on `/api/admin/orphan-certs` and related routes, because those routes address
certificates with no tenant predicate. The Electron app still ships the UI
(`scripts/scanner-app/renderer/index.html:152` → `scripts/scanner-app/main.js:457`). This is precisely
the FIX surface the programme must productise, and it is currently broken.

### D-4 — `last_seen_at` is not updated by the signed-request capture path. MEDIUM

**Status:** OPEN · **Phase:** P12
`server/partner/station-service.ts:461-468` updates `last_request_nonce`/`app_version`/`updated_at` but
**not** `last_seen_at`; only the telemetry path (`:565`) does. A station actively capturing but not
heartbeating will read as stale in the fleet view.

### D-5 — Station state columns unconstrained; approver columns unreferenced. LOW

**Status:** FOLLOW_UP
`capture_state` and `last_failure_code` have **no CHECK constraint** (free text), unlike every other
state column in `0045`. `approved_by`/`suspended_by`/`revoked_by` have **no FK** to any user table.
No `enrolled_at`; `partner_station_events.event_type` has no CHECK.

### D-6 — Station/scanner tables have no Drizzle coverage. MEDIUM

**Status:** FOLLOW_UP
`partner_stations`, `scanner_processing_jobs`, `scanner_evidence_staging` and
`scanner_capture_sessions` are raw-SQL surfaces explicitly excluded from the parity guard
(`tests/partner-schema-parity.test.ts:140-145`). **Nothing type-checks station SQL.**

### D-7 — Dead code that would issue divergent DDL. LOW

**Status:** FOLLOW_UP
`ensureScannerCaptureSchema()` (`server/scanner-capture-service.ts:64`) is exported with **zero callers
repo-wide** and would create the capture table without the FK or the 0075 index if ever wired up.
Also `nextCertOverride` (`scripts/scanner-app/lib/state.js:18,52`) is dead state named for exactly the
client-side MV assignment the plan forbids — recommend deletion.

---

## E. THINGS THAT ARE GENUINELY GOOD (do not "fix")

Recorded so later phases reuse rather than rebuild:

- **R2 finalisation verification is thorough** — `server/routes.ts:10409-10417` performs a **full
  read-back**, checking byte length _and_ SHA-256 against pre-declared values before promotion; plus
  TIFF re-decode, FRONT-before-BACK ordering, DPI/profile assertion and provenance matching
  (`server/scanner-evidence-finalisation.ts:44-64`). Concurrency uses `pg_advisory_xact_lock` +
  `FOR UPDATE` with stale-lease recovery.
- **Capture binding is server-owned.** The station never supplies cert/card/side and never chooses the
  R2 key (`server/scanner-evidence-staging-service.ts:126`).
- **Append-only evidence supersede chain** with `ON DELETE RESTRICT` (`0047:20-52`) — FIX can ride on
  this; do not fork it.
- **Migration runner** (`scripts/db/migrate.ts`) — journalled, checksummed, duplicate-number rejecting,
  dry-run by default, refuses to run through a pooler, fails closed on edited-after-apply.
- **The MV allocator is correctly gapless** (B-4).
- **Typecheck baseline at HEAD is clean** (`npm run check`, exit 0).

---

## F. BLOCKED — REQUIRES OWNER ACTION

### F-1 — Read-only production migration journal query. BLOCKED

Attempted `fly ssh console -a mintvault -C "<SELECT-only>"`; **denied by the permission classifier**.
Not retried, not circumvented. Needed because the controller states _"PRODUCTION SCHEMA IS
AUTHORITATIVE"_ and the global high-water mark is unproven without it.

### F-2 — Scale staging to 2 Fly Machines. BLOCKED (needs go-ahead)

Required for AT-23. Cheap and reversible, but it is an infrastructure change.

### OD-1′ — Fund Scanner packaging and signing. OWNER-DECISION

See A-3. Without a signed, notarised, self-contained installer, locked rule 20 cannot be met and the
pilot answer to _"can this Mac go in a shop tomorrow"_ is **NO on packaging grounds alone**.

---

## G. OWNER DECISIONS RAISED BY P6

### OD-7 — A walk-in card has no customer. OWNER-DECISION (built under a stated assumption)

**Status:** RECORDED · **Phase:** P6 · **Not blocking local work.**

The locked P6 flow is: authenticated operator + approved station → press NEW CARD → server
authorises one Card Job against one Grading Credit. There is no customer step in it, and a shop
taking a card over the counter has no customer record to attach.

The repo had no walk-in concept at all: the only creator of `partner_submission_cards` is the portal
wizard's `addCard()`, which requires an existing draft submission. `partner_submissions.customer_id`
and `service_tier_code` are both NULLABLE, so a customer-less submission is schema-legal — but the
connector's validation gate treats `customer_missing` (`connector-validation-service.ts:339-347`) and
`service_tier_missing` (`:371-379`) as **blocking**.

**Built assuming:** a Scanner-originated submission is a complete unit of work in its own right
(MV allocated, credit reserved, evidence captured) and is NOT eligible for connector import — it has
nothing left for the importer to do. One submission is created per NEW card, so `card_count` is
always 1 and the connector's per-submission arithmetic stays trivially consistent if the policy ever
changes.

**Owner question:** should a walk-in card capture a customer at intake (name/phone for collection),
or does the shop own that relationship entirely off-platform? If the former, this becomes an
additional optional step on the Scanner, not a change to the credit or MV model.

### OD-8 — MV allocation moved into the NEW transaction for the station path. PLAN CONFIRMED

**Status:** IMPLEMENTED · **Phase:** P6

Master plan §9 step 5 always specified allocating the MV inside the NEW-card transaction; P4
implemented the portal path only and deferred identity (`mvNumber: null`, "NULL until the connector
allocates"). For a station that deferral is not a display gap, it is a hard block in three places:
`scanner_capture_sessions.certificate_id` is NOT NULL with an FK; `partner_card_jobs` refuses
READY_TO_GRADE while `certificate_id IS NULL`; and the Scanner is specified to show "MV421 COMPLETE".

Implemented per the plan, reusing the existing row-locked `cert_counter` allocator — which is gapless
precisely because it is a locked row rather than a sequence, so a failed NEW returns its number
instead of burning it (proven: STATION-NEW4). The portal path is unchanged and still defers to the
connector.

---

## H. AG-1 / AG-2 / AG-3 — CLOSED, AND WHAT REMAINS

### AG-1 — multi-location. CLOSED (migration 0084)

`partner_locations` was multi-location capable since 0001; nothing could create a second row.
Added Super Admin create / rename / suspend / reactivate plus per-user location assignment, reusing
`partner_locations` and `partner_user_locations` — no second location model, no new table, no column.

**Two live defects found while auditing downstream code, both fixed:**

- `listFixQueue` filtered on `tenant_id` ALONE. With one location that was indistinguishable from
  correct; with two, a station at Rochester would have listed Bluewater's cards — work it cannot do
  (`authoriseFix` refuses a location mismatch) and should not see. Now confined to the station's own
  location, and only for a station: an org-wide dashboard user still sees the whole estate.
- `assertStartAllowed` never checked the LOCATION's status, so suspending one shop floor would not
  have stopped NEW there, and the organisation's own status cannot express "this branch only".

**REMAINING (API exists, console does not):** there is no Super Admin _UI_ for locations yet. The
routes are live and tested; the screen belongs with the P8 dashboard work.

### AG-2 — SCANNER_OPERATOR. CLOSED (migration 0085)

`partner.cards.scan` was doing three unrelated jobs: operate an approved station, enrol a new one,
and take an image out of grading. A least-privilege role was not expressible until those were
separated, so 0085 splits out `partner.stations.enrol` and `partner.cards.fix` and grants both to
**exactly** the three roles that already held `cards.scan` — OWNER, MANAGER, TECHNICIAN — so no
existing role gained or lost any real-world ability. Proven by a negative test per role.

SCANNER_OPERATOR holds three permissions and no more: `location.view`, `cards.view`, `cards.scan`.
Assignable from both the Super Admin console and the partner's own Staff area — a role nobody can be
given is not a role.

### AG-3 — step-up authentication. CLOSED for the partner surface (migration 0086)

One nullable `partner_sessions.last_step_up_at`, deliberately never backfilled: every session that
predates the column reads as un-proved, which is what fail-closed means here. The window (15 min) is
evaluated by PostgreSQL, so a skewed app clock cannot widen it.

Guarded: credits checkout, staff invite, role change, status change, session revocation. Reading the
staff list is not guarded — only mutations are.

**Deliberately NOT guarded: the capture path.** NEW and FIX must stay fast or a shop will work
around the friction by never signing out, which is strictly worse than the risk. Those routes
already carry two independent proofs per request — an approved station's Ed25519 signature and an
MFA-passed operator. A test pins this so a later "consistency" edit cannot slow the shop floor.

**REMAINING — SUPER ADMIN step-up (AG-3b).** Station approval/revocation, MFA reset, password-reset
initiation and audited credit grants are Super Admin actions running on the ADMIN session
(`req.session.authUserId`), not a partner session, so `partner_sessions.last_step_up_at` cannot
carry them. They need the equivalent stamp on the admin session subsystem. Today they are protected
by `requireSuperAdmin`, typed-confirmation dialogs and mandatory reasons — real controls, but not
re-authentication. Recorded rather than half-built.

### C-4 / rollback harness — CLOSED

`tests/partner-rollback.test.ts` could not execute. It drives the REAL runner over every migration
and aborted in `beforeAll`, reporting as "4 skipped" — indistinguishable from an ungated suite.
Three fixture gaps, each fixed with the real shapes rather than weakened SQL:

1. no `cert_counter` — 0076's precondition RAISEs without it;
2. `certificates` lacked `submission_item_id` and the origin-snapshot columns 0081 INSERTs;
3. **0076 REVOKEs the migrator's definer membership AND admin option as its final act**, exactly as
   0041 does, so 0081's `CREATE OR REPLACE FUNCTION` failed with "must be owner of function". The
   harness now issues the same owner-approved repair grant between 0076 and 0081 that it already
   issued between 0041 and 0042 — from the superuser client, because 0076 removed the migrator's
   ability to grant it to itself.

**All 19 critical partner suites are now green, rollback included.**
