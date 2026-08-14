# Deployment state — Scanner SOL campaign / through WP8 implementation

## Production

- Live commit/release: not queried; no production action is authorised by this prompt.
- Production database, R2, Stripe and provider identities: not accessed.
- Migration state: not queried and no migration may be applied in WP0-WP10 without a separate approved operation.

## Staging

- Runtime/topology: not mutated. Partner P14 durable record says AT-23 remains blocked on one-machine staging.
- Scanner package: not deployed.

## Campaign branch

- Branch: `codex/scanner-sol-implementation-20260814`
- Base: `d44a2c5363e702bb5aeb54157d7ad6a2af30546c`
- Configured origin: `git@github.com:mintvaultuk-byte/mintvault-platform.git`
- Pushed: no
- Deployed: nowhere
- Prior local package only: arm64 app/DMG/ZIP/update metadata/checksums were
  independently verified from clean WP7 source `48c843a2`; WP8 changes the
  native capture helper/profile runtime, so those artifacts are explicitly
  stale and will be regenerated from the clean WP8 checkpoint. Ad-hoc identity,
  `releaseReady:false`, never uploaded.
- Apple authority: no valid Developer ID identity was installed or used; exact
  owner Team authority remains `OWNER_REQUIRED`; no notary credential accessed.
- Update authority: implemented locally but inactive in local packages and not
  deployed. A release package requires authenticated final-P14
  `scannerUpdatePolicy`; static metadata alone is deliberately powerless. Local
  proof now includes bounded transport and asynchronous install quiescence; no
  remote feed or native updater installation was invoked.
- Login item: implemented/tested locally; no workstation login state was
  mutated by this campaign.
- Locked Scanner profile: implemented/tested only in isolated local stores and
  fake helper namespaces. No production Keychain, Canon device, station,
  Partner API, credit, Card Job or evidence endpoint was accessed.

## Known divergence

- Local `origin/main` is `9cd9804d199138502487824ca40e10261bba64d3`; campaign base is ahead 30 and behind 1.
- Active Partner pass2 began WP0 at the same committed HEAD plus substantial dirty P10-style authority work, then advanced to `73b2072e` with a different dirty file. It is moving and is not a frozen P14 release candidate.
- Final Scanner server reconciliation must use the eventual clean P14 HEAD and then-current main; dirty Partner files are never an input.

## Other in-flight work

- `/Users/cornelius/mintvault-partner-pilot-pass2`: active Partner P10/P14 work, read-only boundary for this campaign.
- `/Users/cornelius/mintvault-platform`: dirty `psp/partner-rbac-hybrid` physical-preview continuation, not modified by this campaign.
