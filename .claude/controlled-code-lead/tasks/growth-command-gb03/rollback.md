# Rollback — Growth Command GB-03

- Source rollback: revert the GB-03 commit; it is isolated from Partner operational tables and routes.
- Database rollback (only if `0091` has been separately approved and applied): use `migrations/rollback-0091-growth-partner-applications.sql` after retaining/exporting lead records required by the approved privacy policy; do not delete live lead data casually.
- Deployment rollback: deploy the exact previous Fly image captured by `scripts/safe-deploy.sh` using its documented rollback command. No raw `fly deploy`.
- Containment: remove `/partners` from the release by reverting the commit; no existing collector or Partner portal route is modified.
