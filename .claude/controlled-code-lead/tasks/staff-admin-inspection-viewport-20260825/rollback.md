# Rollback — Staff Admin grading inspection viewport

## Trigger conditions

- Any card crop, overlay drift, cumulative resize, role/capability regression, protected MVGS change, or browser matrix failure.
- Staging shows a source image, defect, line or centering overlay that does not remain on its underlying feature.

## Before push/deploy

- Revert the local candidate commit or discard only the manifest-listed files after checking `git status`; never reset the unrelated original worktree.

## After a future push/deploy

- `git revert <candidate-sha>` on the release line and use the separately owner-authorised safe deployment path to restore `01d5e4da` behavior.
- No database/data rollback: this change has no migration and never rewrites defect/crop/centering records.

## Verification

- `/api/version` identifies the intended rollback SHA.
- The focused viewer/Card Tool/MVGS tests pass and the browser geometry returns to the recorded baseline.
