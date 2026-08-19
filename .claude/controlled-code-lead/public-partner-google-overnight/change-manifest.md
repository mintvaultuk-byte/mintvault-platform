# Change manifest — Public Partner Network + Google Partner Presence

**Date:** 2026-08-19
**Lead session:** `codex/public-partner-google-overnight-20260819@facfd36f`

## Findings this manifest addresses

- PPN-001 through PPN-009 — public publication, safe projection, discovery, SEO and operator wiring — classifications A/B.
- GBP-001 through GBP-005 — isolated Google code/test/schema foundation — classifications B/E/F.
- GBP-006 — externally blocked live pilot — unavailable UX and truthful evidence only.

## Findings explicitly deferred

- Google migration application, environment secrets, production/staging activation and live pilot: owner approval and external credentials/access required.
- Human slugs, redirect aliases, structured address/hours/services/coordinates/reviews: no source authority and not required for safe minimal v1.

## Files to change

| Surface / expected files | Change | Why | Class |
|---|---|---|---|
| `server/partner/flags.ts`, `server/partner/admin-routes.ts` | Add independent rollout/publication flags and enforce tenant/location ownership | PPN-001/004 | B |
| `server/partner/public-presence-service.ts`, `server/partner/public-presence-routes.ts` | Bounded public SQL/DTO, eligibility, search, stats, safe URLs/Maps, Google fallback | PPN-001/003/005 | B |
| `server/routes.ts`, `server/static.ts`, `server/seo-config.ts` | Register public API, dynamic SSR 404/meta and dynamic sitemap | PPN-006 | B |
| `client/src/pages/find-a-partner.tsx`, `client/src/pages/public-partner-profile.tsx`, `client/src/App.tsx` | Public directory/profile routes and accessible mobile UX | PPN-006/007 | A/B |
| `client/src/components/v2/header-v2.tsx`, `footer-v2.tsx`, `client/src/pages/seo/card-grading-near-me.tsx` | Discovery links and truthful local-intent content | PPN-007/008 | A/B |
| `client/src/pages/partner/public-profile.tsx`, Partner API/routes, admin location view | Partner publication controls/readiness and Super Admin state/page/Maps links | PPN-009 | A/B |
| `migrations/0102_partner_google_presence.sql`, rollback | Add isolated Google state/binding/cache/credential authorities and constraints | GBP-001/003 | E |
| `server/partner/google-presence-*`, Partner API/UI, admin location view | Local config/schema gate; OAuth/state/PKCE/encryption; explicit binding; view-only admin | GBP-001/002/004/005 | F |
| `tests/*public-partner*`, `tests/*google-presence*`, migration inventories | Unit, route, real-Postgres, SEO, leak, OAuth, isolation and render proof | all | B/E/F |
| Task/campaign governance docs and graph | Evidence, rollout, rollback, proof and graph parity | governance | G |

Exact filenames may be consolidated within these declared surfaces; no new product authority outside them is permitted.

## Files explicitly NOT touched

- Grading workstations, grade writers/maths, QA, certificate issuance/print, Scanner, P2/P6.
- Wallet/credits, payments/Stripe, stations/connectors, customer authentication.
- Partner session/MFA authority except consuming existing owner/step-up guards.
- Production/staging configuration or secret values.

## Protected actions required

- [x] Additive Google migration authored and tested — explicitly requested as an “explicit package”; application is not authorized.
- [x] External provider foundation — explicitly requested; live credentials/calls are not authorized/available.
- [ ] Push/merge/deploy — not authorized.
- [ ] Apply migration — not authorized.
- [ ] Set secrets or activate production flags — not authorized.

## Order of operations

1. Public authority/DTO/API and hostile data-contract tests.
2. Public pages, operator controls and SEO/SSR/sitemap.
3. Additive Google schema and provider/state/crypto foundation.
4. Partner panel and Super Admin view-only integration.
5. Full gates, performance/accessibility evidence, hostile review and repair.

## Regression gates required

- `npm run check`, full `npm test`, `npm run lint`, `npm run build`.
- Focused public/Google/Partner regressions, real PostgreSQL migrations/RLS contracts where loopback DB is available.
- Direct server-render route/status/meta/sitemap tests.
- Controlled local performance check and no-N+1 query proof.
- Secret scan, diff allowlist, `git diff --check`, Graphify update/check, Engineering OS postflight.
- Local browser desktop/mobile/keyboard smoke when the app can be booted.

**Approved to proceed to Stage 5:** owner overnight completion command authorizes local implementation and explicit reviewed migration preparation; protected application/deployment remains unapproved — 2026-08-19.

## Owner addendum manifest — resumed, not restarted

| Surface / expected files | Change | Why | Class |
|---|---|---|---|
| `migrations/0101_partner_public_presence.sql` + rollback | Add separate Partner/public-location consent, approval and privacy authorities; RLS public-draft tables | Operational addresses are not public authority | E |
| Existing Google migration/tests/inventories | Renumber unapplied Google package to 0102 so public launch can apply 0101 without activating or depending on Google | Google must not block public launch | E/F |
| `shared/public-partner.ts`, `server/partner/public-presence-*` | One explicit public DTO/projection, preview/status, versioned consent/approval and retryable availability state | Exact preview and fail-closed privacy | B |
| Partner + Super Admin routes/UI | Owner step-up consent/edit; Super Admin step-up approve/unpublish; shared exact preview and completeness | Separate Partner intent from publication approval | B |
| Public directory/profile/SSR/sitemap/header | Nullable address/Maps, service-area truth, conditional CTA/schema, retryable 503 and tablet-safe navigation | No home-address, false storefront claim or outage-driven deindexing | B |
| Focused unit/HTTP/PostgreSQL/browser-source tests and campaign docs | Mutation, cross-tenant, private leakage, preview parity, analytics privacy, monitoring checklist | Behavioural/adversarial proof | B/E/G |

No operational location field is copied to the public DTO automatically. Editing a consented public field increments its version and immediately invalidates approval/listing until a Super Admin approves that exact version.

Browser-event analytics is excluded: the active cookie notice promises “No analytics or tracking.” The existing request logger remains the only in-scope non-sensitive traffic telemetry; CTA analytics is a recorded owner/legal follow-up, not business `audit_log`.

## Post-package hostile repair manifest

| Surface / expected files | Change | Why | Class |
|---|---|---|---|
| Partner/Admin publication routes, services and clients | Carry independent expected profile/location versions; compare under locks; reject stale drafts/approvals | PPN-023/027 exact reviewed-output integrity | B/E |
| `server/lib/request-logger.ts`, public HTTP/metrics tests and rollout ledger | Suppress private admin bodies; emit body-free bounded public route timing/status; add tested 15-minute threshold analyser | PPN-026/028 privacy and executable rollback evidence | B/G |
| Public and authenticated profile pages | Distinguish retryable 503; use the established keyboard-modal primitive with explicit focus restoration | PPN-024/025 customer truth and accessibility | A/B |
| Public publication DB/HTTP/UI tests | Stale location, shared-name, cross-location form, private-log, retry, focus and telemetry regressions | PPN-023–028 | B/E/G |

The repair does not alter either migration, public eligibility, Google authority, grading, Scanner, payments, stations or production state.
