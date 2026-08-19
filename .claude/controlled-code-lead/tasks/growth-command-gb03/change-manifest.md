# Change manifest — Growth Command GB-03

## Authority and boundary

The owner’s GB-03 brief authorises the local implementation and a production deployment only if every gate passes. It does **not** authorise applying a database migration, publishing a solicitor-review privacy draft, changing a legal feature flag, or altering Partner operations. This package therefore creates source and migration artifacts only; live activation requires the separate owner/legal decision recorded as GB03-F2.

## Files to change

| File set | Change | Why | Class |
| --- | --- | --- | --- |
| `migrations/0091_growth_partner_applications.sql`, rollback | Isolated additive lead table, statuses, dedupe invariant and indexes. | GB03-F1 durable structured lead; no Partner tenant/account relation. | E |
| `shared/schema.ts`, `server/routes/public.ts`, `server/email.ts`, `server/lib/request-logger.ts` | Strict public application contract, persistence-before-notification, safe internal notification and response-log suppression. | GB03-F1/F4. | B/F |
| `client/src/pages/partners.tsx`, `client/src/App.tsx`, `client/src/components/v2/footer-v2.tsx` | Public, mobile-first acquisition page and footer discovery link. | GB03-F3. | B |
| `server/seo-config.ts` | SSR metadata and sitemap entry for the genuine `/partners` page. | Discoverability without a directory or doorway pages. | B |
| `tests/growth-command-gb03.test.ts`, handover/ledger documents | Executable route/SEO/security/notification contract and handoff. | Regression proof and future Partner interface. | A/B |

## Explicitly not changed

- No Partner auth, tenant, onboarding, credit, station, Scanner, Partner admin or public-directory code.
- No Stripe/payment, MVGS/grading, certificate, R2 or secret/configuration change.
- No production database mutation, migration application, email send, feature-flag change, push or deployment in this implementation stage.
