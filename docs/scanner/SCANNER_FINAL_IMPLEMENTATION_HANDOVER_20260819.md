# Scanner final implementation handover — 2026-08-19

## Execution baseline

| Field                                 | Verified value                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                            | `/Users/cornelius/mintvault-platform`                                                                                                    |
| Branch                                | `fix/canonical-card-detector-20260817`                                                                                                   |
| Release candidate                     | Payment/staging code: `e6b82b2d13e81d75792a858b19bc26ea4a1d7e9c`                                                                         |
| `origin/main`                         | `5a45ff9eba28de287306c5efe2634f9dbd9860f6`                                                                                               |
| Staging `/api/version`                | `e6b82b2d` at 2026-08-19T11:32:52Z                                                                                                       |
| Production `/api/version` (read-only) | `8359e902` at 2026-08-19T11:33:33Z; external/current production state, not this scanner pass.                                            |
| Staging Fly latest release            | version 514, both `lhr` machines healthy                                                                                                 |
| Production Fly latest release         | version 1104, read-only observed; not deployed by this pass                                                                              |
| Scanner runtime                       | Production-shaped unsigned local `.app` built and verified; physical launch/signing/notary not proved.                                   |
| Production                            | Untouched by this credit pass; read-only DB check found no partner-credit pack/checkout schema and no `0093`/`0097`/`0098` journal rows. |

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

## SFAP-015 background Front→Back authority pass — 2026-08-19

This pass implements the locked SFAP-015 boundary in source: a side may release the single physical
Canon target only after the station has a frame-safe TIFF, durable local queue record, content hash,
and a server-minted direct staging upload task. That released side remains the owner of its upload
and finalisation retries, but no longer monopolises the glass. BACK can therefore be armed for the
same Card Job/MV/certificate/station while FRONT uploads/finalises in the background. READY_TO_GRADE
still depends only on both sides becoming server-validated immutable evidence.

Key implementation points:

- `scanner_capture_sessions.physical_released` separates physical scanner ownership from network
  upload/finalisation ownership.
- The station unique index is replaced so only non-released active sessions occupy the physical
  station slot. Migration `0094` now has a narrow protected linter/runner approval for this exact
  create-before-drop index replacement; generic `DROP INDEX` remains blocked.
- Capture authority and capture-session creation count same-station released sides as present for
  the purpose of arming the remaining side, but do not count them as grading evidence.
- Same Card Job/MV/certificate/location/station affinity is enforced in both directions and across
  same-side recapture; generic Partner browser arming no longer accepts caller-supplied `recapture`.
- Cancellation and arming now share a per-certificate advisory transaction lock, closing the phantom
  arm-after-empty-session-lock race before credit refund.
- Staged finalisation has an idempotent reconciliation path for already-accepted evidence. The
  client no longer deletes a local recovery task from status alone after a post-evidence 500; it
  replays finalisation until reconciliation completes.
- Lost-local-TIFF recovery keeps the queue unless the server explicitly proves the session is
  terminal or accepted. A `capturing` server finalisation returns conflict/non-terminal, so the
  recovery record remains instead of being silently discarded.
- The Scanner renderer shows independent FRONT/BACK upload status and keeps queued FRONT preview
  retrievable while BACK is active; late FRONT completion cannot replace BACK UI state.

Focused and wider local proof after the hostile re-attack repairs:

- `node --test test/server-client-tiff-upload.test.js test/station-active-card.test.js test/renderer-workflow.test.js`
  in `scripts/scanner-app` — **74 passed, 0 failed**.
- `npm test` in `scripts/scanner-app` — **166 passed, 0 failed**.
- `npx vitest run tests/partner-card-job-authority.test.ts tests/partner-station-new-card.test.ts tests/partner-card-job-cancellation.test.ts tests/partner-card-job-output.test.ts tests/partner-card-job-reconciliation.test.ts tests/partner-pilot-concurrency.test.ts tests/partner-card-job-grading-bridge.test.ts tests/scanner-station-capture-boundary.test.ts tests/scanner-front-before-back.test.ts tests/partner-schema-parity.test.ts tests/scanner-evidence-staging-service.integration.test.ts tests/partner-credit-purchase.test.ts tests/partner-at21-grant-boundary.test.ts tests/stripe-environment-isolation.test.ts tests/partner-wallet-reservation-service.test.ts tests/partner-station-identity.test.ts tests/partner-station-fleet-control.test.ts`
  — **194 passed, 2 skipped**.
- `npm run check` — **passed**.
- `npm run build` — **passed** with the existing PostCSS `from` warning.
- Changed-file ESLint — **0 errors**, 59 legacy warnings in CommonJS/large scanner files.
- `git diff --check` — **passed**.
- `npx tsx scripts/db/lint-destructive-sql.ts migrations/0094_scanner_capture_physical_release.sql`
  — **passed through the protected 0094 approval only**: `DROP INDEX` remains destructive to the
  generic linter, but this file's replacement creates the new `physical_released=false` unique
  index before dropping and renaming the canonical index.
- `npx vitest run tests/db-migration-safety.test.ts tests/scanner-physical-release-migration.test.ts`
  — **53 passed, 0 failed**. This includes disposable PostgreSQL proof for a 0093 journal moving to
  0094, replay/idempotency, old duplicate physical target rejection, released FRONT + physical BACK
  allowance, and continued rejection of another non-released physical target at the same station.

Hostile re-attack results:

- Native/Electron scanner review: **PASS**, source/test only; no physical Canon/Electron GUI proof.
- Capture/session/evidence authority review: **PASS**, no remaining BLOCKER/HIGH; static/concurrency
  review only.
- Auth/payment/Card Job identity review: **PASS**, no remaining BLOCKER/HIGH; noted that a full
  orchestrated PostgreSQL interleaving test is stronger future proof than the current source/DB
  service coverage.

Protected staging migration update:

- Staging read-only preflight before `0094`: journal high-water `0093_partner_credit_pack_currency.sql`;
  `physical_released` absent; old `uq_scanner_capture_one_active_station` present; no active station
  duplicates; no active scanner sessions; core counts were `scanner_capture_sessions=21`,
  `certificate_image_evidence=14`, `partner_card_jobs=19`, `partner_credit_reservations=21`,
  `certificates=283`; scanner/evidence orphan checks were zero.
- Staging `0094_scanner_capture_physical_release.sql` applied through scoped migration mode only:
  checksum `4918f58e72da444c2cac949952a4502d396ae63747fb364dbe2298257ccbb8cb`, journal
  `83 -> 84`, completed at `2026-08-19T09:02:01.896Z`.
- Staging post-apply proof: `physical_released BOOLEAN NOT NULL DEFAULT false`; canonical
  `uq_scanner_capture_one_active_station` predicate now includes `physical_released = false`;
  `idx_scanner_capture_released_station_certificate` and `idx_scanner_capture_expiry_physical`
  exist; core counts unchanged; duplicate active physical station and orphan checks remain zero.
- Staging code deployment completed to `mintvault-v2` after the verified migration. Fly reported both
  machines healthy, `/health` returned `{"status":"ok"}`, and `/api/version` reported the deployed
  SFAP-015 successor commit.
- Production was not targeted by this scanner pass. A separate production release was observed during
  reconciliation (`c6ae706f`, `0095_growth_partner_applications.sql`); production still has no
  `0094_scanner_capture_physical_release.sql` journal row and no `physical_released` scanner column.

Not claimed by this pass:

- No physical Canon acceptance was run.
- No clean packaged Scanner application exists yet.
- No 5,000-station/5,000-overlap scanner load run was executed. The existing real-PostgreSQL
  5,000-way one-credit NEW storm remains credit/idempotency proof, not scanner-overlap scale proof.
- No production scanner migration or scanner deployment was performed by this pass.

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

## Owner-independent completion pass — physical Canon unavailable — 2026-08-19

The owner explicitly stated that the Canon LiDE 400 is unavailable and instructed this pass to finish
every owner-independent phase without weakening the later physical gate. This pass therefore did not
claim ImageCaptureCore callback reliability, physical placement, scan quality, cable recovery, or
clean-Mac launch. It did complete the remaining software/provenance work that can be proved without
the scanner.

### New implementation in this pass

- `scripts/scanner-app` now has a production-shaped macOS package path:
  `npm run package:mac` builds `dist/mac-arm64/MintVault Scanner.app`, compiles
  `native/mintvault-lide-bridge.m` at package time, nests the executable bridge in
  `Contents/Resources/app/native/mintvault-lide-bridge`, copies the shared LiDE geometry/profile
  modules to `Contents/shared`, and writes
  `dist/mac-arm64/mintvault-scanner-package-manifest.json`.
- Packaged runtime now fails closed to the nested bridge. The packaged branch is evaluated before
  the development `/usr/bin/xcrun clang` fallback, so a normal Partner Mac does not need Node, npm,
  Git, Xcode, clang, Command Line Tools, or a source checkout for the native bridge.
- The package verifier asserts the bundle identifier/executable, main/preload/renderer files,
  runtime `sharp`, nested bridge executable, shared Canon modules, manifest, and absence of nested
  `scripts`, `test`, `dist`, and dev Electron dependency.
- `scripts/scanner-app/scripts/control-plane-load-sim.js` adds an owner-independent load simulator
  for overlapping FRONT/BACK release/finalisation, duplicate callbacks, network drops/retries,
  stale preview, cross-side, cross-tenant, cross-station, zero-credit attempts, and 0/63/100 upload
  progress samples.
- Migration `0096_partner_card_job_void_management_audit.sql` widens the
  `partner_management_audit.action_type` CHECK constraint to permit the already-declared
  `partner_card_job_voided` management audit action. This keeps the protected Card Job void path
  auditable instead of failing at its audit envelope. The destructive-SQL linter/runner approval is
  exact-file/exact-constraint only; generic `DROP CONSTRAINT` remains blocked.

### Local proof after implementation commit `87366650`

- `npx vitest run tests/scanner-physical-release-migration.test.ts tests/db-migration-safety.test.ts
tests/partner-core-release-blockers.test.ts tests/partner-management-ux.test.ts
tests/partner-schema-parity.test.ts` — **207 passed, 0 failed**.
- Wider scanner/payment/authority slice before commit formatting:
  `npx vitest run tests/db-migration-safety.test.ts tests/migration-scope-contract.test.ts
tests/partner-schema-parity.test.ts tests/scanner-physical-release-migration.test.ts
tests/scanner-evidence-staging-service.integration.test.ts tests/partner-card-job-grading-bridge.test.ts
tests/partner-card-job-authority.test.ts tests/partner-card-job-cancellation.test.ts
tests/partner-credit-purchase.test.ts tests/partner-at21-grant-boundary.test.ts
tests/partner-management-ux.test.ts tests/partner-core-release-blockers.test.ts` —
  **311 passed, 2 skipped**.
- Auth/onboarding/viewer/downstream slice:
  `npx vitest run tests/partner-reset-delivery.test.ts tests/partner-reset-delivery-integration.test.ts
tests/partner-mfa-factor-hardening.test.ts tests/partner-mfa-enrolment-mandatory.test.ts
tests/partner-admin-control-shell-integration.test.ts tests/partner-step-up-auth.test.ts
tests/partner-station-identity.test.ts tests/partner-station-fleet-control.test.ts
tests/partner-onboarding-matrix.test.ts tests/partner-onboarding-controls-source.test.ts
tests/grading-rail-card-safe-fit.test.ts tests/card-inspection-mounted.test.ts
tests/image-evidence.test.ts tests/partner-card-job-output.test.ts
tests/approval-grade-preservation.test.ts tests/print-workflow-service.test.ts
tests/print-workflow-routes.test.ts` — **144 passed, 65 skipped**.
- `npm test` in `scripts/scanner-app` — **176 passed, 0 failed**.
- `npm run package:mac && npm run verify:package` in `scripts/scanner-app` — **passed**.
  Manifest bridge SHA-256:
  `54f31967ef76119e5bbeeca54c1b099737ccbb28a7b15e4aec7330af4f0d2f2d`;
  tracked tree clean: `true`; runtime requirements for Node/npm/Git/Xcode/clang: all `false`.
  After the documentation commit, the package was rebuilt and re-verified with manifest source
  commit `c3e1c2956d1717f5cdccb3b118603f781fe98885` and the same bridge SHA-256.
- `npm run simulate:control-plane -- --workflows=5000 --burst=20000 --zero-credit-attempts=1000
--seed=50819` — **PASS**, 5,000/5,000 workflows, 20,000/20,000 burst events, 81,405 events
  processed, 10,000 evidence rows, 5,000 reservations, 1,000 zero-credit attempts rejected.
- `npm run simulate:control-plane -- --workflows=10000 --burst=20000 --zero-credit-attempts=1000
--seed=100819` — **PASS**, 10,000/10,000 workflows, 20,000/20,000 burst events, 142,806 events
  processed, 20,000 evidence rows, 10,000 reservations, 1,000 zero-credit attempts rejected.
- `npm run check` — **passed**.
- `npm run build` — **passed** with the existing PostCSS `from` warning.
- Changed-file ESLint — **0 errors**, warnings only for the scanner app's existing CommonJS script
  style.
- Full root `npm test` was attempted post-commit: **292 test files passed, 54 skipped, 5 suites
  failed only because external DB env vars are absent** (`TEST_DATABASE_URL` for two migration
  suites and `MINTVAULT_DATABASE_URL` for three Vault Quest suites). No actionable scanner/payment/
  viewer/auth source-contract failures remained.
- Signing boundary: `security find-identity -v -p codesigning` returned **0 valid identities**.
  Signing/notarisation therefore stops at the external Developer ID/notary credential boundary.

### Staging proof

- Staging deployment used `scripts/safe-deploy.sh staging --allow-behind --yes`. The live-ancestry
  guard first proved candidate `87366650` contained the prior staging live commit
  `8e7ab8f3338e1ff3bc4aeb1988585e72a8ec7fec`; rollback image
  `registry.fly.io/mintvault-v2:deployment-01M0CMTGHC8DTAADE4R94CSDBP` was recorded before rollout.
  After the docs commit, the same deploy guard proved final candidate `c3e1c295` contained live
  `87366650`.
- Fly deployed final image `registry.fly.io/mintvault-v2:deployment-01M0CQ0DZAT6QE3S1WSXWRSNTE`.
  Staging Fly version **509** is healthy on both `lhr` machines. `/api/version` reports
  `c3e1c295`; `/health` reports `ok`.
- Staging scoped migration dry-run for `0096_partner_card_job_void_management_audit.sql` reported
  checksum `c927209413365215222a7b1093d9a647fb3855fec0bfb416a3d80b861d7ccf46` and journal entries
  `84`.
- Staging scoped migration apply ran **only** `0096_partner_card_job_void_management_audit.sql`;
  the runner logged `DROP CONSTRAINT` as the approved protected constraint replacement and moved the
  journal **84 -> 85**. Postcheck shows the journal row `applied`, completed at
  `2026-08-19T09:49:08.660Z`, the CHECK includes `partner_card_job_voided`, and there are zero
  existing `partner_card_job_voided` audit rows.
- Production was not deployed or migrated. Read-only production checks observed `/api/version`
  `e689389b`, Fly version **1101**, no `0094` or `0096` journal rows, and no
  `scanner_capture_sessions.physical_released` column.

### Physical Canon gate retained

The following is the exact hardware-only acceptance checklist for when the owner has the Canon
again. It must be an acceptance session only, not an engineering/design session:

1. Launch packaged staging Scanner.
2. Canon READY.
3. PREVIEW FRONT.
4. SCAN FRONT.
5. Verify FRONT upload runs in background.
6. Immediately PREVIEW BACK while FRONT still uploads.
7. SCAN BACK.
8. Both sides authoritative.
9. Cable disconnect/reconnect recovery.
10. Scanner restart during pending upload.
11. Image-quality visual check.
12. Measured scan timing/countdown accuracy.

## Zero-credit top-up + Stripe TEST payment red-team pass — 2026-08-19

This pass completed all owner-independent payment/top-up hardening without mutating production,
without creating a live Stripe payment, and without inventing commercial pricing.

### Current staging truth

- Staging app: `mintvault-v2`, Fly version 509 at the start of the pass, healthy on both machines.
- Staging `/api/version` before this pass: `c3e1c295`.
- Staging Stripe key shape: TEST secret/publishable keys present; `STRIPE_ENV` is not declared.
- Staging credit packs: `PACK_5`, `PACK_10`, `PACK_25`, `PACK_50`, `PACK_100` active, but all have
  `stripe_price_id=NULL` and `stripe_currency=NULL`.
- Result: the top-up catalogue is visible but intentionally not purchasable; Checkout and webhook
  grants remain fail-closed until the owner supplies canonical TEST Price/currency/VAT decisions.
- Production was read-only checked only; no production deploy, migration, Stripe config mutation,
  payment, or wallet edit was performed.

### Implementation completed

- Checkout now refuses to create a Stripe Session unless the deployment explicitly declares Stripe
  mode and that mode matches the deployment: staging must be TEST; production must be LIVE.
- Checkout retrieves the configured Stripe Price before returning a URL and rejects inactive Price,
  wrong Price ID, wrong currency, or wrong Stripe environment before any buyer can pay.
- Migration `0097_partner_credit_checkout_sessions.sql` adds an append-only Checkout provenance
  table for Partner credit purchases. The verified webhook must match a server-created Checkout
  intent for the same tenant, pack, Price, currency and Stripe mode before reaching the ledger.
- Webhook fulfilment now locks the Checkout-intent row and appends the Stripe purchase ledger row in
  the same partner-admin transaction. Same-event replay remains idempotent through the ledger key;
  same-session/different-event replay is blocked by the intent status moving from `created` to
  `granted`.
- Scanner and Partner billing UI now report why packs are unavailable: pricing missing, Stripe mode
  undeclared, or Stripe mode mismatched. The scanner still opens only server-returned Checkout URLs
  and unlocks only from authoritative wallet refresh.
- A new scanner-app payment load simulator covers zero-credit lock, top-up unlock, local Checkout
  intent, browser redirect no-grant, verified paid webhook, wrong Price/currency/environment,
  incomplete/unverified/missing-intent/wrong-tenant hostile deliveries, duplicate/replayed events,
  and retryable transaction failure.

### Local proof

- `npm run check` — PASS.
- `npx vitest run tests/partner-credit-purchase.test.ts tests/partner-credit-presentation.test.ts
tests/partner-portal-credit-ui.test.ts tests/partner-step-up-ui.test.ts
tests/partner-schema-parity.test.ts` — **74 passed**.
- `npx vitest run tests/stripe-environment-isolation.test.ts tests/partner-wallet-service.test.ts
tests/partner-credit-reservation-service.test.ts tests/partner-station-new-card.test.ts
tests/partner-at21-grant-boundary.test.ts tests/partner-card-job-authority.test.ts` —
  **90 passed**.
- `npx vitest run tests/db-migration-safety.test.ts tests/migration-scope-contract.test.ts
tests/stripe-environment-isolation.test.ts` — **85 passed**.
- `npm test` in `scripts/scanner-app` — **177 passed**.
- `npm run simulate:payment-control-plane -- --workflows=5000 --burst=20000 --seed=190826` —
  PASS; 5,000 grants, 5,000 zero-credit rejections, 20,000 burst events.
- `npm run simulate:payment-control-plane -- --workflows=10000 --burst=20000 --seed=190827` —
  PASS; 10,000 grants, 10,000 zero-credit rejections, 20,000 burst events.
- `npm run simulate:payment-control-plane -- --workflows=20000 --burst=20000 --seed=190828` —
  PASS; 20,000 grants, 20,000 zero-credit rejections, 20,000 burst events.
- `npm run simulate:payments -- --workflows=5000 --burst=20000 --zero-credit-attempts=1000
--seed=501` — PASS; 5,000/5,000 workflows, 20,000/20,000 burst events.
- `npm run simulate:payments -- --workflows=10000 --burst=20000 --zero-credit-attempts=1000
--seed=1001` — PASS; 10,000/10,000 workflows, 20,000/20,000 burst events.
- `npm run simulate:payments -- --workflows=20000 --burst=20000 --zero-credit-attempts=1000
--seed=2001` — PASS; 20,000/20,000 workflows, 20,000/20,000 burst events.
- `npm run simulate:control-plane` at 5,000 and 10,000 scanner workflows with 20,000 burst events
  — PASS.
- `npm run build` — PASS with the existing PostCSS `from` warning.
- Touched-file ESLint — PASS.
- `git diff --check` — PASS.
- Forward migration SQL lint for `0097_partner_credit_checkout_sessions.sql` — PASS. The guarded
  rollback is deliberately flagged by the destructive SQL heuristic because it contains `DROP TABLE`;
  it refuses to run once any payment provenance row exists.

### Exact owner action still required

Owner must provide/approve the staging commercial Stripe TEST configuration:

1. declare staging Stripe mode as `STRIPE_ENV=test`;
2. provide the five TEST Stripe Price IDs for `PACK_5`, `PACK_10`, `PACK_25`, `PACK_50`, `PACK_100`;
3. confirm `stripe_currency='gbp'` and VAT treatment/prices;
4. complete one human Stripe TEST Checkout on staging.

Until that happens, the correct state is **no purchasable packs and no purchase credit grants**.

## Final credit purchase / zero-credit / Stripe staging pass — 2026-08-19

This addendum supersedes the earlier payment notes above where runtime facts differ. It records the
owner's locked commercial decision and the staging work completed from commit
`e6b82b2d13e81d75792a858b19bc26ea4a1d7e9c`.

### Locked commercial configuration

- **£10 per Partner Grading Credit**
- **GBP**
- **VAT included** in the displayed/charged price; this pass does not add VAT on top.
- `PACK_5` = 5 credits = **£50** total, VAT included.
- `PACK_10` = 10 credits = **£100** total, VAT included.
- `PACK_25` = 25 credits = **£250** total, VAT included.
- `PACK_50` = 50 credits = **£500** total, VAT included.
- `PACK_100` = 100 credits = **£1,000** total, VAT included.

### Source repairs completed

- Canonical pack pricing is now hard-coded as pence values plus `gbp` and VAT-included
  presentation. Unknown active DB pack rows are ignored instead of falling back to `credits * £10`.
- Checkout and verified webhook fulfilment now reject wrong Stripe Price ID, wrong currency, wrong
  amount, Stripe `tax_behavior='exclusive'`, wrong TEST/LIVE mode, unpaid sessions, missing local
  Checkout provenance, disabled/unknown packs, and duplicate/replayed events before any
  append-only credit grant.
- Scanner zero-credit UI uses server `displayPrice` / `vatIncluded`; server
  `INSUFFICIENT_CREDITS` is an authoritative zero-lock signal even if a wallet refresh is delayed.
- `SCANNER_OPERATOR` receives exactly one new additive permission,
  `partner.credits.view`, through `0098_scanner_operator_credit_view.sql`; it still receives no
  purchase, user, station-enrolment, card-fix, or admin permissions.
- `MVGS_ASSESSMENT_TECHNICIAN` is hard-blocked from credit purchase even if a purchase permission
  is mis-granted.

### Local proof

- `npm run check` — passed.
- Post-commit focused smoke: 6 Vitest files, **91 passed / 0 failed**; scanner active-card/payment
  node tests, **42 passed / 0 failed**.
- Wider payment/server authority slice before commit: 14 Vitest files, **244 passed / 0 failed**.
- Full Scanner app suite: **177 passed / 0 failed**.
- `npm run build` — passed with the existing PostCSS `from` warning.
- Destructive-SQL lint for `0097_partner_credit_checkout_sessions.sql` and
  `0098_scanner_operator_credit_view.sql` — passed.
- DB-required root files rerun against disposable local PostgreSQL 17 at
  `127.0.0.1:55432/mintvault_vq_phase10_local`: 5 files, **62 passed / 0 failed**.
- Payment/control-plane simulations passed at 5,000, 10,000 and 20,000 workflows, each with 20,000
  hostile/replay burst events.
- Scanner payment simulations passed at 5,000, 10,000 and 20,000 workflows, each with 20,000
  hostile/replay burst events and 1,000 pure zero-credit attempts.
- `git diff --check` — passed.

Repository-wide `npm test` under the local DB environment is **not** claimed as green: enabling
`TEST_DATABASE_URL` opened unrelated Vault Quest integration suites whose tables
(`vq_generation_requests`, `vq_feature_flags`, `vq_artwork_revisions`, etc.) were not bootstrapped
in that disposable database. That run reported 298 files passed, 29 skipped and 25 unrelated VQ
files failed from missing VQ schema. No payment/scanner/RBAC regression remained in the focused
release matrix.

### Staging changes completed

Staging was changed; production was not.

- Deployed commit `e6b82b2d` to `mintvault-v2` from a detached clean worktree, excluding unrelated
  dirty partner-management/location files in the shared checkout.
- Fly staging release **513** deployed image
  `registry.fly.io/mintvault-v2:deployment-01M0CWH725PNN74ZYGXYKPP46Q`.
- Fly staging release **514** set `STRIPE_ENV=test` on the same image.
- `https://mintvault-v2.fly.dev/api/version` reports `e6b82b2d`; `/health` reports `ok`.
- Both staging machines are started in `lhr` on version 514 with 1/1 health check passing.
- Scoped migration dry-run and apply:
  - `0097_partner_credit_checkout_sessions.sql`, checksum
    `c1039b6fbe3bf9d58ba52f3dc9a34cc2d294fe620918cf881a700561ba87644a`, journal **85 → 86**.
  - `0098_scanner_operator_credit_view.sql`, checksum
    `55e27da14c2343a7eae3a73f39836e5bcd20676122f71b4166a7f2721258d313`, journal **86 → 87**.

Post-checks:

- Staging environment: `STRIPE_ENV=test`; Stripe secret/publishable keys are TEST-shaped; webhook
  secret present; database present.
- Staging migration journal count: **87**; relevant rows present: `0093`, `0094`, `0096`, `0097`,
  `0098`.
- `partner_credit_checkout_sessions` table exists.
- `stripe_webhook_events` table exists.
- `SCANNER_OPERATOR|partner.credits.view` exists exactly once.
- Wallet aggregate: 4 wallets, 1 zero-available wallet, ledger 619, reserved 18, available 601.
- Active pack rows remain exactly `PACK_5`, `PACK_10`, `PACK_25`, `PACK_50`, `PACK_100`, but all
  still have no `stripe_price_id` and no `stripe_currency`; they are visible but not purchasable.

### Staging blocker

The staging Stripe TEST secret is externally unusable: Stripe returned HTTP **401**
`api_key_expired` when asked to list TEST prices. No raw secret was recorded. Because that key is
expired, this pass could not safely search/reuse/create TEST Stripe Products/Prices, could not
write canonical TEST Price IDs into `partner_credit_packs`, and could not run a real TEST Checkout
or webhook grant. Staging therefore remains intentionally **fail-closed** rather than buyable.

### Production status

Production remained read-only and untouched:

- `https://mintvault.fly.dev/api/version` reports `8359e902`; `/health` reports `ok`.
- Fly production version **1104** is healthy on both `lhr` machines.
- Production environment: `STRIPE_ENV` unset; Stripe keys are LIVE-shaped; webhook secret present.
- Production migration journal count: **41**; no `0093`, `0094`, `0096`, `0097`, or `0098` journal
  rows.
- Production has no `partner_credit_packs` table and no `partner_credit_checkout_sessions` table.

Production release is hard-stopped until staging has valid TEST Stripe credentials, canonical TEST
prices configured, real TEST Checkout/webhook proof, and the owner completes the requested staging
test purchase through the normal product UI.
