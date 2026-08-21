# Rollback — Public Partner Network v1 final release

1. Use the Super Admin public-directory control to set `public_partner_directory_enabled` off with a reason and fresh step-up.
2. Verify public API/profile responses fail closed and retain the target-time audit evidence.
3. If required, roll back the application release using the deployment platform's verified prior release procedure; do not roll back data by deleting approval, audit, consent or Partner history.
4. Do not apply optional Google `0103`, rotate credentials or alter Partner records as part of public-directory containment.

Migration rollback is not the primary production containment mechanism. It needs an explicit owner-authorised, target-specific recovery plan.
