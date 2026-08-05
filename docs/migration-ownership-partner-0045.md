# Partner Migration 0045 Ownership

## Decision

`0045_partner_grading_work_items.sql` is the canonical Partner migration numbered 0045.

It owns the per-card bridge between Partner-submitted card units, connector import provenance,
MintVault destination submission items, assigned Partner graders, source R2 image keys, and the
certificate review state handoff.

## Rejected Competing Claim

`0045_partner_certificate_workflow_links.sql` was rejected as a second source of truth.

The useful workflow-link ideas belong in `partner_grading_work_items` or in later certificate,
settlement, and label migrations. They must not create a parallel table for the same Partner card
unit to certificate relationship.

## Numbering

Origin/main currently has no committed `0045_*` migration. The grading bridge therefore keeps
`0045_partner_grading_work_items.sql`.

Do not claim `0046` for the rejected certificate workflow. `0046_partner_mfa_pending_lifecycle.sql`
is already used by the Partner MFA repair branch. Any future certificate workflow, settlement, or
label work must choose the next free migration number at the time it lands.

## Landing Rule

Land the grading bridge migration, rollback, helper inclusion, and tests together. Do not rename
this migration after it has been applied anywhere.
