# Partner Shop Launch

This branch adds the minimum Partner Network launch layer on top of the landed G6A/G6B/G6C wallet and credit foundations plus the Partner authentication/RBAC work.

## Scope

- Partner Portal dashboard, location context, submissions, credits, packages, purchases, certificates, corrections, grading queue summary, onboarding readiness, and security.
- Super Admin package, eligibility, pilot-readiness, launch-authorisation and reconciliation controls.
- Stripe checkout/session fulfilment into the existing immutable Partner wallet ledger.
- Immutable grading-origin snapshots and Partner-origin correction routing.

It does not merge or copy G6D. Final submission settlement and deeper grading workflow coupling still require the G6D rebase.

## Roles And Permissions

Friendly labels are centralised in `server/partner/permissions.ts`. `MVGS_ASSESSMENT_TECHNICIAN` remains the stored role code and displays as `Partner Grader`.

Launch permissions include credits, purchases, grading, certificates, corrections and onboarding. Navigation is permission-gated in the Partner shell, but every route also verifies the permission server-side.

## Feature Flags

Global gates remain fail-closed:

- `partner_portal_enabled`
- `partner_authentication_enabled`
- `partner_emergency_stop`

Launch feature gates:

- `partner_payments_enabled`
- `partner_grading_enabled`
- `partner_corrections_enabled`
- `partner_pilot_enabled`

Flags are not the security boundary. Tenant identity comes from the Partner session and database RLS; pilot authorisation is stored in `partner_pilot_authorisations`.

## Credit Purchasing

Super Admin creates `partner_credit_packages`. Partners can only see active eligible packages. The browser sends only a package id and idempotency key; credits, price and currency are copied from the server-owned package row into `partner_credit_purchases`.

Stripe checkout metadata binds:

- `type=partner_credit_purchase`
- `tenant_id`
- `package_id`
- `purchase_id`

Webhook processing verifies the signed Stripe event through the existing `/api/stripe/webhook` path. Fulfilment writes exactly one `partner_credit_ledger` purchase entry with `source='stripe'` and a source-scoped idempotency key.

Duplicate events are harmless. Amount/currency mismatch, payment reversal after fulfilment, and wallet-fulfilment failure open `partner_payment_reconciliation_cases`.

## Submissions And G6D

Partner submission draft/create/edit/card intake reuses the existing Partner submission architecture. Submit now preflights available credits and reserves one G6B credit per card quantity with stable idempotency keys before handoff.

Consumption/final settlement is not duplicated here. After G6D lands, rebase and connect the final lifecycle so:

- reservation is bound to the G6D card/submission lifecycle;
- completion consumes exactly once;
- release/expiry behavior follows the reviewed G6D state machine.

## Grading Origin

`partner_grading_origin_snapshots` stores immutable historical origin evidence:

- origin type;
- Partner and location identifiers;
- display names;
- grading address;
- grader reference;
- completion timestamp;
- source submission/card linkage.

Public origin display is exposed through `/api/certificates/:certificateNumber/grading-origin`. Existing HQ certificates fall back to `MintVault Headquarters` when no Partner snapshot exists.

## Corrections

Customer correction requests use `/api/certificate-corrections`. The request does not accept a Partner id from the browser. Routing derives from the immutable origin snapshot:

- active Partner origin routes to the Partner/location;
- suspended/missing Partner origin escalates to MintVault HQ;
- Partner responses append correction events;
- Super Admin can inspect and reconcile through launch admin state.

## Readiness And Pilot Controls

Readiness evidence is stored in `partner_readiness_checks`. Launch authorisation is explicit in `partner_pilot_authorisations`; code presence alone never marks a shop launch-ready.

Expected checklist keys include agreement approval, business identity, grading staff, MFA, scanner, label printer, NFC equipment, sealer, calibration, sample submission, Stripe package access, origin display, correction routing and final launch approval.

## Migration Order

Current branch development order is:

`0018 -> 0020 -> 0021`

G6D is expected to land as:

`0019_partner_submission_credit_lifecycle.sql`

Before release, rebase and verify:

`0018 -> 0019 G6D -> 0020 -> 0021`

Do not rename `0020` to hide the temporary gap.

## Deployment Readiness

Before staging or production:

- complete hostile review;
- revalidate migration order after G6D;
- configure Partner runtime/admin database URLs;
- enable flags only for pilot tenants/locations;
- configure Stripe package/price references or allow server-created `price_data`;
- configure Stripe webhook signing secrets;
- configure Resend/domain settings;
- complete physical scanner/printer/NFC/sealer onboarding;
- train shop staff;
- complete commercial/legal approval.

Emergency stop is `partner_emergency_stop` plus tenant/location emergency controls. Rollback of `0021` refuses once payment, origin, correction, readiness, pilot or audit evidence exists.

## Known Limitations

- MVGS execution still uses the existing MintVault grading workflow; this branch exposes a Partner queue summary, not a separate grading engine.
- G6D final credit settlement remains a required integration step.
- Live Stripe objects, real invitations, real customer emails, production flags and production migrations are deliberately not created by this branch.
