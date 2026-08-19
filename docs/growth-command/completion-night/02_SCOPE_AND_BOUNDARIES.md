# Scope and Boundaries

| Domain         | This program may                                                                                                                   | This program must not                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Growth         | Add truthful aggregate reads, safe event instrumentation, review workflow, provider adapters, public authority pages and Growth UI | Fabricate data, create multiple dashboards, send outreach, spend on ads, become payment/operational authority |
| Partner        | Read application pipeline aggregates and preserve opaque handoff                                                                   | Provision tenants/users/locations/stations, approve Partners, change credits or operational status            |
| Scanner        | Read only bounded fleet/service health if canonical authority exists                                                               | Change station, device, capture, evidence or Scanner auth behaviour                                           |
| Core grading   | Use already-public approved aggregate facts only                                                                                   | Change MVGS maths, weights, gates, workflow, grading UI, evidence or labels                                   |
| Payments       | Read verified paid state and revenue aggregates                                                                                    | Change Stripe/webhook/checkout/pricing/refund/credit/VAT behaviour                                            |
| Infrastructure | Add server-side, bounded, cached read adapters and documentation                                                                   | Change secrets, DNS, scaling, machine topology or deploy path without the protected release gate              |
| Data/privacy   | Add minimum-data, aggregate-only, auditable records where justified                                                                | Expose customer identity, unpublished grades, evidence, addresses, email or confidential Partner data         |

## Allowed local action

Read-only inspection; creation of durable control files; local code/tests/docs on the isolated branch after Stage 3 verification and a written manifest; local commits; safe local and production-read-only verification.

## Protected action gates

Push, dependency changes, migrations on any environment, secret/config writes, provider writes, auth/payment/grading changes, staging/production writes and deployment require a specific recorded approval under repository governance. The mission contains a production-deployment grant for Growth packages after all gates, but that grant will be validated and recorded again at the release checkpoint; it does not waive migration, push, secret or destructive-action gates.
