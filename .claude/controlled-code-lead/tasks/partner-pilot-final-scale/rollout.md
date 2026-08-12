# Rollout — Partner Pilot final-scale completion

## Current state

No rollout is authorised. This task will produce an integration candidate and local/integration evidence only.

## Preconditions for an owner-authorised release

- Exact production migration journal inventory captured in a redacted read-only transaction.
- Restricted same-database Partner runtime role verified (`LOGIN`, no `BYPASSRLS`, expected membership) without printing credentials.
- Each selected migration independently approved, checksum-verified, additive and target-compatible.
- Full source gates plus safe deploy preflight pass; live SHA re-read immediately before deploy.
- An owner approval record covers the individual migration(s), runtime configuration action, deploy and physical canary.

## Safe release sequence when approved

1. Integrate the exact reviewed candidate semantically onto then-current `origin/main`.
2. Re-read live SHA/release; stop on divergence.
3. Run authorised migration(s) only, then verify the expected object/index/function.
4. Change only the restricted runtime URL/role configuration, run redacted role/RLS proof.
5. Deploy through `scripts/safe-deploy.sh` and record rollback SHA.
6. Run live Partner, Scanner, QA and print-lock negative probes; then perform the owner-operated physical Canon canary.
