# Rollout — Staff Admin grading inspection viewport

**Classification:** C — presentation code requiring staging/browser proof.

## Future steps (not authorised now)

1. Local automated gates are complete. Install/enable the required Chrome
   control extension, then complete the exact browser matrix and hostile review
   against the frozen candidate SHA.
2. Owner reviews this report and independently authorises push/PR/staging.
3. Deploy the exact candidate to staging only; repeat the full zoom, anchoring and five-role matrix.
4. Stop and obtain a separate production-deploy instruction.
5. If authorised, deploy through `scripts/safe-deploy.sh`, verify exact SHA, served bundle marker and production Staff Admin flow; revert on any trigger in `rollback.md`.

## Affected surfaces

Super Admin, Staff, Grader, Admin Review and Partner grading share the shell/viewer. Permissions, evidence authority and grading semantics must remain unchanged.

## Current hold

No push, PR or staging action is safe while SIV-005 and the final hostile review
remain open. The owner must separately authorise any later push/staging action.
