# Rollout — Growth Completion Night

No push, pull request, migration, secret/configuration write or deployment has occurred. The runtime candidate is `c2d18aea`; the release candidate is the final documentation-only descendant at branch HEAD.

1. Owner authorizes publication of the exact clean branch and creation of a pull request; do not rebase or mix unrelated work.
2. Wait for terminal remote CI on the exact published SHA and reconcile every required check. A local green run is not a substitute.
3. Reconcile `origin/main`, production `/api/version`, Fly release/machines and production migration journal again. Stop on unexpected divergence.
4. Obtain separate authorization to apply additive migration `0101`; inventory target schema, apply once through the governed migration path, then verify journal and expected tables/indexes.
5. Through separately authorized configuration writes, set only approved review destination/allowlist/token and Resend verification values; set a dedicated MCP bearer hash only if the owner chooses to connect it. Absence remains a safe `NOT_CONFIGURED` state.
6. Deploy the exact remote-CI-green SHA through the repository safe-deploy path under the controller's conditional deployment authority, serialized against other releases.
7. Verify exact served SHA/bundle, health, real Growth/review/MCP/public contracts, scheduler disabled-safe behavior, Fly machines and database identity. Do not claim external providers or review delivery live until real connection tests pass.

Any gate failure invokes `rollback.md`; no autonomous external write, outreach or fabricated data is permitted.
