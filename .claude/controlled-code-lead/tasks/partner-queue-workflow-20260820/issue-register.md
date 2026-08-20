# Issue register — Partner queue evidence and shop-floor workflow

| ID | Summary | Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PQW-F1 | Queue removes cards with a missing physical capture side before the operator can see that state. | Owner report + source | high | confirmed | `server/partner/grading-routes.ts` queue predicates | B/C | yes | Full regression + focused evidence/UI tests | local task commit | pending | unchanged | not activated | fixed | The queue now projects both sides through a certificate-id keyed ledger batch. Missing, invalid and unavailable sides remain visible and cannot be labelled ready. |
| PQW-F2 | Current browser inspection source can silently fall back from working evidence to legacy/display URLs; the Partner adapter drops the admitted evidence status. | Owner report + source + staging ledger | high | confirmed | `client/src/components/grading/image-viewer.tsx`, `server/partner/grading-routes.ts:imagesForPartnerCert` | B/C | yes | Full regression + focused evidence/UI tests | `497ce8c6` + local task commit | pending | unchanged | not activated | fixed | The workstation admits only exact-dimension Canon 1200-DPI `*_working` JPEG evidence. The Partner adapter now preserves the same server verdict; a stale URL cannot authorize a thumbnail. |
| PQW-F3 | Primary Partner navigation exposes dead placeholder Supplies, Orders and Public Profile pages. | Owner report + source | high | confirmed | `client/src/components/partner/partner-shell.tsx`, `client/src/pages/partner/workflow-placeholder.tsx` | A/C | yes | Full regression + navigation source tests | local task commit | pending | unchanged | not activated | fixed | The launch shell has five primary workflow destinations and role-gated secondary routes. Legacy live routes remain mounted and server-authorized; Supplies, Orders and Public Profile are absent from launch navigation. |

## Rejected findings

- None.

## Deferred findings

- None. Customer ownership is optional in the existing server submission authority; the client alone forces the CRM step. Historical records remain untouched.

## Fixed findings

- None yet.
