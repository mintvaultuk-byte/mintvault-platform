# Production rollout — owner/lead runbook

## Preconditions (read-only)

1. Confirm the production build is still the reviewed candidate lineage and that no unapproved migration is pending.
2. Immediately before migration, the authorised production operator runs a redacted `BEGIN READ ONLY` journal and inventory check. Include the count of active Partner users where `password_set_at IS NULL`; do not export emails, hashes, tokens, or secrets.
3. Confirm the restricted Partner runtime role, the dedicated `partner_definer` role, current Partner flags, email delivery configuration, and a rollback window.

## Ordered execution

1. Apply **only** `0077_partner_credential_lifecycle_hardening.sql` through the approved migration runner; do not broad-apply historic migration files.
2. Verify migration journal/checksum, `partner_auth_lookup` owner = `partner_definer`, execute ACL = `partner_runtime` only, and the partial unique reset index. These are read-only checks after execution.
3. Deploy the reviewed application build using the approved release process.
4. Smoke-test with a synthetic/non-production-safe authorised account: unauthenticated `/api/partner/me` must be `401`; an MFA-pending session must withhold identity; an MFA-complete session must return `/me` identity with no credential fields.

## Existing Pilot Partner One remediation

1. A Super Admin opens **Partner Network → MintVault Pilot Partner One Ltd → Users**.
2. For the historical active owner, choose **Send password setup**, enter the incident reason, and type `CONFIRM`.
3. Check the truthful delivery result. If it says delivery failed/not configured, repair delivery and re-issue; never copy or create a plaintext password/link.
4. The partner uses the fresh 30-minute link to set a password, signs in, completes MFA enrolment, and confirms the dashboard and Scanner sign-in path.
5. Confirm the admin lifecycle reads `READY TO LOG IN` only after MFA and location eligibility are complete.

## Hold points

Stop before each irreversible production step if the journal, role/ACL verification, email delivery result, or smoke check differs from the expected result. No automatic credential backfill is permitted.
