# Rollout — Canonical grading live absorb

**Classification:** G (controlled release operation; no schema change intended)

## Pre-rollout checklist
- [ ] Live lineage absorbed naturally into final candidate.
- [ ] All requested local and CI gates pass for the exact final SHA.
- [ ] Migration identity reconciled; no migration ambiguity or application needed.
- [ ] Current live SHA remains an ancestor of the release SHA.
- [ ] Protected PR is mergeable and current main has not moved.
- [ ] Owner’s conditional release authorisation in the runbook is recorded as satisfied.

## Steps
1. Merge the isolated branch through a normal protected PR after all checks are green.
2. Re-read production and run the natural ancestry guard against the merged main SHA.
3. In this foreground session only, deploy the exact merged SHA with `scripts/safe-deploy.sh prod` if every runbook condition remains true.
4. Verify both Fly machines, `/health`, final `/ready`, `/api/version`, safe route gates, and safe authenticated-browser parity if capability access is available.

## Who/what is affected
- Grading staff, Partner operators, scanner stations, and certificate preview/review flows. No database schema or payment behaviour change is intended.

## Timing constraints
- One production deploy at a time. Stop if production or main moves before the relevant gate.
