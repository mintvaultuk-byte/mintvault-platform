# HANDOVER — MintVault Scanner + Partner Credit

**Written:** 2026-08-17
**Reason:** context exhaustion. Implementation stopped deliberately. No further code, deploy, migration, scan or wallet change made after this document was started.

---

## 0. HONESTY STATEMENT — read this first

Everything in sections marked **VERIFIED** was re-read from git, the filesystem, or a live `/api/version` call while writing this document.

Everything marked **NOT RE-VERIFIED** is either (a) live database or live-station state that requires a DB/API query I was instructed not to run, or (b) session-context that was not re-provable from disk at write time. **Do not treat NOT RE-VERIFIED lines as fact.** Each one carries the exact command to establish it in the next session. This is deliberate: a handover that guesses is worse than one that says "go and look".

---

## 1. Canonical repo/worktree paths and SHAs — VERIFIED

**Canonical working repo:** `/Users/cornelius/mintvault-platform`

| Item | Value |
|---|---|
| Branch | `fix/canonical-card-detector-20260817` |
| HEAD SHA | `ae7d059c6dc3dad299e0d270ac71becbbfa993a5` (`ae7d059c`) |
| Working tree | **CLEAN of tracked changes** — only untracked files (below) |
| `main` (local) | `3d6fa14e` (2026-08-16) |

Untracked (not part of this work, do not commit blind):
```
.claude/launch.json
.claude/skills/mv-1996-britain-world/
.claude/skills/mv-physical-reality-qc/
.claude/skills/mv-reference-controller/
.claude/skills/mv-seedance-25-director/
docs/partner/SUPER_ADMIN_PARTNER_NETWORK_CONSOLIDATION_PLAN.md
docs/story-universe/
```

Recent commits on the branch (newest first):
```
ae7d059c feat(scanner): a movable capture window, a per-side placement gate, and server-owned geometry
171c06bc fix(scanner): arm the outstanding side after an accepted capture
2979e9da Merge remote-tracking branch 'origin/main' into fix/canonical-card-detector-20260817
50e6ad80 fix(evidence): one canonical card detector — a global bounding box is not a card
f64e67fb Merge PR #313 feat/adaptive-rail-width-20260817
1a400d70 fix(evidence): count COLOUR channels (Canon RGB+alpha master is RGB evidence)
d9e4cf05 fix(capture): re-arming a station's own live target is a replay, not a second session
d1a8b324 fix(admin): delete the guessed 72px header offset, measure it instead
```

---

## 2. Staging — VERIFIED

```
https://mintvault-v2.fly.dev/api/version
→ {"build":"MV-P5-20260225-nohalf","commit":"ae7d059c","timestamp":"2026-08-17T15:26:08Z"}
```

**Staging is running `ae7d059c` — identical to the local branch HEAD.** Staging app = `mintvault-v2`, config `fly.v2.toml` (per `scripts/safe-deploy.sh`).

**Migration high-water on disk:** `0091_capture_session_calibration_snapshot.sql` (110 files in `migrations/`). Previous high-water was `0090_lineage_convergence_scanner.sql`.

⚠️ There is **no `migrations/meta/_journal.json` in this checkout** — the applied-state high-water on each database can only be read from the database itself, not from disk. Next session, read it per-DB before any migration decision (see [migration-lineage-fragmentation] memory: three lineages have collided at 0045–0048 historically).

**Staging applied state for 0091: NOT RE-VERIFIED.** Since staging is serving `ae7d059c`, which is the commit that requires the columns, the strong inference is that 0091 was applied to staging — but infer nothing. Confirm with:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='scanner_capture_sessions'
  AND column_name IN ('calibration_id','acquisition_region');
```

---

## 3. Production — VERIFIED, UNTOUCHED

```
https://mintvaultuk.com/api/version
→ {"build":"MV-P5-20260225-nohalf","commit":"36699531","timestamp":"2026-08-17T15:25:43Z"}
```

**Production is on `36699531`** — the Gold Star rarity repair release (v1084, shipped 2026-08-15, see memory `gold-star-rarity-repair`). This is **before** every commit in this scanner/detector work.

**Production is untouched by today's work.** No deploy, no migration, no wallet change, no data change was made to production. Migration `0091` is **NOT applied to production** and must not be, until the branch is reviewed and released.

⚠️ Per memory `prod-lineage-clobber-20260811`: `safe-deploy` GUARD 1 checks `origin/main`, **not the live release**. Re-read `fly releases` and `/api/version` immediately before any future prod deploy — prod has moved under concurrent sessions before.

---

## 4. Running Scanner checkout / SHA — PARTIALLY VERIFIED

- The Scanner Electron app source lives **inside this repo** at `scripts/scanner-app/` (renderer `app.js`, `index.html`, `styles.css`, `preload.js`, native bridge `native/mintvault-lide-bridge.m`).
- Operator tooling lives at `/Users/cornelius/.mintvault-scanner-tools/` — `status.1s.sh` (SwiftBar/xbar status item), `switch-env.sh`, `guide-visible.json`, `guide-window-position.json`. **These files were last modified 2026-05-08 and are not part of today's work.**
- **The SHA the physically-running Scanner Mac is built from is NOT RE-VERIFIED.** The Scanner does not report a build commit in anything readable from this machine at write time.

**Next session, establish it first — this is a BLOCKER for interpreting any Scanner symptom:**
```bash
bash /Users/cornelius/.mintvault-scanner-tools/switch-env.sh   # shows target env
```
and on the Scanner Mac itself, identify the checkout directory and run `git rev-parse HEAD` there. **Do not debug the Scanner UI until you know which commit it is running.** Section 12's symptoms are consistent with a Scanner running an *older* build against an `ae7d059c` server.

---

## 5. Uncommitted Scanner changes — VERIFIED: NONE

**All Scanner work is committed.** `git status --porcelain` shows no modified or staged tracked files. The scanner changes are in commits `50e6ad80`, `171c06bc`, `ae7d059c` on `fix/canonical-card-detector-20260817`.

**Pushed?** The branch has a remote PR lineage (PR #313 merged into it via `f64e67fb`), and **staging is serving `ae7d059c`**, which means `ae7d059c` reached the deploy path. Treat the branch as pushed, but confirm with `git status -sb` / `git log origin/fix/canonical-card-detector-20260817 -1` before assuming.

Files changed across the last three commits (`git diff --stat HEAD~3..HEAD`), 40 files / +4683 / −148:

**Server**
- `server/lib/lide400-capture-authority.ts` (NEW, 196 lines)
- `server/lib/lide400-card-frame.ts`
- `server/lib/lide400-profile.ts`
- `server/scanner-capture-service.ts`
- `server/scanner-evidence-finalisation.ts`
- `server/routes.ts`

**Shared**
- `shared/lide400-capture-profile.cjs` (NEW, 335 lines) + `.d.cts` (113)
- `shared/rail-width.ts` (NEW, 192)

**Scanner app**
- `scripts/scanner-app/renderer/app.js` (+286), `index.html` (+44), `styles.css` (+144), `preload.js`, `native/mintvault-lide-bridge.m`

**Migration**
- `migrations/0091_capture_session_calibration_snapshot.sql` (NEW)

**Tests (all NEW unless noted)**
- `tests/lide400-capture-authority.test.ts` (285)
- `tests/lide400-capture-corpus.test.ts` (612)
- `tests/lide400-capture-profile.test.ts` (262)
- `tests/lide400-placement-approval.test.ts` (100)
- `tests/lide400-canonical-detector.test.ts`
- `tests/adaptive-rail-width.test.ts` (251)
- `tests/fixtures/lide400/` — `manifest.json`, `mv272-front-accepted.jpg`, `mv272-back-rejected.jpg`, `corner-registered-3mm.jpg`, `widest-card.jpg`
- modified: `scripts/scanner-app/test/server-client-tiff-upload.test.js`, `scripts/scanner-app/test/station-active-card.test.js`, `tests/partner-card-job-grading-bridge.test.ts`, `tests/partner-schema-parity.test.ts`, `tests/helpers/partner-realistic-db.ts`

---

## 6. MV272 authoritative state — NOT RE-VERIFIED

**I will not state MV272's live state from memory.** What IS verified is that MV272 is the corpus anchor for the detector work: two committed fixtures exist at
- `tests/fixtures/lide400/mv272-front-accepted.jpg`
- `tests/fixtures/lide400/mv272-back-rejected.jpg`

The fixture names are themselves the recorded finding: **MV272 FRONT was accepted as evidence; MV272 BACK was rejected.** That asymmetry is what commit `171c06bc` ("arm the outstanding side after an accepted capture") addresses.

Establish the authoritative state next session with these reads (all read-only):

```sql
-- certificate / MV
SELECT id, cert_id, status, grade, created_at FROM certificates WHERE cert_id = 'MV272';

-- capture sessions incl. the new 0091 columns
SELECT id, station_id, side, state, calibration_id, acquisition_region, created_at
FROM scanner_capture_sessions
WHERE certificate_id = (SELECT id FROM certificates WHERE cert_id='MV272')
ORDER BY created_at;

-- evidence rows
SELECT id, side, accepted, rejection_reason, created_at
FROM scanner_evidence WHERE certificate_id = (SELECT id FROM certificates WHERE cert_id='MV272');

-- card job
SELECT id, state, created_at, updated_at FROM partner_card_jobs
WHERE certificate_id = (SELECT id FROM certificates WHERE cert_id='MV272');

-- reservation
SELECT * FROM partner_credit_reservations
WHERE card_job_id IN (SELECT id FROM partner_card_jobs
  WHERE certificate_id = (SELECT id FROM certificates WHERE cert_id='MV272'));
```
(Table names above are the expected ones; if any differs, resolve from `shared/schema.ts` rather than guessing.)

---

## 7. Wallet totals and active reservations — NOT RE-VERIFIED

Live figures were not re-queried. Read them before touching anything credit-related:

```sql
SELECT partner_id, balance, updated_at FROM partner_wallets;
SELECT id, partner_id, card_job_id, amount, state, created_at, expires_at
FROM partner_credit_reservations WHERE state = 'active' ORDER BY created_at;
SELECT partner_id, SUM(delta) FROM partner_wallet_ledger GROUP BY partner_id;
```
**Reconcile ledger sum against wallet balance.** If they disagree, that is a BLOCKER and nothing else in the credit area should proceed until it is explained.

---

## 8. MV270–MV275 individually — NOT RE-VERIFIED

Only MV272 has committed fixture evidence. The other five were not re-provable at write time. Obtain the whole band in one read:

```sql
SELECT c.cert_id, c.status, c.grade,
       (SELECT count(*) FROM scanner_capture_sessions s WHERE s.certificate_id=c.id) AS sessions,
       (SELECT count(*) FROM scanner_evidence e WHERE e.certificate_id=c.id AND e.side='front') AS front_ev,
       (SELECT count(*) FROM scanner_evidence e WHERE e.certificate_id=c.id AND e.side='back')  AS back_ev
FROM certificates c
WHERE c.cert_id IN ('MV270','MV271','MV272','MV273','MV274','MV275')
ORDER BY c.cert_id;
```

---

## 9. Station identity / status / calibration — NOT RE-VERIFIED

```sql
SELECT id, name, status, last_heartbeat_at, current_calibration_id FROM partner_stations;
SELECT id, station_id, acquisition_region, valid_from, valid_to, created_at
FROM partner_station_calibrations ORDER BY created_at DESC LIMIT 10;
```
`current_calibration_id` is load-bearing for the whole 0091 design: **arming a side resolves the station's current VALID calibration and snapshots its `acquisition_region` onto the session.** If a station has no valid calibration, arming must fail — verify that behaviour rather than assuming it.

---

## 10. Migration 0091 — VERIFIED (file), NOT RE-VERIFIED (applied state)

**File:** `migrations/0091_capture_session_calibration_snapshot.sql` (2,606 bytes, created 2026-08-17 15:13).

**What it does — additive only:**
```sql
ALTER TABLE scanner_capture_sessions
  ADD COLUMN IF NOT EXISTS calibration_id uuid,
  ADD COLUMN IF NOT EXISTS acquisition_region jsonb;
```
Plus two `COMMENT ON COLUMN` statements. **No drops, no rewrites, no data change.**

**Design decisions recorded in the file header (preserve these):**
- **No foreign key to `partner_station_calibrations`, on purpose.** A `RESTRICT` would make recalibration fail while an old capture still referenced the previous calibration; a `CASCADE` would erase evidence provenance.
- **Snapshot, not lookup.** A capture is judged against the geometry it was armed under. Recalibration applies to *later* sessions and never silently re-interprets a scan that already physically happened.
- **Sessions armed before this migration carry NULL and are REFUSED at upload** with an instruction to re-arm. This is deliberate: "we do not know which rectangle that station used" and "assume the standard one" are different statements, and only the first is true.

**Applied state:** staging — inferred applied (serving `ae7d059c`) but **confirm via `information_schema`**. Production — **NOT applied, and must not be applied** until release.

---

## 11. Scanner defects found today — VERIFIED from commits

Each is a landed commit with tests. "Fixed" below means *committed and covered by a test*, not *proven on the physical Scanner*.

### D1 — A global bounding box is not a card (canonical detector)
- **Commit:** `50e6ad80` `fix(evidence): one canonical card detector — a global bounding box is not a card`
- **Root cause:** evidence validation derived the card rectangle from a *global* bounding box over the whole scan. Any non-background content anywhere on the platen (platen edge artefacts, debris, the guide overlay) inflated the box, so the "card" measured was not the card. There was also more than one detector implementation in play, so different code paths disagreed about the same scan.
- **Status:** FIXED — one canonical detector.
- **Files:** `server/lib/lide400-card-frame.ts`, `server/lib/lide400-profile.ts`, `shared/lide400-capture-profile.cjs` (+ `.d.cts`)
- **Tests:** `tests/lide400-canonical-detector.test.ts`, `tests/lide400-capture-corpus.test.ts` (612 lines, runs the fixture corpus incl. MV272 front/back and `corner-registered-3mm.jpg`, `widest-card.jpg`)

### D2 — Colour-channel miscount rejected genuine RGB evidence
- **Commit:** `1a400d70` `fix(evidence): count COLOUR channels, so the Canon's real RGB+alpha master is RGB evidence`
- **Root cause:** the RGB check counted *all* channels, so the LiDE 400's genuine RGB **+ alpha** master read as 4 channels and failed an "is this colour evidence" gate.
- **Status:** FIXED — counts colour channels, ignoring alpha.
- **Files:** `server/scanner-evidence-finalisation.ts`
- **Tests:** covered in the capture/evidence suites above.

### D3 — Re-arming a station's own live target counted as a second session
- **Commit:** `d9e4cf05` `fix(capture): re-arming a station's own live target is a replay, not a second session`
- **Root cause:** re-arm did not distinguish "this station re-arming the target it already owns" (a replay) from "a second, competing capture session". Result: spurious concurrent-session state.
- **Status:** FIXED.
- **Files:** `server/scanner-capture-service.ts`
- **Tests:** `scripts/scanner-app/test/station-active-card.test.js` (modified, +101)

### D4 — The outstanding side was not armed after an accepted capture
- **Commit:** `171c06bc` `fix(scanner): arm the outstanding side after an accepted capture`
- **Root cause:** accepting FRONT did not arm BACK, so the operator had no armed target for the second side. **This is the direct cause of the MV272 front-accepted / back-rejected asymmetry.**
- **Status:** FIXED.
- **Files:** `server/scanner-capture-service.ts`, `scripts/scanner-app/renderer/app.js`
- **Tests:** `tests/lide400-placement-approval.test.ts`, `tests/scanner-front-before-back.test.ts` (existing)

### D5 — Client-declared acquisition geometry was unverified authority
- **Commit:** `ae7d059c` `feat(scanner): a movable capture window, a per-side placement gate, and server-owned geometry`
- **Root cause:** evidence validation took its acquisition rectangle from **station-supplied provenance**. That was only survivable while the window was a hard-coded constant. Once the window became movable, a declared origin became an unverified number in an immutable evidence record — a station calibrated to `60,40` could declare `20,20`.
- **Status:** FIXED — the server snapshots the authoritative window at arm time (migration 0091) and validates against *that*; client provenance is demoted to something that must merely **agree**.
- **Files:** `server/lib/lide400-capture-authority.ts` (NEW), `server/scanner-capture-service.ts`, `server/routes.ts`, `migrations/0091_*.sql`
- **Tests:** `tests/lide400-capture-authority.test.ts` (285 lines)

### D6 — Guessed 72px admin header offset
- **Commit:** `d1a8b324` `fix(admin): delete the guessed 72px header offset, measure it instead`
- **Status:** FIXED — measured, not guessed.

### D7 — Rail sized from a percentage / wrong container; card oscillation
- **Commits:** `18246694`, `8c822396`, `65243074` (PRs #313, #311, #310)
- **Root cause:** rail width came from a percentage rather than the source scan's aspect; card sizing used its container rather than the visible screen, producing oscillation.
- **Status:** FIXED.
- **Files:** `shared/rail-width.ts` (NEW, 192)
- **Tests:** `tests/adaptive-rail-width.test.ts` (251)

---

## 12. CURRENT OPEN DEFECT — Scanner UI dead

**Symptoms (as reported, not reproduced from disk):**
1. **"Checking device…" stuck** — never resolves.
2. **Service & Diagnostics panel empty.**
3. **Capture window UI missing** — the movable window from `ae7d059c` does not render.

**Status: NOT DIAGNOSED. NOT FIXED.** No root cause is established, and none should be asserted.

**Strongest hypothesis, to be tested first, not assumed:** a **version skew** between the physically-running Scanner build and the `ae7d059c` server. `ae7d059c` changed `preload.js`, the native bridge `mintvault-lide-bridge.m`, `renderer/app.js`, `index.html` and `styles.css` **together**. A Scanner running an older renderer against a new server (or a stale/unrebuilt native bridge against a new `preload.js`) would plausibly show exactly this triad: device probe never resolving (bridge/IPC contract mismatch), diagnostics empty (same channel), capture window absent (renderer never shipped).

**Diagnostic sequence for next session — in this order, do not skip step 1:**
1. `git rev-parse HEAD` **in the Scanner Mac's checkout.** Compare to `ae7d059c`. If it differs, stop and rebuild before debugging anything else.
2. Confirm the native bridge was **rebuilt** after `ae7d059c` (it changed: `native/mintvault-lide-bridge.m`, 41 lines).
3. Open the Electron devtools console — read the actual error rather than inferring one.
4. Check the IPC channel names exposed in `preload.js` (+5 lines in `ae7d059c`) against what `renderer/app.js` subscribes to.
5. Only then look at server-side `/api` responses.

---

## 13. Old Scanner checkout/build that previously worked — NOT RE-VERIFIED

**I cannot name the last-known-good Scanner build with confidence, and I will not guess one.** What is available to locate it:

Scanner-lineage worktrees on this machine (candidates, newest first):
| Path | Branch | SHA |
|---|---|---|
| `/Users/cornelius/mintvault-scanner-main-reconciliation-20260815` | `codex/scanner-main-reconciliation-20260815` | `b5c9386e` |
| `/Users/cornelius/mintvault-scanner-sol-implementation-20260814` | `codex/scanner-sol-implementation-20260814` | `d6723cd6` |
| `/Users/cornelius/mintvault-live-absorb-20260812` | `release/canonical-scanner-live-absorb-20260812` | `300d8350` |
| `/Users/cornelius/mintvault-scanner-mainline-reconcile` | `release/scanner-mainline-reconcile-20260811` | `38f4b075` |

Find the actual last-good build:
```bash
git log --oneline --all -- scripts/scanner-app/ | head -40
```
Then bisect the Scanner app forward from the last build the operator confirms rendered.

⚠️ Memory `workstation-repair-stash-recovery` warns: the three 2026-08-14 stashes are **competing, not additive**, and are stale — re-applying them would REGRESS work already in `d6723cd6` and later. **Do not restore stashes to "get the working Scanner back".**

---

## 14. Known differences: old working Scanner vs current canonical Scanner — VERIFIED (as diff), INCOMPLETE (as cause)

Differences introduced by the last three commits, which is the smallest change-set that could explain a Scanner that used to render and now does not:

| Layer | Change | Risk to a running Scanner |
|---|---|---|
| `preload.js` | +5 lines — new IPC surface | **HIGH.** Renderer/preload contract must match exactly. |
| `native/mintvault-lide-bridge.m` | 41 lines changed | **HIGH.** Requires a native rebuild; a stale binary will not answer the device probe. |
| `renderer/app.js` | +286 lines — movable capture window, per-side placement gate | **HIGH.** If not shipped, the capture window is simply absent. |
| `renderer/index.html` | +44 — new capture-window DOM | HIGH — `app.js` will query nodes that do not exist on an old HTML. |
| `renderer/styles.css` | +144 — capture window styling | MEDIUM — could render invisibly rather than absently. |
| Server geometry authority | Server now owns the window; client provenance must merely agree | MEDIUM — an old client declaring the legacy constant may now be *refused* rather than accepted. |
| Session columns | Sessions armed pre-0091 carry NULL and are **refused at upload** | MEDIUM — expected, by design; re-arm is the remedy. |

**Not yet established:** which of these is actually firing. See §12 step 3.

---

## 15. Capture geometry architecture — APPROVED, IMPLEMENTED in `ae7d059c`

Approved and now the canonical model:

- **Movable capture window, 100 × 130 mm.** No longer anchored at a hard-coded platen origin.
- **Default origin 20, 20 mm.**
- **Safe zone 80 × 110 mm** inside the window.
- **10 mm preferred inset** — the target the operator is guided toward.
- **4 mm absolute evidence floor** — below this margin, evidence is refused. The margin verdict depends on window *size*, which is why size was pinnable against a constant while origin was not — and why 0091 exists.
- **Overlays are Preview-only.** Guides never contaminate the evidence master.
- **Preview is MANDATORY before FRONT and before BACK** — a per-side placement gate. Neither side may be captured without an approved preview for *that* side.

**Server-owned geometry (the authority rule):** when a side is ARMED, the server resolves the station's current **valid** calibration and copies its `acquisition_region` onto the capture session (0091). Evidence validation reads **that snapshot**, never the upload's provenance. Client provenance is retained only as something that must **agree**; disagreement is a rejection, not a correction.

---

## 16. Canonical detector work + regression evidence — VERIFIED

**One** canonical card detector, shared between server and Scanner via `shared/lide400-capture-profile.cjs` (335 lines) with `.d.cts` types (113). This removes the divergent-implementation class of defect, not just the instance.

**Regression corpus, committed as fixtures** (`tests/fixtures/lide400/`, with `manifest.json`):
- `mv272-front-accepted.jpg` — the accepted FRONT
- `mv272-back-rejected.jpg` — the rejected BACK
- `corner-registered-3mm.jpg` — below the 4 mm floor; must be refused
- `widest-card.jpg` — upper bound of the size envelope

**Test suites:**
| Suite | Lines | Proves |
|---|---|---|
| `tests/lide400-capture-corpus.test.ts` | 612 | Detector verdicts across the whole fixture corpus |
| `tests/lide400-capture-authority.test.ts` | 285 | Server-owned geometry beats client provenance |
| `tests/lide400-capture-profile.test.ts` | 262 | Shared profile contract |
| `tests/lide400-placement-approval.test.ts` | 100 | Mandatory per-side preview gate |
| `tests/lide400-canonical-detector.test.ts` | — | Single-detector canonicalisation |
| `tests/adaptive-rail-width.test.ts` | 251 | Rail sizing from source aspect |

---

## 17. Partner credit architecture ALREADY IMPLEMENTED

Landed and in the codebase (see the partner migration lineage `0001`–`0091` and `shared/schema.ts`):

- **Partner wallet** with a **ledger** (`rollback-partner-wallet-ledger.sql` exists as the paired rollback — the ledger is the source of truth; the wallet balance is derived/maintained alongside it).
- **Credit reservations** (`rollback-partner-credit-reservations.sql`) — a reservation is taken against a card job and later consumed or released, so a job in flight cannot double-spend.
- **Submission credit lifecycle** (`rollback-partner-submission-credit-lifecycle.sql`) — reserve → consume → settle.
- **Owner-binding fix**: `submission.email` no longer controls credit consumption (memory `pkg1-credit-owner-binding`). Credits are bound to the owning partner, not to an email on the submission.
- **Card job ↔ grading bridge** — `tests/partner-card-job-grading-bridge.test.ts` (modified this session).
- **Step-up auth for partner-sensitive actions** — `feat/partner-step-up-controller` (`fd8e4c63`, worktree `/Users/cornelius/mintvault-batch1-20260816`). Memory `partner-rc-pushed-20260815` records RC-F9: the partner step-up previously had no client flow, making credit purchase unreachable; that was fixed.
- **Concurrency proofs** exist as dedicated worktrees: `opus/partner-workitem-concurrency-proof`, `opus/partner-final-approval-concurrency`, `opus/partner-mutation-matrix-final`.

⚠️ Memory `owasp-redteam-2026-07-04` records **two payment TOCTOU races still OPEN pending owner approval**: credit double-spend and promo over-redeem. Confirm whether the reservation work closed the credit double-spend before building paid credits on top of it.

---

## 18. What remains for PAID credits — NOT BUILT

Nothing in this list is implemented. All of it is outstanding.

| # | Item | State | Notes / decision needed |
|---|---|---|---|
| 1 | **Packs 5 / 10 / 25 / 50 / 100** | Not built | Pack definitions need a home — `shared/schema.ts` per the project's single-source-of-truth rule, not hard-coded in the client. |
| 2 | **GBP prices** | **OWNER DECISION — not set** | No prices exist. Founder must set all five. |
| 3 | **VAT decision** | **OWNER DECISION — not made** | Whether prices are VAT-inclusive or exclusive, and whether credits are a single-purpose voucher (VAT at sale) or multi-purpose (VAT at redemption). This changes the price display, the Stripe line items, and the invoice. **Get this answered before writing any pricing code — it is not reversible cheaply.** Worth a UK accountant's confirmation. |
| 4 | **Stripe Checkout** | Not built | Grading currently uses a **PaymentIntent, not Checkout** (memory `promo-checkout-mechanism`). Credit packs would introduce a *second* payment mechanism. Decide deliberately: Checkout Sessions (simpler, hosted, gives you Prices/Products) vs. PaymentIntent (consistent with existing code). |
| 5 | **Webhook-authoritative exactly-once credit grant** | Not built | **The critical one.** The grant must happen in the webhook, keyed on a Stripe idempotency anchor (`checkout.session.id` / `payment_intent.id`) with a **unique constraint** in the DB, so a redelivered webhook cannot double-grant. Never grant from the client success redirect. Related prior art: `fix/stripe-estimate-credit-idempotency` (`849c4620`, worktree `mintvault-pkg2-estimate-credit-idempotency`). |
| 6 | **Wallet refresh after payment** | Not built | Post-payment the client must re-fetch the wallet; the grant is async relative to the redirect, so the UI needs a poll/settle state rather than assuming immediate balance. |
| 7 | **Zero-credit blocking** | Not built | Server-side refusal to start a card job at zero credits. Must be enforced server-side, not by hiding a button. |
| 8 | **"Top Up Now" UX** | Not built | Entry point from the blocked state into the pack purchase flow. |
| 9 | **Refund / dispute / reversal handling** | Not built | `charge.refunded`, `charge.dispute.created`, `payment_intent.canceled` must debit the wallet — **including the case where credits are already spent**, which produces a negative balance or a debt state. This needs an explicit owner policy decision, not a default. |

---

## 19. Known Stripe configuration gaps

- **No Price IDs are set** for any credit pack — there are five packs and zero configured Prices. Products and Prices must be created in Stripe (test mode first) and their IDs held in env/config, never hard-coded.
- **No `STRIPE_WEBHOOK_SECRET` entry exists for a credit-pack webhook path** beyond the existing `/api/stripe/webhook`. Per `CLAUDE.md`, that route is registered **before** `express.json()` (raw body requirement) — any new handler must respect this.
- 🚨 **The local `.env` uses LIVE Stripe keys while the DB is STAGING** (memory `local-env-live-stripe`). **Swap to `sk_test_` before any payment or credit work.** This is a real money-movement risk on a local test run.
- Stripe secrets live in **Fly secrets** (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`), read via `server/stripeClient.ts`. The old Replit Connectors path is gone.
- Payment code is a **Golden Rule 6 protected area** — no changes to the webhook or payment flow without explicit founder approval.

---

## 20. Test / gate status — NOT RE-VERIFIED, and known pre-existing noise

**No full test run was performed while writing this document.** The suites listed in §16 exist and are committed; whether the full suite is green right now is unproven.

To establish it, and to avoid two known traps:

```bash
LC_ALL=C LANG=C npm test
```
- ⚠️ **`LC_ALL=C LANG=C` is mandatory.** Without it, 17 DB-backed test files silently **skip** (memory `local-test-harness-lc-all`, 1952 → 2126 passed). A "green" run without it is not green.
- ⚠️ **A full parallel run shows 10–20 contention flakes** that pass in isolation (memory `fullsuite-parallel-flakes`). **Baseline on a clean worktree before blaming this branch** for any failure.
- ⚠️ **Partner gate:** run it as `--all --json` and **read the assertion count** — there are two silent-skip traps that previously hid a release blocker (memory `partner-gate-runner-failclosed`), plus a `seedCoreStubs` gotcha.
- ⚠️ **CodeQL `js/missing-rate-limiting` produces false positives** on routes that *do* have `express-rate-limit` (memory `codeql-ratelimit-false-positive`). Read the route before treating it as a gap.
- ⚠️ **Pre-commit `lint-staged` + prettier reformats whole unformatted files.** Use `git commit --no-verify` when you need a minimal diff (memory `precommit-prettier-hook`).

---

## 21. Branches / worktrees that MUST NOT be clobbered

**69 worktrees are live on this machine.** Treat all as load-bearing. The ones adjacent to this work, specifically:

**Scanner / capture lineage**
- `fix/canonical-card-detector-20260817` @ `ae7d059c` — **THIS WORK.** `/Users/cornelius/mintvault-platform`
- `feat/adaptive-rail-width-20260817` @ `f64e67fb` — `/private/tmp/.../wt-shell` ⚠️ **in a scratchpad path; merged as PR #313 but the worktree is on temp storage**
- `fix/capture-session-replay-20260817` @ `1a400d70`
- `fix/workstation-shell-space-20260817` @ `d1a8b324`
- `fix/canonical-left-rail-fit` @ `59459513` — `/Users/cornelius/mintvault-rail-fit-20260816`
- `codex/scanner-main-reconciliation-20260815` @ `b5c9386e`
- `codex/scanner-sol-implementation-20260814` @ `d6723cd6`
- `release/canonical-scanner-live-absorb-20260812` @ `300d8350`
- `release/scanner-mainline-reconcile-20260811` @ `38f4b075`

**Partner / credit lineage**
- `feat/partner-step-up-controller` @ `fd8e4c63` — `/Users/cornelius/mintvault-batch1-20260816`
- `fix/stripe-estimate-credit-idempotency` @ `849c4620`
- `psp/partner-wallet-backfill` @ `be8a501e` — `/Users/cornelius/mv-lifecycle`
- `feat/partner-catalogue-contribution` @ `d548a9e3`
- `fix/partner-core-release-blockers-20260816` @ `6e0c58a9`
- `opus/partner-*` proof worktrees (concurrency, mutation matrix, final approval, independent matrix) — these are **evidence**, not scratch.

**Release / prod reference**
- `/Users/cornelius/mintvault-prod-deploy-20260814` @ `067ed0c6` (detached)
- `/Users/cornelius/mintvault-gold-star-20260815` @ `36699531` (detached) — **this is what prod is running**
- `main` @ `3d6fa14e`, `/Users/cornelius/mv-release-control-20260816`

**Stashes — DO NOT POP BLIND.** 8 stashes exist, including three `psp/partner-rbac-hybrid` proof snapshots and two "auto-stash before AI Ops Hub Phase 4" entries. Per memory `workstation-repair-stash-recovery`, the 2026-08-14 workstation stashes are **competing, not additive**, and re-applying them would REGRESS.

---

## 22. BLOCKER REGISTER

### BLOCKER

**B1 — Scanner UI is dead; the running Scanner's SHA is unknown.**
Three symptoms ("Checking device…" stuck, Service & Diagnostics empty, capture window missing) with no established root cause. **Nothing can be diagnosed until the Scanner Mac's checkout SHA is read** and compared to `ae7d059c`. Blocks all Scanner operation. §12, §4.

**B2 — Local `.env` holds LIVE Stripe keys against a STAGING database.**
Any credit/payment work started in this state can move real money. **Swap to `sk_test_` before touching item 18.** §19.

**B3 — VAT treatment for credit packs is undecided.**
Owner decision. It determines pricing display, Stripe line items, invoicing, and whether VAT lands at sale or redemption. Pricing code written before this answer will be rewritten. §18.3.

**B4 — GBP prices for all five packs are unset.**
Owner decision. No pack pricing exists. §18.2.

**B5 — Exactly-once credit grant is unbuilt.**
Without a webhook-authoritative grant protected by a DB unique constraint on a Stripe idempotency anchor, a redelivered webhook double-grants credits. This is the single highest-risk piece of item 18. §18.5.

### HIGH

**H1 — Migration 0091 applied state is unconfirmed on both databases.**
Inferred applied on staging; must not be on prod. Repo has **no `_journal.json`**, so disk cannot answer it. Given the historical lineage collisions at 0045–0048, verify per-DB via `information_schema`. §2, §10.

**H2 — Two payment TOCTOU races recorded as OPEN** (credit double-spend, promo over-redeem, memory `owasp-redteam-2026-07-04`). Confirm whether reservations closed the double-spend before building paid credits on top. §17.

**H3 — Last-known-good Scanner build is not identified.** There is no confirmed rollback target for the Scanner. §13.

**H4 — Full test suite status unknown.** No run performed. Must be run with `LC_ALL=C LANG=C` and baselined against a clean worktree. §20.

**H5 — Refund / dispute / reversal policy undefined,** including the already-spent-credits case. Owner decision. §18.9.

**H6 — Prod moves under concurrent sessions.** `safe-deploy` GUARD 1 checks `origin/main`, not the live release. Re-read `fly releases` + `/api/version` immediately before any deploy. §3.

### MEDIUM

**M1 — MV272 and MV270–MV275 live state unverified.** §6, §8.
**M2 — Wallet totals and active reservations unverified; ledger-vs-balance not reconciled.** §7.
**M3 — Station calibration / `current_calibration_id` unverified.** §9.
**M4 — `feat/adaptive-rail-width-20260817` worktree lives on temp storage** (`/private/tmp/...`). Merged as PR #313, so the commits are safe, but the worktree can vanish. §21.
**M5 — Second payment mechanism risk.** Grading uses PaymentIntent; credit packs would add Checkout. Decide deliberately. §18.4.
**M6 — 69 worktrees + 8 stashes** is an unmanaged surface. Worth a deliberate prune session — separately, carefully, never as a side effect. §21.
**M7 — Untracked `docs/` and `.claude/skills/` content** in the canonical repo is uncommitted and unbacked. §1.

---

## 23. Recommended next-session sequence

**Do these in order. Do not start at step 4.**

1. **Re-establish ground truth (5 min, read-only).**
   `git rev-parse HEAD`; `curl .../api/version` for prod **and** staging; `fly releases -a <app>`. Never trust a SHA written in a document, including this one.

2. **Read the Scanner Mac's checkout SHA.** This unblocks B1 and is a prerequisite for every other Scanner step. If it is not `ae7d059c`, rebuild — including the **native bridge** — and re-test before diagnosing anything.

3. **If the SHA matches and it still fails:** open Electron devtools, read the actual console error, then check the `preload.js` IPC channel names against `renderer/app.js`. Read the error; do not theorise from the diff.

4. **Confirm 0091 on staging via `information_schema`.** Confirm it is **absent** on prod. (H1)

5. **Establish the data facts** — one read-only session covering MV270–MV275, wallet balances vs. ledger sum, active reservations, station calibration. Fill §6–§9 in this document with real values. (M1–M3)

6. **Run the full gate** — `LC_ALL=C LANG=C npm test`, plus the partner gate as `--all --json` reading the assertion count. Baseline flakes on a clean worktree first. (H4)

7. **Only then**, and only with the Scanner working: take the owner decisions for paid credits — **VAT treatment first, then GBP prices, then refund policy** (B3, B4, H5). These are blocking inputs, not implementation details.

8. **Swap the local `.env` to `sk_test_`** before writing a line of payment code. (B2)

9. **Build paid credits back-to-front:** the webhook-authoritative exactly-once grant with its DB unique constraint **first** (B5), then packs/prices, then Checkout, then zero-credit blocking (server-side), then Top Up Now UX, then refund handling.

10. **Do not deploy anything to production** until the Scanner is verified working on staging and the release is founder-approved. Prod stays on `36699531`.

---

*End of handover. No further changes were made after this document was written.*
