# GB-03 — Founding Partner acquisition handover

## Purpose and route

GB-03 adds the public acquisition route `/partners`. It is intentionally distinct
from `/partner` and `/partner/*`, which remain the existing operational Partner
portal. The page invites selected UK TCG and collectibles retailers to apply for
the first rollout; it does not offer an account, approval, exclusivity, a launch
date, operational readiness, equipment, pricing, margins or earnings.

Until both the privacy-notice publication flag and the default-off
`PARTNER_APPLICATIONS_LIVE` release flag are enabled, the page is deliberately
noindex and omitted from the sitemap, with no application CTA. This prevents a
legal-pack release from opening PII capture before migration/proof. It does not
add a public directory, location pages, or consumer-funnel advertising.

## Lead boundary and storage

`partner_applications` is a new additive table introduced in
`migrations/0095_growth_partner_applications.sql`.

- It has no foreign key or code dependency on Partner tenants, users, wallets,
  credits, stations or onboarding.
- A UUID application ID, server timestamp, `NEW` status, source, limited
  attribution, structured qualification fields and a PII-minimised audit event
  are created atomically.
- Permitted lead states are `NEW`, `CONTACTED`, `QUALIFIED`, `NOT_A_FIT` and
  `ONBOARDING`. GB-03 deliberately does not build a CRM/admin view or any
  operational Partner state transition.
- A SHA-256 key based on normalised business name and email gives accidental
  retries the same opaque receipt and prevents duplicate inbox notification.
- There is no public read/list/status route. The API response contains only
  `{ ok, leadId }`.

The table must be applied only with an owner-approved production migration. The
rollback SQL is intentionally cautionary: lead records are personal data, so do
not drop them before retention/export obligations have been assessed.

## Privacy, attribution and notification

The application captures only form-provided business/contact fields, the fixed
route `/partners`, allowlisted bounded UTM values, a referrer **origin** (never
path/query/hash), and the submitted timestamp. It adds no analytics, cookies,
fingerprinting or raw IP/user-agent storage. Partner applications do not collect
marketing consent or subscribe an applicant to marketing.

The route is protected by the existing same-origin CSRF middleware and a
dedicated three-per-hour rate limit. It validates all inputs with a strict Zod
schema, accepts only credential-free HTTP(S) business URLs, and never lets an
applicant choose a status. Its response body is suppressed from the request log.

The record is committed before the configured `CONTACT_INBOX_EMAIL` notification
is attempted. Notification outcome is recorded; a Resend failure cannot discard
the lead. The internal email has a fixed subject and HTML-escapes untrusted
fields. GB-03 deliberately sends no applicant acknowledgement, so application
does not imply acceptance, access or marketing permission.

## Publication gate

The public page fails closed and the endpoint returns `503` until
`PRIVACY_NOTICE_LIVE=true` **and** `PARTNER_APPLICATIONS_LIVE=true`. The same
pure gate controls the endpoint, SSR metadata and sitemap. `LEGAL_PAGES_LIVE`
is intentionally independent and must not be changed for this release.

Apply migration `0095`, deploy the reviewed candidate through the established
release process with both flags initially false, then publish the reviewed
notice and the dedicated application flag in that order. Submit one
unmistakably labelled non-customer test lead. Verify durable storage,
notification result, retry receipt, absence of public lookup and the
`/partners` SSR/sitemap result. Do not create a Partner account.

## Verification

- `tests/growth-command-gb03.test.ts`: page rendering and truthful boundary,
  legal fail-closed state, validation, attribution, durable/audited write seam,
  duplicate behavior, logging, email contract and SSR/sitemap.
- `tests/growth-command-pass-b1.test.ts`: B1 paid-confirmation and search policy
  regression. Its private-route assertion is intentionally exact for `/partner`
  rather than incorrectly excluding the distinct public `/partners` route.
- `npm run check`, `npm run lint`, `npm run build`, `git diff --check` are the
  required candidate gates; record final outputs in the task ledger before a
  release request.

## Future interface

The future Partner/Super Admin programme may consume a `QUALIFIED` or
`ONBOARDING` lead only through an explicitly designed, audited handoff. That
handoff must create a tenant/onboarding record separately and never treat an
application as approval, identity proof, operational readiness or credit.
