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

| Phases                                             | Status      | Current evidence / next action                                                                                                                                                                                                |
| -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — reconciliation                                 | IN PROGRESS | Git/runtime/staging/prod baseline recorded. Read-only DB, station, Card Job, wallet, migration, and pack truth still require source-approved read path.                                                                       |
| 1 — native CaptureService / physical Canon         | BLOCKED     | Current bridge remains short-lived per prior architecture pass. Physical Canon callback proof is mandatory. Awaiting source reconciliation and then a single owner physical instruction.                                      |
| 2 — packaged runtime                               | NOT STARTED | Current `scripts/scanner-app` is a source checkout and dynamic build path; signed package proof absent.                                                                                                                       |
| 3–18 — capture profile, preview, queue, credits UX | IN PROGRESS | Existing dirty implementation/test surfaces are being reconciled before any edit.                                                                                                                                             |
| 19–23 — packs, Stripe TEST, wallet proof           | PARTIAL     | Local grant authority now requires a verified Checkout Session, configured canonical Price ID/currency, and declared Stripe mode. No Stripe configuration, test checkout, webhook delivery, or staging mutation has occurred. |
| 24–30 — evidence viewer / quality experiments      | PARTIAL     | Pixel inspection now prefers canonical working evidence and labels its actual source. Immutable TIFF handling and grading maths are unchanged; physical quality proof remains outstanding.                                    |
| 31–36 — recovery, onboarding, security, packaging  | IN PROGRESS | Source review in progress; external/package credentials and physical clean-Mac proof not established.                                                                                                                         |
| 37–44 — capacity, adversarial, E2E, gates          | NOT STARTED | Requires reconciled implementation, isolated environments, and physical/staging evidence.                                                                                                                                     |
| 45 — staging release                               | NOT STARTED | No staging deploy is being performed at takeover.                                                                                                                                                                             |
| 46–48 — readiness / production                     | NOT STARTED | Production remains hard-stopped.                                                                                                                                                                                              |

## Reconciled local repairs

### Restart-safe NEW CARD operation identity — locally proven

`scripts/scanner-app/lib/state.js` now persists the one pending NEW CARD operation ID before the first request. `main.js` reuses that ID after a process restart and clears it only after a definitive success or refusal. The station therefore replays the same server idempotency key after an ambiguous crash window instead of creating a fresh request identity. This is a local client recovery improvement; the server remains the sole Card Job, MV, reservation, and wallet authority.

### Zero-credit reconnect prompt — locally proven

Wallet refreshes now carry a local display-only generation. A temporary dismissal of the zero-credit prompt is cleared when a newly authoritative wallet refresh still returns zero, including after reconnect. Closing the prompt continues not to enable NEW CARD; no price, wallet, or Stripe code changed.

Focused proof run: `node --check` for the touched scripts and 71 scanner tests across active-card, environment, renderer workflow, and renderer parse suites: **71 passed, 0 failed**. Tests used isolated temporary state/mocked endpoints only. `git diff --check` passed.

Full local Scanner suite: `npm test --prefix scripts/scanner-app` — **161 passed, 0 failed**. Repository typecheck: `npm run check` — **passed**. The repository-wide lint command is baseline-red (1,626 errors/5,769 warnings, including `.claude/worktrees` and unrelated pre-existing files); focused lint on the four changed Scanner files produced **0 errors** and 44 pre-existing style warnings. No build, Electron restart, hardware command, staging mutation, provider call, or production action was performed.

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

## Known blocking conditions at takeover

1. **Physical capture proof:** 18 August data-plane failures were recorded; direct ICA capability exists but persistent lifecycle proof does not. Do not attribute the failure solely to TCPIP/`ippusbd`.
2. **Packaging:** there is no verified signed/notarised standalone Scanner application; the running app is a development checkout.
3. **Commercial policy:** GBP pack pricing, VAT treatment, and Stripe Price IDs are owner decisions. The pack flow must remain fail-closed until configured.
4. **Pre-existing dirty changes:** current implementation must be reconciled and tested before edits or staging deployment; no reset/overwrite is authorised.
5. **Stripe TEST external acceptance:** staging schema `0093` is applied, but a non-live Stripe TEST Price/configuration record must still include the exact canonical currency alongside each Price ID before any pack becomes purchasable. The owner has not authorised configuration mutation, a test payment, or a staging webhook run in this pass.
6. **Baseline follow-up:** `partner_card_job_voided` needs its own explicitly approved audit-constraint migration. It is not carried in the protected viewer/Stripe package and must not be smuggled into the `0093` currency migration.

## Reviewer evidence reconciled by the Lead

- The native bridge is still a runtime-compiled, per-command ImageCaptureCore CLI. It opens ICA even for health and requests close without waiting for the close callback. This confirms `SFAP-001`/`002`/`003`; no physical claim is made from unit tests.
- The current normal Scanner path still uses post-scan `ACCEPT`/`RESCAN`; upload is synchronous and Back is armed only after Front has been server-accepted. This confirms `SFAP-015`, the required cross-layer background-upload redesign.
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
