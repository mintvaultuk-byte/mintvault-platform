# Rollout — Canonical compact grading workstation density

1. Capture source and browser baseline from `839edd9c`.
2. Implement only the approved shared presentation changes in the isolated worktree.
3. Complete tests, mutation proof, viewport evidence, and an independent read-only hostile UI review; repair any actionable in-scope HIGH finding in this pass.
4. Reconcile the branch with current `origin/main`, push a protected PR, and require the named CI gates on the exact final head.
5. Merge only after CI is green and branch protection is satisfied.
6. Recheck production lineage; deploy the exact merge only if it remains current and all release gates hold, through `scripts/safe-deploy.sh`.
7. Verify the release artifact, two Fly machine states, `/health`, `/ready`, and `/api/version`.
