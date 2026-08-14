# Deployment state — Scanner SOL campaign / WP0

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

## Known divergence

- Local `origin/main` is `9cd9804d199138502487824ca40e10261bba64d3`; campaign base is ahead 30 and behind 1.
- Active Partner pass2 began WP0 at the same committed HEAD plus substantial dirty P10-style authority work, then advanced to `73b2072e` with a different dirty file. It is moving and is not a frozen P14 release candidate.
- Final Scanner server reconciliation must use the eventual clean P14 HEAD and then-current main; dirty Partner files are never an input.

## Other in-flight work

- `/Users/cornelius/mintvault-partner-pilot-pass2`: active Partner P10/P14 work, read-only boundary for this campaign.
- `/Users/cornelius/mintvault-platform`: dirty `psp/partner-rbac-hybrid` physical-preview continuation, not modified by this campaign.
