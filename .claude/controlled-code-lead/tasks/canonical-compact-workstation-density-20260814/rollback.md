# Rollback — Canonical compact grading workstation density

## Trigger

Rollback if any role loses a required control, inspection state, preview, revision/CAS guarantee, scanner/station access, Partner capability restriction, or an after-deploy visual regression blocks normal grading.

## Method

1. Revert the single merged compact-workstation PR commit(s) on `main`; do not alter protected grading data or migrations.
2. Run the required protected CI on the revert PR.
3. Deploy the merged revert only through `scripts/safe-deploy.sh` after live-lineage verification.
4. Verify both Fly machines, `/health`, `/ready`, and `/api/version` report the revert commit.

This is a presentation-only rollback: it must not delete certificates, images, scans, audit records, or database state.
