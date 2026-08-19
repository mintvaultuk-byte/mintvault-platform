# Change manifest — Growth Command GB-03

## Authority and boundary

The B2-R owner brief authorises the controlled production migration, publication of the reviewed privacy notice, dedicated release flags and deployment only after every stated gate passes. It does not authorise any Partner operational change. Publication remains fail-closed behind both `PRIVACY_NOTICE_LIVE` and `PARTNER_APPLICATIONS_LIVE`.

## Files to change

| File set | Change | Why | Class |
| --- | --- | --- | --- |
| `migrations/0095_growth_partner_applications.sql`, rollback | Isolated additive lead table, statuses, dedupe invariant and indexes. | GB03-F1 durable structured lead; no Partner tenant/account relation. | E |
| `shared/schema.ts`, `server/routes/public.ts`, `server/email.ts`, `server/lib/request-logger.ts` | Strict public application contract, persistence-before-notification, safe internal notification and response-log suppression. | GB03-F1/F4. | B/F |
| `client/src/pages/partners.tsx`, `client/src/App.tsx`, `client/src/components/v2/footer-v2.tsx` | Public, mobile-first acquisition page and footer discovery link. | GB03-F3. | B |
| `server/seo-config.ts` | SSR metadata and sitemap entry for the genuine `/partners` page. | Discoverability without a directory or doorway pages. | B |
| `tests/growth-command-gb03.test.ts`, handover/ledger documents | Executable route/SEO/security/notification contract and handoff. | Regression proof and future Partner interface. | A/B |

## Explicitly not changed

- No Partner auth, tenant, onboarding, credit, station, Scanner, Partner admin or public-directory code.
- No Stripe/payment, MVGS/grading, certificate, R2 or secret/configuration change.
- No Partner tenant/account creation, operational onboarding, or public application lookup.
