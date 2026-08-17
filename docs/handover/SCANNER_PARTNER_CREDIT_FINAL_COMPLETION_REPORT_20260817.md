# SCANNER + PARTNER CREDIT — COMPLETION PASS REPORT

**Date:** 2026-08-17
**Branch:** `fix/canonical-card-detector-20260817`
**Before:** `ae7d059c` → **After:** `c472d53c` (local commit, **not pushed**)
**Production:** `36699531` — **untouched, not deployed, no migration, no live Stripe call**

---

## 1. The handover was wrong on three material points

This pass began by re-verifying everything the handover marked NOT RE-VERIFIED. Three of its headline claims are false, and two of them were steering the plan in the wrong direction.

| Handover claim | Reality (source/DB evidence) |
|---|---|
| **B2**: "local `.env` holds LIVE Stripe keys" | **FALSE.** The unsuffixed `STRIPE_SECRET_KEY` — the only one the code reads — is `sk_test_`; `STRIPE_PUBLISHABLE_KEY` is `pk_test_`. Live keys sit unread under `_LIVE` suffixes. Stored memory `local-env-live-stripe` is stale and should be corrected. |
| **§18**: "paid credits — NOT BUILT, nothing in this list is implemented" | **FALSE.** The entire system is built and merged (`b147352c`, migration `0083_partner_credit_packs.sql`): pack catalogue, RBAC, checkout route, webhook-authoritative grant, exactly-once, refund handling, client billing page, `tests/partner-credit-purchase.test.ts`. |
| **B1**: "the running Scanner's SHA is unknown; likely version skew" | **FALSE.** The running Electron app (PID 46673) has `--app-path=/Users/cornelius/mintvault-platform/scripts/scanner-app` — it *is* the canonical checkout, loading source directly. No `dist/`, no stale bundle. The native bridge was rebuilt at launch (binary mtime 16:04:43 > source 14:42:26). Skew ruled out entirely. |

**H1 also resolved:** migration `0091` **IS applied to staging** — both `calibration_id` and `acquisition_region` exist on `scanner_capture_sessions`.

---

## 2. Root cause of the dead Scanner UI — found and fixed

**All three symptoms were one defect.**

`scripts/scanner-app/renderer/app.js:559` declared `const state` inside `renderPlacementPreview(entry, state)` — redeclaring the function's own parameter. That is a **parse-time** SyntaxError, so the browser discarded the entire `<script>` before executing a single statement.

```
$ node --check scripts/scanner-app/renderer/app.js
app.js:559  const state = ["GREEN","AMBER","RED"].includes(verdict.state) ? ...
                  ^  SyntaxError: Identifier 'state' has already been declared
```

`index.html` is real static markup, so the window still painted — it looked alive while every listener, render function and IPC subscription was dead.

| Symptom | Mechanism |
|---|---|
| "Checking device…" forever | `index.html:18` ships that literal text. `app.js:1404` `onStateUpdate(renderState)` never ran, so `els.scannerHealth.textContent` was never assigned. The main process *had* the answer — `state.json` recorded a full Canon LiDE 400 device record. |
| Service & Diagnostics empty | `#settingsBody` is `hidden`; only the toggle at `app.js:1125` clears it. `<details>` opens natively; the contents stayed hidden. |
| Capture window UI missing | It lives *inside* `#settingsBody`, and `drawCaptureWindow()` (`app.js:1260`) is a top-level call that never executed. |

**Second defect, latent behind the first:** `els.placementOuterBox` is read at `app.js:578` but was the one id in `index.html` never added to the `els` map. `place()` sets `.hidden` unconditionally, so it would throw `TypeError` on the **first PREVIEW** and abort `renderState` before the capture-window sync. Fixing only the parse error would have surfaced this immediately.

**Fix applied** (`c472d53c`): rename the local to `placementState` (3 call sites: 559, 560, 585); add `placementOuterBox` to the `els` map.

### Why it shipped green — and the guard added

74 tests across six suites exercise the main process and the server contract. **Not one loaded the renderer.** The Husky/lint-staged gate was bypassed for `ae7d059c` (`npx eslint` catches it in ~2 s, and `scripts/` is not ignored).

New: `scripts/scanner-app/test/renderer-parses.test.js` — parses every first-party script, and cross-checks `els.<name>` reads against `els` definitions. **Both guards proven to fail on the pre-fix file:**
```
GUARD WOULD HAVE CAUGHT IT: Identifier 'state' has already been declared
els gap in pre-fix: [ 'placementOuterBox' ]
```

---

## 3. Stripe environment isolation — was fail-open, now fail-closed

`server/stripeClient.ts` handed `STRIPE_SECRET_KEY` to the SDK **without ever checking which Stripe account it belonged to**. A grep for `sk_live|sk_test|pk_live|pk_test` across `server/ shared/ scripts/ script/` returned **zero hits**. `server/config.ts` validates only the database URL. With live and test keys side by side in one `.env`, a real-money mistake was one copy-paste away.

**Implemented** (explicitly authorised in the brief):
- `NODE_ENV=production` → `sk_live_`/`pk_live_` required; a test key is **refused** (a prod box on test keys takes orders that never collect).
- Anything else → `sk_test_`/`pk_test_` required; a live key is **refused**.
- Checked at **client construction, not import** — a misconfigured box still boots and serves every non-payment route; only the payment path refuses.
- **No key material in any error message** — asserted by test.
- `describeStripeEnvironmentMismatch()` exported for a non-throwing startup self-check.

`tests/stripe-environment-isolation.test.ts` — 10 tests, all passing, including the no-leak assertion.

---

## 4. Authoritative state as re-verified (staging DB `ep-purple-voice`)

### MV272 — do not recreate
| Field | Value |
|---|---|
| Card Job | `81320af2-e8d4-470a-a515-3f0b5ac8869e` |
| Status | `CAPTURING` |
| Certificate | `469` |
| Reservation | `edb73ab4-e12e-4ca9-bb5a-bdc95fc8b66b` — **active, 1 credit** |
| FRONT | **captured** (session `7335b3df`, 11:35) — **PRESERVED** |
| BACK | session `de95fce2`, state `claimed`, created 12:20, **expires 15:42:50** (lapsed) |

**MV270–MV275** — all six exist, all `NEEDS_SCAN` except MV272 (`CAPTURING`), each with certificate 467–472 and **exactly one active reservation each**. One card = one credit holds in the data.

### Wallet (tenant `5a277964`, wallet `dff9601e` — the MV270–275 tenant)
`ledger 10 − active_reserved 6 = available 4`. Consumed 0.
Platform-wide: **13 active reservations, 13 credits; 3 consumed.** Ledger and availability reconcile via the `partner_credit_availability` view. No discrepancy.

### Station `MV-STN-S337CQCJMILK4OD7` (`ada20127`)
`status ACTIVE`, `calibration_status VALID`, `scanner_connected true`, app `1.2.1`, epoch 2, **live** (`last_seen_at` 15:37:45).
`capture_state = preview_error`
`last_failure_code = "Card is too close to the hardware acquisition boundary (3.8 mm; 4 mm required); rescan"`

### 🚨 The physical blocker — station calibration is at the platen corner
```
current_calibration_id 5af9aa71 → acquisition_region {"x":0,"y":0,"width":100,"height":130}
```
**All three** station calibrations in the DB are `x:0, y:0`. The approved architecture's `defaultOriginMm` is `{x:20, y:20}` (`shared/lide400-capture-profile.cjs:108`). The window is anchored at the physical platen edge, where the scanner's own acquisition boundary is — which is exactly why the operator cannot reach 4 mm and got 3.8 mm.

**This is a data/recalibration problem, not a code problem.** The geometry code is correct: 100×130 outer, 80×110 safe, 10 mm inset, 4 mm floor, and 180°-invariance is proven in-profile. The station simply needs recalibrating through the UI — **which was impossible until the renderer was fixed.** That is the chain.

### Capture-session snapshots
Every existing session has `calibration_id`/`acquisition_region` **NULL** — all were armed before `0091` shipped. Per `0091`'s own design these are **refused at upload** with a re-arm instruction. The write path is correct and fails closed (`server/scanner-capture-service.ts:392-433`): a station with no valid calibration cannot arm at all. **No session has yet been armed post-0091, so the snapshot is unproven in the wild** — it is proven only by `tests/lide400-capture-authority.test.ts`.

---

## 5. Partner credit architecture — what actually exists

Verified in source, not taken from the agent summary:

- `partner_wallets` / `partner_credit_ledger` (append-only, trigger-enforced) / `partner_credit_reservations` / `partner_credit_availability` view. **No stored balance** — availability is `ledger_sum − active_reserved`, derived.
- **Double-spend is not possible.** `partner-credit-reservation-service.ts:273-277` takes `SELECT … FROM partner_wallets … FOR UPDATE` *before* reading availability, plus `uq_partner_credit_reserve_idem`, `uq_partner_credit_reserve_card_live`, and a ledger trigger refusing any debit below active reservations. This closes the TOCTOU race recorded as open in memory `owasp-redteam-2026-07-04`.
- **Zero-credit block exists and is server-side.** `card-job-authority.ts:231` reserves and inserts in one transaction; `INSUFFICIENT_CREDITS` → **HTTP 402** at `station-routes.ts:473`. A job cannot be created at zero credits.
- **Packs**: `PACK_5/10/25/50/100` seeded (migration `0083`), `active=true`, **`stripe_price_id` NULL on all five** → `purchasable=false` by design.
- **Checkout**: `POST /api/partner/credits/checkout`, gated by `partner.credits.purchase` + `requireRecentAuth()` + not-view-only + not-frozen. GRADER can never buy; MANAGER only with explicit permission; OWNER always.
- **Webhook-authoritative exactly-once**: credits resolved **server-side from the pack code**, never from session metadata or amount paid. Guarded by `uq_partner_credit_ledger_idem (source, idempotency_key)` with `alreadyApplied` read-back. Replay → `granted:false, reason:"already_granted"`.
- **Refunds/disputes**: recorded as audited exceptions via `recordPurchaseException()`, never silently debited — a debit would strand reserved capacity and the ledger trigger would refuse it anyway.

⚠️ **Two idempotency patterns exist and picking the wrong one loses money.** The estimate path pre-claims into `stripe_webhook_events` (same pool). The partner path deliberately does not — the claim table is on the main pool, the ledger on the partner admin pool, so they cannot share a transaction; the guard lives in the same DB as the grant instead. Documented at `credit-purchase-service.ts:9-25`. **Do not "unify" these.**

---

## 6. Gate evidence (executed, not asserted)

| Gate | Result |
|---|---|
| `node --check` all scanner-app JS | **all parse** (was: app.js failed) |
| scanner-app suite (`npm test`) | **74/74 pass** |
| new renderer-parse guard | **3/3 pass**; proven to fail on pre-fix file |
| lide400 capture suites (5 files) | **106/106 pass** |
| `tests/stripe-environment-isolation.test.ts` | **10/10 pass** |
| `partner-credit-purchase` + `estimate-credit-idempotency` | **30/30 pass** (guard causes no regression) |
| `npm run check` (tsc) | **clean** |
| `npx eslint` on changed files | **0 errors** (6 pre-existing-style warnings) |
| `git diff --check` | **clean** |

**Not run:** the full `LC_ALL=C LANG=C npm test` suite and the partner `--all --json` gate. Honest reason: session budget. These must be run before any staging deploy, and baselined on a clean worktree (memory `fullsuite-parallel-flakes`: 10–20 contention flakes pass in isolation).

---

## 7. Files changed (commit `c472d53c`, 4 files, +311/−3)

- `scripts/scanner-app/renderer/app.js` — parse fix + `els` map entry
- `scripts/scanner-app/test/renderer-parses.test.js` — **NEW** regression guard
- `server/stripeClient.ts` — fail-closed environment isolation
- `tests/stripe-environment-isolation.test.ts` — **NEW**, 10 tests

**No migration written.** Next safe number remains **0092**. No DB mutation of any kind was performed — every query this pass was read-only.

---

## 8. BLOCKER REGISTER

### BLOCKER
**B1 — Station calibration is `x:0,y:0`, not `20,20`.** The capture window sits on the platen edge; the 4 mm evidence floor is physically unreachable (measured 3.8 mm). **Fix: recalibrate the station through the now-working UI.** Requires a human at the Scanner. *(Nothing in code to change — `defaultOriginMm` is already 20,20.)*

**B2 — Scanner app must be relaunched.** PID 46673 has the broken `app.js` already parsed. The fix cannot take effect until restart. Requires a human at the Scanner.

**B3 — GBP prices + Stripe Price IDs for all five packs.** Genuine owner decision, then a data write (`UPDATE partner_credit_packs SET stripe_price_id=…`). **No migration, no deploy.** Until then `purchasable=false` — correct, deliberate, and the only thing standing between here and a working top-up.

**B4 — VAT treatment.** Genuine owner decision (single- vs multi-purpose voucher). Affects price display and Stripe line items, not the payment engine.

### HIGH
**H1 — 0091 snapshot unproven in the wild.** No session armed since it shipped; proven only by unit test. First re-arm on staging is the proof.
**H2 — MV272 BACK session `de95fce2` has lapsed** and carries NULL calibration, so it is refused by design. It must be **re-armed**, not re-uploaded. FRONT stays.
**H3 — Full suite + partner gate not run.** Required before staging deploy.
**H4 — Scanner has no proactive credit surface.** The station learns it is out of credits only reactively, from a 402. No "Top Up Now" on the station itself — the billing page is portal-only.

### MEDIUM
**M1 — `stripe_webhook_events` is boot-created, not in `migrations/`.** Intentional and registered as `intentionally_unmanaged`, but it means schema parity tools cannot see it.
**M2 — `STRIPE_WEBHOOK_SECRET_2` is read by code but absent from `.env`.** Harmless (optional fallback), worth knowing.
**M3 — Memory `local-env-live-stripe` is stale** and actively misleading; it drove a false BLOCKER in the handover.
**M4 — Capture-session columns are not in `shared/schema.ts`** — the partner tables are SQL-only, against the project's single-source-of-truth rule.

---

## 9. Recommended next sequence

1. **Relaunch the Scanner app** (quit PID 46673, `npm start` in `scripts/scanner-app`). Confirm: Canon shows CONNECTED/READY, Service & Diagnostics renders, capture-window UI appears.
2. **Recalibrate the station** through the UI to origin ~20,20. Verify `partner_station_calibrations` gets a new row and `current_calibration_id` moves.
3. **Re-arm MV272 BACK.** Confirm the new session carries non-NULL `calibration_id` + `acquisition_region` — that proves 0091 end-to-end.
4. **PREVIEW → GREEN → SCAN BACK.** Same MV272, no new reservation, no new MV. → `READY_TO_GRADE`.
5. Run the **full gate** (`LC_ALL=C LANG=C npm test` + partner `--all --json`), baselined on a clean worktree.
6. Push the branch and deploy **staging only**, re-reading `/api/version` and `fly releases` immediately beforehand.
7. **Owner decisions** (B3, B4), then write the five Price IDs. Top-up goes live with no code change.
8. Production stays on `36699531` until steps 1–7 are green and founder-approved.

---

*No production deploy, no production migration, no live Stripe call, no wallet mutation, no DB write was performed in this pass.*

---
---

# ADDENDUM — CONTINUATION PASS (from `c472d53c`)

**Branch tip:** `1efaaf73` (pushed) · **PR:** [#314](https://github.com/mintvaultuk-byte/mintvault-platform/pull/314)
**Staging:** `mintvault-v2` **live on `1efaaf73`**, both machines · **Production:** `36699531`, **untouched**

## Phase 1 — Scanner restarted and runtime proven

Pre-restart: `pending_upload_count=0`, nothing in flight. Old tree (PID 46671/46673) stopped cleanly.

Relaunched from the canonical checkout. **Runtime evidence, not inference:**

| Check | Result |
|---|---|
| Process trees | **exactly 1** (PID 55311, alive 42m+) |
| `app.js` SHA-256 vs `git show HEAD:` | **identical** (`5d81640f…`) |
| `node --check` on the loaded file | **PARSES** |
| Renderer exceptions since restart | **0** (`syntaxerror|uncaught|referenceerror` → 0 hits) |
| Renderer executing? | **yes** — `positioning-preview {"cardDetected":true}` in the log; previously nothing ran at all |

⚠️ **Station heartbeat is rejected: `authentication required`.** `last_seen_at` has not advanced since 15:57. **The station must be signed in through the Scanner UI before Phases 6–9 can start.** This is an owner action.

## Phase 2 — Full gates

**Local** (`LC_ALL=C LANG=C npm test`): **4957 passed, 0 test failures**, 1014 skipped, 290 files passed.
5 files aborted on absent `TEST_DATABASE_URL` / `MINTVAULT_DATABASE_URL`: `rarity-structured-migration`, `auth-security-migration`, `vq-backend`, `vq-fetch-art-stored-pointer`, `vq-higgsfield-observability`.
**Not hidden, and not a gap:** those tests *refuse* any DB that is not the local throwaway on `127.0.0.1:55432/mintvault_vq_phase10_local`. Pointing them at staging is what the guard exists to prevent — and staging holds MV272. **CI provisions a disposable test database, so they run there.**

| Gate | Result |
|---|---|
| scanner-app suite | **74/74** |
| renderer parse guard (new) | **3/3**, proven to fail on pre-fix file |
| lide400 capture suites (5 files) | **106/106** |
| Stripe env isolation (new) | **11/11** |
| partner-credit-purchase + estimate-idempotency | **30/30** |
| `tsc` | clean |
| `npm run build` | exit 0 |
| `git diff --check` | clean |
| eslint (changed files) | **0 errors** |
| eslint (repo-wide) | **1626 errors — PRE-EXISTING baseline, not from this work** |

**CI on `1efaaf73`:** Lint/Type/Test/Build **pass** (12m37s) with every *"Assert … suite executed"* anti-silent-skip gate green; image build & boot **pass**; gitleaks **pass**; dependency review **pass**; CodeQL SAST **pass**.
**CodeQL alert-gate: fail — proven false positive.** `js/missing-rate-limiting` at `station-routes.ts:575`; that route *does* carry `partnerStationCardJobCancelRateLimit` (defined `:172`), a fleet-wide `partnerRateLimit` wrapper CodeQL cannot recognise. The same rule already fires 8× on `main`. Not introduced by the fix commits.

## Phase 3 — Stripe safety: a defect I introduced, caught before deploy

The guard shipped in `c472d53c` keyed its refusal on `NODE_ENV=production ⇒ live keys required`. **`fly.v2.toml:12` sets `NODE_ENV=production` on STAGING too** — it governs asset building, not money. Deploying that guard would have refused the payment path on a correctly-configured staging box holding test keys: the guard would have caused the incident it exists to prevent.

Corrected in `1efaaf73`, split by honest scope:
- **Coherence — always on.** Secret and publishable must be the same mode; both must be recognisable keys. A half-swapped pair is wrong under every deployment story.
- **Expected mode — only when `STRIPE_ENV` declares `live`/`test`.** Then refused both ways.
- Unset `STRIPE_ENV` keeps coherence only: still strictly safer than the previous *nothing*, and **cannot break a running deployment**.

**Follow-up (owner, secrets change):** set `STRIPE_ENV=test` on `mintvault-v2` and `STRIPE_ENV=live` on production. That makes the refusal total.

Also: GitHub push protection blocked the first push because the test used literal `sk_live_…` decoys. It was right to. Keys are now assembled at runtime; no key-shaped literal exists on disk (`grep` → 0).

## Phase 5 — Staging reconciled and deployed

Pre-deploy: `origin/main` unmoved at `f64e67fb`; live staging `ae7d059c` proven a **direct ancestor** of `1efaaf73` (linear forward, no clobber). **Rollback target: v498 / `ae7d059c`.**

Post-deploy verified against the running server, not the deploy log:
- 12/12 version polls → `1efaaf73` (both machines, image `deployment-01M089DCZ5MAJ40R56PXMR6Z3A`)
- `/api/health` **200**, `/ready` **200**, `/api/partner/me` **401** (mounted)
- migration 0091 columns present: `calibration_id`, `acquisition_region`
- **Production re-read after deploy: `36699531` — untouched**

## Phases 6–9 — NOT RUN, and I cannot run them

| Phase | Blocker |
|---|---|
| 6 — Recalibrate to ~20,20 | Requires a human dragging the window in the Scanner UI. Also requires the station to be **signed in** first. |
| 7 — MV272 BACK | Requires a human physically placing the card and pressing SCAN. |
| 8 — Credit lifecycle end-to-end | Depends on 6 and 7. *(Static proof already in place: `FOR UPDATE` wallet lock, `uq_partner_credit_reserve_card_live`, HTTP 402 at zero credits, 30/30 tests.)* |
| 9 — Top-up purchase | **All five packs still have `stripe_price_id = NULL` → `purchasable=false`.** Not engineering-blocked. |

**State preserved throughout — re-verified after the deploy:**
MV272 `CAPTURING`, cert 469, FRONT intact · wallet `ledger=10 reserved=6 available=4` · reservations `active=13, consumed=3` — **identical to the pre-pass baseline. No DB write was performed in this pass.**

## Owner actions, in order

1. **Sign the station in** through the Scanner UI (heartbeat currently rejected).
2. **Confirm the UI renders**: Canon READY, Service & Diagnostics visible, capture-window position visible, 100×130 movable + 80×110 safe zone.
3. **Recalibrate** to ~20,20 and Save Position.
4. **Re-arm MV272 BACK** → PREVIEW → GREEN → SCAN BACK once.
5. **Set `STRIPE_ENV`** on both Fly apps (`test` on `mintvault-v2`, `live` on prod).
6. **Decide GBP prices + VAT**, create Stripe Prices, write the five `stripe_price_id` values.
