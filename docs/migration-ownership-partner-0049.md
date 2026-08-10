# Partner Migration 0049 Ownership

## Decision

`0049_partner_grading_work_items.sql` is the canonical Partner migration numbered 0049.

It owns the per-card bridge between Partner-submitted card units, connector import provenance,
MintVault destination submission items, assigned Partner graders, source R2 image keys, and the
certificate review state handoff.

## Rejected Competing Claim

`0045_partner_certificate_workflow_links.sql` was rejected as a second source of truth.

The useful workflow-link ideas belong in `partner_grading_work_items` or in later certificate,
settlement, and label migrations. They must not create a parallel table for the same Partner card
unit to certificate relationship.

## Numbering — the full picture

The grading bridge was originally written as `0045`. It has been renumbered to `0049`. It has
**never been applied anywhere**, so renumbering it is legal under the "never rename an applied
migration" rule.

| Number | Owner | State |
|---|---|---|
| 0044 | `0044_partner_submission_lifecycle_and_location_snapshot.sql` | on `origin/main` |
| 0045 | **deliberately left unused** | see below |
| 0046 | `0046_partner_mfa_pending_lifecycle.sql` (partner MFA repair branch) | **APPLIED ON STAGING** |
| 0047 | `0047_partner_owner_invariant_tenants_rls.sql` — security repair, A8-F1 | new, unapplied |
| 0048 | `0048_partner_location_snapshot_search_path.sql` — security repair, A8-F2 | new, unapplied |
| 0049 | `0049_partner_grading_work_items.sql` — grading bridge | new, unapplied |

**Why 0045 is left permanently unused.** `0046` is already journalled on staging. Every rollback
script in this series guards itself with "refuse if any journal row is numbered above my own
number" — so anything landing at `0045` would be born un-rollbackable on staging, a one-way door.
The number is burnt. Do not reuse it.

**Why the two security repairs sit BELOW the grading bridge.** The alternative — bridge at 0047,
repairs at 0048/0049 — would mean an operator rolling back the grading bridge has to roll back the
RLS fix and the `search_path` fix first, because each rollback refuses while a higher-numbered
migration is journalled. That couples a feature rollback to a security regression. With the bridge
highest, `rollback-0049` runs cleanly while both repairs stay applied.

## Landing Rule

Land the grading bridge migration, rollback, helper inclusion, and tests together. Do not rename
this migration after it has been applied anywhere. Any future Partner migration must take the next
free number **above 0049** — never 0045.
