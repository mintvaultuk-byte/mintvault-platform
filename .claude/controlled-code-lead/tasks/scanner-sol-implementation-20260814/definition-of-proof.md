# Definition of Proof — through WP8 implementation

| Dimension | Status |
|---|---|
| Design | final for WP0 boundaries/contracts; full architecture remains owner-provided |
| Implementation | WP0 control plane complete pending local checkpoint |
| Verification | Local Proof |
| Activation | local isolated worktree only; not pushed/deployed |

## Evidence

- Exact Git ancestry/status/origin and Partner dirty-state inspection.
- Engineering OS 1.0.10 self-check, enrollment and HOSTILE preflight.
- Graphify 0.9.39 code graph for `d44a2c53` with 11,275 nodes / 25,295 edges.
- Source verification against real Scanner/native/Partner files.
- Governance, TypeScript, lint, production build, protected MVGS/label and targeted Scanner/Partner tests executed non-vacuously; full-suite baseline failures explicitly classified rather than hidden.

WP0 creates no production feature and makes no production/staging claim.

## WP1 proof boundary

| Dimension | Status |
|---|---|
| Design | helper filename, protocol, identifier, arm64 and macOS 12.0 candidate floor frozen |
| Implementation | runtime compilation removed; exact packaged/dev resource resolver and integrity verifier implemented |
| Verification | Local Proof: real Mach-O build/execute plus hostile fixtures and regression suites |
| Activation | none; generated ad-hoc helper is ignored build output, not a Developer-ID release artifact |

WP1 proves that runtime capture no longer requires or trusts a compiler/source
cache. It does not claim a Canon physical scan, Developer-ID signature,
notarised package, Gatekeeper result, clean macOS 12 endpoint, or production
activation. Those remain WP6/WP9/WP11/WP12 external or physical gates.

## WP5 proof boundary

| Dimension | Status |
|---|---|
| Design | local encrypted queue, lifecycle, grant and disposition contract frozen pending P14 reconciliation |
| Implementation | Scanner-owned custody, tuple binding, restart finalisation and plaintext sweep complete |
| Verification | Local Proof: real filesystem encryption/decryption plus corruption, clone and injected-crash tests |
| Activation | none; legacy server cannot satisfy the strict final contract and the branch is not packaged/deployed |

WP5 proves local confidentiality, durable lifecycle convergence and fail-closed
server acknowledgement handling. It does not claim final Partner server
enforcement, a signed package, cross-Mac clone rejection, Pilot hardware or
production activation; those remain explicit later work-package gates.

## WP6 proof boundary

| Dimension | Status |
|---|---|
| Design | package identity/layout, nested signing order, Team/source authority, artifacts and CI contract frozen |
| Implementation | credential-independent app/DMG/ZIP and release pipeline complete |
| Verification | Local Proof: real arm64 artifacts reopened, runtime-imported and cross-bound; hostile A7 CLEAN |
| Activation | none; local artifacts are ad-hoc, `releaseReady:false`, not uploaded or installed on Pilot |

WP6 proves that credential-independent production packaging is executable and
fail-closed: 19 Mach-O files are arm64/macOS-12-compatible, dependency audit is
clean, runtime imports succeed from ASAR, and DMG/ZIP independently bind the
same app, helpers and source. It does not claim the owner Team value,
Developer-ID signature, notarisation, staple/Gatekeeper, update deployment or a
clean target-Mac acceptance run; those remain R-3 and WP7/WP9 gates.

## WP7 proof boundary

| Dimension | Status |
|---|---|
| Design | static-feed non-authority, authenticated exact update/rollback policy, candidate/DMG/login/restart contracts frozen pending P14 naming reconciliation |
| Implementation | Scanner-owned updater, verified reinstall, modal recovery and post-enrolment login startup complete |
| Verification | Local Proof: pinned-library behavioral fake, feed/policy/tamper/install-quiesce/recovery/resource-bound matrix, two RED→GREEN critical mutations, full Scanner regression, final targeted hostile CLEAN and independently reopened clean-source arm64 DMG/ZIP |
| Activation | none; local package is updater-disabled/ad-hoc and no feed, login item, station or external system was changed |

WP7 proves that no local/static feed fact can authorize a release, old cached
candidate or unverified DMG, and that updater failure cannot obtain restart
authority during plaintext/live watcher work. It also proves authenticated
sizes are enforced while reading and that MacUpdater's delayed native quit is
preceded by a non-overwritable Scanner-wide quiesce latch. It does not claim the final P14
policy endpoint, Developer-ID/notary/Gatekeeper, physical update/reinstall,
reboot persistence or production activation; those remain explicit WP9-WP13
and R-3/R-9 gates.

## WP8 proof boundary

| Dimension | Status |
|---|---|
| Design | immutable locked-profile, exact 1200-DPI proof, appliance state and service-recovery contracts frozen pending P14 naming reconciliation |
| Implementation | Scanner-owned encrypted profile, durable acceptance, exact ACTIVE binding and guided locked UI complete |
| Verification | Local Proof: filesystem/crypto/restart/proof/authority/UI matrices, rebuilt arm64 helper, browser harness and final A6 hostile CLEAN |
| Activation | none; no Canon, production Keychain, Partner endpoint, station, credit, evidence or external environment was used |

WP8 proves that mutable local setup cannot authorize packaged capture: one
device-bound profile operation must prove the exact helper/hardware/ROI/raster/card
frame, obtain an exact server revision/digest/full-profile acknowledgement, and
match the live server projection before ACTIVE. It also proves every setup and
recovery state locks the ordinary surface while retaining SHIFT CHANGE and a
service-only re-verification lane. It does not claim the final P14 endpoint,
real LiDE capture, signed-package Keychain behavior, or staging activation;
those remain WP9-WP12 and R-3/R-9 external or physical gates.
