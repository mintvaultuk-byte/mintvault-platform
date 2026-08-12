# Rollback — Partner Pilot auth and onboarding

## Application rollback

If the deployed application behaves unexpectedly, roll back the application release through the approved release process. Do not delete Partner credential or audit rows.

## Migration handling

Do **not** automatically roll back `0077`. It changes authentication safety by marking old reset credentials used and intentionally leaving legacy credentials unproven. Dropping the new column/index or restoring the previous definer function could re-enable unknown legacy credentials or older reset links.

If a production migration failure occurs, stop and preserve the database/journal state for an authorised lead. Remediation must be a reviewed forward-only migration or a specific owner-authorised recovery plan.
