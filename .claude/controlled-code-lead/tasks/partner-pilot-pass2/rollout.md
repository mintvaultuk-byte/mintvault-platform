# Rollout — Partner Pilot Pass 2

## Status

No rollout is authorised. This task is currently reconciliation and local
integration only.

## Future preconditions

- Candidate contains the current live lineage and rechecked live SHA.
- Exact pending migrations are compared with the production journal; no broad
  migration application.
- Restricted Partner runtime is independently proven with a non-owner,
  non-BYPASSRLS role and no privileged fallback.
- Required real-DB/route/test/hostile proofs pass on the final SHA.
- Owner explicitly approves each protected production action and performs any
  required physical capture/print acceptance.

## Intended release path when authorised

1. Re-fetch `origin/main` and re-read production `/api/version`.
2. Reconcile the final candidate onto the live lineage.
3. Run the project safe deploy path, not raw `fly deploy`.
4. Verify exact SHA, health, Partner runtime and the approved canary sequence.
