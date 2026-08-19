# Scanner final implementation handover — 2026-08-19

## Execution baseline

| Field                                 | Verified value                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Repository                            | `/Users/cornelius/mintvault-platform`                                                                 |
| Branch                                | `fix/canonical-card-detector-20260817`                                                                |
| Release candidate                     | Resolve with `git rev-parse HEAD` immediately before staging deployment.                              |
| `origin/main`                         | `f64e67fbfd9e8b5a5b647dd78265ada4478b485d`                                                            |
| Staging `/api/version`                | `f024f938` at 2026-08-19T06:09:37Z (pre-deploy baseline)                                              |
| Production `/api/version` (read-only) | `36699531` at 2026-08-19T05:32:53Z                                                                    |
| Staging Fly latest release            | version 502, completed 2026-08-17T20:14:10Z                                                           |
| Production Fly latest release         | version 1084, completed 2026-08-15T11:35:02Z                                                          |
| Scanner runtime                       | Source checkout Electron process is running from `scripts/scanner-app`; no packaged app proof exists. |
| Production                            | Untouched.                                                                                            |

## Authority and scope

This is the canonical execution handover requested by the 2026-08-19 scanner programme. The canonical architecture and blocker documents remain:

- `docs/scanner/SCANNER_FINAL_ARCHITECTURE_PLAN_20260818.md`
- `docs/scanner/SCANNER_BLOCKER_REGISTER_20260818.md`

This programme may implement safe local application work and execute read-only reconciliation. The
owner later authorised a staging-only deployment and the single, additive `0093` migration. It must
not mutate production, alter secrets, make a live Stripe payment, manually mutate Card
Jobs/wallets, or weaken protected grading/payment/authentication systems.

## Worktree warning

The worktree was already dirty at takeover. Modified scanner, viewer, server-authority, and test files are pre-existing user/shared-session work. Treat all of them as evidence to reconcile; do not reset, overwrite, or claim authorship. The scanner source Electron process has been running for more than fifteen hours from this checkout. A future renderer/native change is not evidence of its running behaviour until a deliberately authorised restart.

## Completion ledger

| Phases                                             | Status      | Current evidence / next action                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — reconciliation                                 | IN PROGRESS | Git/runtime/staging/prod baseline recorded. Read-only DB, station, Card Job, wallet, migration, and pack truth still require source-approved read path.                                                                                                                      |
| 1 — native CaptureService / physical Canon         | BLOCKED     | Current bridge remains short-lived per prior architecture pass. Physical Canon callback proof is mandatory. Awaiting source reconciliation and then a single owner physical instruction.                                                                                     |
| 2 — packaged runtime                               | NOT STARTED | Current `scripts/scanner-app` is a source checkout and dynamic build path; signed package proof absent.                                                                                                                                                                      |
| 3–18 — capture profile, preview, queue, credits UX | PARTIAL     | Local Preview=Acceptance is now implemented: GREEN placement + `SCAN` auto-uploads a frame-safe TIFF, unsafe frames are Rescan-only, upload progress and measured countdown are shown. True background Front→Back remains blocked by server capture-session state/authority. |
| 19–23 — packs, Stripe TEST, wallet proof           | PARTIAL     | Local grant authority now requires a verified Checkout Session, configured canonical Price ID/currency, and declared Stripe mode. No Stripe configuration, test checkout, webhook delivery, or staging mutation has occurred.                                                |
| 24–30 — evidence viewer / quality experiments      | PARTIAL     | Pixel inspection now prefers canonical working evidence and labels its actual source. Immutable TIFF handling and grading maths are unchanged; physical quality proof remains outstanding.                                                                                   |
| 31–36 — recovery, onboarding, security, packaging  | IN PROGRESS | Source review in progress; external/package credentials and physical clean-Mac proof not established.                                                                                                                                                                        |
| 37–44 — capacity, adversarial, E2E, gates          | NOT STARTED | Requires reconciled implementation, isolated environments, and physical/staging evidence.                                                                                                                                                                                    |
| 45 — staging release                               | NOT STARTED | No staging deploy is being performed at takeover.                                                                                                                                                                                                                            |
| 46–48 — readiness / production                     | NOT STARTED | Production remains hard-stopped.                                                                                                                                                                                                                                             |

## Reconciled local repairs

### Security and physical-journal hardening — locally proven

The legacy compatible Super Admin MFA-reset route now requires the same fresh step-up proof as the
canonical reset route. Station enrolment now obeys both existing emergency write controls
(`view-only` and `sensitive-freeze`). The Partner self-service MFA-disable endpoint now refuses
before touching factors, recovery codes, or sessions, preserving the owner-locked rule that users
cannot remove their own mandatory MFA factor. These controls retain the existing audited,
step-up-protected Super Admin recovery path.

The Scanner targeted-capture journal now fsyncs its temporary file and containing directory before
the physical LiDE capture may begin. A forced ENOSPC journal failure proves the hardware scan
function is never called. If a process dies after the pre-scan journal but before a later queue
transition, recovery retains a lone TIFF discovered in the already-journalled capture directory as
an explicit upload-refused candidate; it cannot masquerade as accepted evidence. This changes no
capture profile, TIFF bytes, server authority, or grading calculation.

Focused local evidence: active-card scanner suite **41 passed, 0 failed** and the full Scanner
suite **163 passed, 0 failed**; Partner auth/station suite **31 passed, 0 failed** with two
disposable-Postgres integration suites correctly skipped in the absence of their explicit local
URLs; `npm run check` and `git diff --check` passed. This is not physical-Canon or packaged-app
acceptance proof.

### Restart-safe NEW CARD operation identity — locally proven

`scripts/scanner-app/lib/state.js` now persists the one pending NEW CARD operation ID before the first request. `main.js` reuses that ID after a process restart and clears it only after a definitive success or refusal. The station therefore replays the same server idempotency key after an ambiguous crash window instead of creating a fresh request identity. This is a local client recovery improvement; the server remains the sole Card Job, MV, reservation, and wallet authority.

### Zero-credit reconnect prompt — locally proven

Wallet refreshes now carry a local display-only generation. A temporary dismissal of the zero-credit prompt is cleared when a newly authoritative wallet refresh still returns zero, including after reconnect. Closing the prompt continues not to enable NEW CARD; no price, wallet, or Stripe code changed.

Focused proof run: `node --check` for the touched scripts and 71 scanner tests across active-card, environment, renderer workflow, and renderer parse suites: **71 passed, 0 failed**. Tests used isolated temporary state/mocked endpoints only. `git diff --check` passed.

Earlier full local Scanner suite at this repair point: `npm test --prefix scripts/scanner-app` —
**161 passed, 0 failed**. Repository typecheck: `npm run check` — **passed**. The repository-wide
lint command was already baseline-red across unrelated files and nested `.claude/worktrees`;
focused lint on the then-changed Scanner files produced **0 errors**. No build, Electron restart,
hardware command, staging mutation, provider call, or production action was performed.

### Preview=Acceptance, upload progress, and measured countdown — locally proven

The normal post-scan `ACCEPT`/`RESCAN` decision branch has been removed from the Scanner UI, preload
bridge, main-process IPC, and watcher state machine. A server-owned side still requires a fresh
GREEN placement Preview; pressing `SCAN` consumes that approval and is now the operator acceptance
for that side. After ImageCaptureCore returns the locked-profile TIFF, the local frame-safety gate
either:

- accepts the TIFF and immediately queues/upload it as authoritative evidence; or
- rejects it into `preview_error`, where the preview remains visible and the only normal action is
  Rescan. That rejected TIFF is not uploaded as card evidence.

The exact scanner TIFF remains unchanged. The non-authoritative JPEG preview is still only an
operator display derivative. Direct staging uploads now emit real byte progress from the streaming
PUT path (`queued`, `uploading`, `uploaded`, `server_validating`) into the durable targeted queue
and renderer state. The renderer shows percentage and byte counts while keeping the side preview
visible during upload. Physical scan countdowns are local-only and use this station's measured
rolling timings by profile/DPI/window/side; a fresh station shows that it is measuring rather than
inventing a static timer.

Focused proof for this pass: `node --test test/server-client-tiff-upload.test.js
test/station-active-card.test.js test/renderer-parses.test.js test/renderer-workflow.test.js
test/ipc-registration.test.js` — **84 passed, 0 failed**. Full Scanner suite:
`npm test --prefix scripts/scanner-app` — **164 passed, 0 failed**. `npm run check` and
`git diff --check` passed. Targeted ESLint on touched files returned **0 errors** and 116 legacy
warnings. Repository-wide `npm run lint` remains baseline-red with **1,626 errors / 5,773
warnings**, including nested `.claude/worktrees` and unrelated legacy code.

This does **not** close true background Front→Back. The remaining blocker is cross-layer: the
server currently enforces one live station capture session and Back is only armed on the
server-accepted Front edge, after immutable Front evidence exists. Safely changing that requires a
server/session-state redesign and race proof; it was not smuggled into this local UI/runtime patch.

### Owner-approved protected repair: full-resolution grading inspection — locally proven

`client/src/components/grading/image-viewer.tsx` now selects `front_working` / `back_working`
before the ambiguous legacy `*_original` field for pixel inspection. The viewport exposes its real
source (`working-evidence`, a clearly labelled fallback, or unavailable) and calls the control
**Full-Resolution Evidence**. The extreme 12×/pixelated inspection mode is unchanged, but it now
cannot silently call a legacy derivative the master. This does not alter grading mathematics,
geometry, uploads, the immutable TIFF evidence master, or protected master storage/access. TIFFs
remain intentionally server-side; no browser endpoint was added or removed.

### Owner-approved protected repair: verified Stripe pack attribution — locally proven

The Partner credit grant now accepts only a Checkout Session re-read through Stripe's authenticated
API after the signed webhook event. It requires exactly one expanded line item whose Price ID and
ISO currency match the server-side pack record, and whose `livemode` matches explicitly declared
`STRIPE_ENV`. The new additive `0093_partner_credit_pack_currency.sql` stores that canonical
currency without guessing or changing any existing Stripe configuration: rows lacking it remain
fail-closed. Browser redirects still grant nothing; raw/unverified events, unpaid sessions, wrong
Price, wrong currency, wrong Stripe mode, and duplicate event deliveries cannot create extra
capacity. The existing append-only Foundation Credit ledger and event-id idempotency key remain the
only grant authority; transient errors still propagate before a ledger row so Stripe may retry.

Focused and relevant wider proof after these changes: `npm run check` passed; a 9-file Vitest gate
covering the FRONT/BACK pixel contract, real-PostgreSQL credit/replay/concurrent-NEW boundary,
Stripe-environment isolation, migration parity/migrator proof, Card Job authority, and mounted
inspection behaviour reported **97 passed, 0 failed**. `git diff --check` passed. This is local
source and disposable-database proof only — it is not a Stripe TEST Checkout/webhook or staging
acceptance claim.

Focused lint over the protected repair files reported **0 errors** and 24 pre-existing warnings in
the large legacy viewer/webhook/Stripe files; none is introduced by this repair.

### Staging-integration hostile review — locally repaired

Two independent hostile reviews re-opened only the changed viewer/payment/migration surfaces. The
viewer review found that the control text still called every fallback “Full-Resolution Evidence”.
It now visibly names `Full-Resolution Working Evidence`, `Working Evidence Crop`, `Legacy Original
Inspection`, `Legacy Cropped Inspection`, or `Display Derivative Inspection` as appropriate. A
mounted FRONT/BACK test verifies the displayed label, selected image URL, and no-smoothing source
attribute; this did not change any MVGS calculation, geometry, or TIFF access.

The payment review found `0093` contained an unnecessary `DROP CONSTRAINT`, which the migration
runner correctly treats as destructive. It was removed before any shared database operation. The
file is now additive-only and passes the runner’s destructive-SQL lint. Focused repair gates:
**139 passed, 0 failed**, TypeScript passed, and `npm run build` passed.

`npm test` has one known baseline failure in `partner-management-ux`: `HEAD f024f938` already
declares the `partner_card_job_voided` audit action while its latest audit-constraint migration
does not permit it. This predates this package (verified with `git show HEAD`) and neither the
viewer/payment/migration source nor the staging target changes it. It is recorded as a follow-up,
not hidden or altered to make the suite green.

### Staging-only schema application — proven

The scoped migration runner was first dry-run against the staging database and then applied **only**
`0093_partner_credit_pack_currency.sql` in convergence mode. Its SHA-256 checksum was
`3f85bfcd4521482a61e0dfab0c77359e4486c9bbe6c1db36f5d0ae152f9283c2`; the migration journal moved
from 82 to 83 entries and records that exact checksum as `applied`. A subsequent read-only check
confirmed that `partner_credit_packs.stripe_currency` is nullable `text`. All five active staging
packs (`PACK_5`, `PACK_10`, `PACK_25`, `PACK_50`, `PACK_100`) still have both `stripe_price_id` and
`stripe_currency` unset, so checkout/grant code remains fail-closed. No wallet, ledger, Card Job,
Stripe configuration, payment, secret, or production database was mutated.

### Staging deployment — proven

The protected-repair application commit `78d5bb3403cbabc4e09ec01e08af84cbe6568d3a` was deployed
from a detached clean worktree, so the shared checkout's unrelated untracked files were excluded.
Fly release **504** is complete on both `lhr` machines and each reports its health check passing.
`https://mintvault-v2.fly.dev/api/version` reports commit `78d5bb34`; `/health` reports `ok`.
The first staging deploy was immediately superseded because it omitted the existing documented
`GIT_SHA` build argument and correctly reported `unknown`; the replacement release supplies the
exact commit value and is the sole accepted staging release. The production version endpoint still
reports `36699531`; production was not deployed or otherwise changed.

Read-only staging wallet aggregation found four wallets: one currently has zero available credits,
three have positive availability, and the total available balance is 601. This establishes a
staging zero-credit state without identifying or modifying a partner. It does not prove the running
Scanner window's user-facing modal because the available browser has no authorised station session.
The anonymous zero row is ledger/reserved/available **0 / 0 / 0**. Across staging there are 18
active reservations (18 credits) and three consumed reservations (three credits); Card Jobs are one
`CAPTURING`, 12 `NEEDS_SCAN`, one `QA_REVIEW`, and five `READY_TO_GRADE`. These are read-only
environment aggregates, not a claim about a particular Scanner operator.

## Known blocking conditions at takeover

1. **Physical capture proof:** 18 August data-plane failures were recorded; direct ICA capability exists but persistent lifecycle proof does not. Do not attribute the failure solely to TCPIP/`ippusbd`.
2. **Packaging:** there is no verified signed/notarised standalone Scanner application; the running app is a development checkout.
3. **Background Front→Back:** local post-scan Accept is gone, but Back still cannot be prepared while Front upload/finalisation is unresolved. Closing this requires a server capture-session authority change, not just renderer copy.
4. **Commercial policy:** GBP pack pricing, VAT treatment, and Stripe Price IDs are owner decisions. The pack flow must remain fail-closed until configured.
5. **Pre-existing dirty changes:** current implementation must be reconciled and tested before edits or staging deployment; no reset/overwrite is authorised.
6. **Stripe TEST external acceptance:** staging schema `0093` is applied, but a non-live Stripe TEST Price/configuration record must still include the exact canonical currency alongside each Price ID before any pack becomes purchasable. The owner has not authorised configuration mutation, a test payment, or a staging webhook run in this pass.
7. **Baseline follow-up:** `partner_card_job_voided` needs its own explicitly approved audit-constraint migration. It is not carried in the protected viewer/Stripe package and must not be smuggled into the `0093` currency migration.

## Reviewer evidence reconciled by the Lead

- The native bridge is still a runtime-compiled, per-command ImageCaptureCore CLI. It opens ICA even for health and requests close without waiting for the close callback. This confirms `SFAP-001`/`002`/`003`; no physical claim is made from unit tests.
- The current normal Scanner path no longer uses post-scan `ACCEPT`/`RESCAN` after a frame-safe capture; upload starts from the explicit GREEN `SCAN`. However, upload/finalisation is still synchronous from the station's perspective and Back is armed only after Front has been server-accepted. This keeps the narrowed `SFAP-015` background Front→Back blocker open.
- Card Job start/reservation and zero-credit server authority are already strong and locally proven, including a real-PostgreSQL 5,000-way one-credit start storm. This is not a 5,000-station end-to-end capture/load proof.
- Station identity/tenant/location/capability binding is source- and test-proven. Real staging onboarding, password delivery, Stripe TEST, capacity, packaged app, clean-Mac, and physical capture remain separate acceptance gates.

## Evidence recorded this turn

- `git status`, branch, HEAD, `origin/main`, and recent graph were read.
- `https://mintvault-v2.fly.dev/api/version` and `https://mintvaultuk.com/api/version` were read without mutation.
- `fly releases` was read for both applications without mutation.
- The currently running scanner process was identified as `scripts/scanner-app` source Electron, not a packaged app.
- Three non-overlapping read-only reviews were started: native runtime, Electron workflow, and server authority.

## Exact next action

Use an authorised staging grader session to inspect an existing Scanner capture at 12× pixel mode on
both sides, recording the visible source identity and returned working-image dimensions. Stripe TEST
configuration, payment, and scanner restart remain explicitly out of scope until separately
authorised.
