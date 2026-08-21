# Public Partner Network + Google Partner Presence — overnight execution ledger

**Campaign date:** 2026-08-19
**Base:** `origin/main@facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
**Worktree:** `/Users/cornelius/mintvault-public-partner-google-20260819`
**Branch:** `codex/public-partner-google-overnight-20260819`

## Baseline

- Production `/api/version`: build `MV-P5-20260225-nohalf`, commit `facfd36f`.
- Final reconciliation: Fly release v1110 has two started machines with passing HTTP health checks; it still reports commit `facfd36f`.
- Production journal reaches repository migration `0100`; Partner location migration `0084` is applied.
- Two ACTIVE Partner organisations, one ACTIVE Partner location, zero ready branding rows and zero approved Partner-origin certificates were observed through aggregate-only SELECTs.
- No Google client ID, client secret, separate OAuth encryption key, callback/access/quota proof or Google schema exists.
- Partner Network v1 remains frozen and is an authority source only.

## Graphify / authority impact

- Baseline code-only graph: 1,387 files, 12,604 nodes, 28,007 edges. Candidate refresh: 1,404 classified/cached files, 12,725 nodes, 28,424 edges; update check passed.
- Source and database verification overrode graph gaps.
- Canonical sources reused: Partner organisation/location/profile/branding, feature flags, certificate origin, Partner session/RBAC/audit and existing safe Maps fallback.
- New surfaces are consumers/integration boundaries only; no grading/QA/payment/station/credit authority changes.

## Decisions

1. Public URL: `/partners/location/:publicRef`. `partner_locations.public_ref` is globally unique, stable and explicitly external; internal IDs are never returned.
2. Publication: `public_partner_directory_enabled` is only the independent global kill switch. Current main owns Growth 0101, so Public Partner publication is migration 0102. It stores Partner-Owner-attested public-only values and one privacy class per location; Super Admin can list only the exact current consented versions. Organisation and location must also be ACTIVE. Operational names, addresses and contacts are never fallback public inputs.
3. Public data: new bounded SQL and explicit DTO only; no admin objects or row spreading.
4. Search: normalized free text over approved public display/location/address/service-area values only. No distance, coordinates, parsed geography, fake map pins or N+1.
5. Stats: approved, active, nondeleted certificates bound to both immutable Partner and Location origin. A true zero remains zero; unavailable is omitted.
6. Feedback/reviews/hours/services: omitted because no canonical authority exists.
7. Google: isolated optional integration. Missing flag/config/schema/provider disables only its routes/panel; it cannot gate Partner login or operations.
8. Google migration: authored/tested as an explicit additive package, never silently applied.

## Public field classification

| Candidate | Classification | Rule |
|---|---|---|
| Location `public_ref`, consented public display/location name | PUBLIC WHEN ENABLED | Partner Owner attests exact version; Super Admin approves/list exact version; ACTIVE checks |
| Public storefront street address | PUBLIC WHEN ENABLED | Explicit `PUBLIC_STOREFRONT` classification and per-field consent; never copied from operational address |
| Service area | PUBLIC WHEN ENABLED | `SERVICE_AREA_PRIVATE_ADDRESS`; street address and Maps are structurally absent |
| Valid public website/phone/email | PUBLIC WHEN ENABLED | Per-field consent plus strict server validation; absent/invalid omitted |
| Partner designation and approved certificate count | PUBLIC WHEN ENABLED | Derived from canonical status/origin facts |
| Org/location internal IDs, tenant IDs, legal/company/VAT data | PRIVATE / SUPER ADMIN ONLY | Never in public DTO |
| Staff, personal contacts, notes, audit/security, MFA/auth/session | PRIVATE | Never exposed |
| Wallet/credits, station credentials, Card Jobs, submissions/customer PII, QA | PRIVATE / operational | Never exposed |
| Google refresh/access tokens, OAuth code/verifier/state | SECRET | Server-side only; tokens never in browser/audit/logs |
| Google public business identity/maps snapshot | PUBLIC WHEN ENABLED | Only after explicit binding; cached allowlisted fields |

## Package status

| Phase | State | Notes |
|---|---|---|
| A — evidence/data contract | COMPLETE | Three specialist reports; lead verification; manifest frozen |
| B — public Partner profile | COMPLETE | Public DTO/API, direct SSR/404/meta/schema, profile, Maps, stats and operator visibility |
| C — Find a Partner | COMPLETE | Searchable directory, global discovery, truth-aligned near-me page, dynamic sitemap, cache revocation |
| D — Google foundation | CODE COMPLETE | OAuth/PKCE/state/encryption/binding/cache/Partner/Admin and optional 0103; external live pilot blocked |
| E — hostile break/fix | COMPLETE | Security, privacy, UX/SEO and final hostile reviews at 0 BLOCKER / 0 HIGH |
| F — pilot/production | BLOCKED | Requires deployment/migration approval and Google prerequisites |

## External blocker

`GOOGLE LIVE PILOT BLOCKED — EXTERNAL PREREQUISITE`

The source and production secret inventory do not prove a Google Cloud project with approved GBP API access/quota, OAuth consent/callback configuration, client credentials or `GOOGLE_BUSINESS_OAUTH_ENC_KEY`. No credentials will be fabricated and no live completion will be claimed.

## Tests and behavioural evidence

- `npm run check`: pass.
- Changed-file ESLint `--quiet`: pass. Whole-repository lint exits 0 with 2,716 documented warnings and no errors.
- `npm run build`: pass (client, server and migration runners).
- SQL destructive heuristic: additive public 0102 and optional Google 0103 pass, no obvious destructive statement.
- Runnable full suite after the hostile repair gate: **319 files passed, 54 environment-gated skipped; 5,181 tests passed, 998 skipped; 0 failed**. Five separately known suites need external database environment variables and were excluded from this runnable count rather than weakened.
- Super Admin control-shell HTTP suite against a disposable restricted-role PostgreSQL topology: **12/12 pass**, including step-up, boolean, cross-tenant and not-ready publication rejection.
- Focused public/Google/canonical tests: real PostgreSQL consent/approval/projection, OAuth lifecycle, RLS/constraints, callback guards, cache revocation, query budget and disposable 0102/0103 rollbacks all pass.
- Controlled public load: 100 eligible locations, 36 directory/search/profile requests in batches of 12; **0 errors, p50 5.80 ms, p95 11.53 ms** on disposable local PostgreSQL. Directory/search/profile stay at three bounded SQL calls per request regardless of 100 rows.
- Browser: 390×844 and 1440×900, no horizontal overflow, semantic single H1/main/search label, result-to-profile navigation, authoritative conditional CTAs and keyboard Enter search pass.

## Hostile findings and repairs

- Public review: legal-name fallback, boolean coercion and missing global step-up repaired; final public re-review 0 BLOCKER / 0 HIGH.
- Google review: callback freeze/stale-step-up bypass, exact target-location freeze bypass and non-owner candidate disclosure repaired; final security and hostile re-reviews 0 BLOCKER / 0 HIGH.
- UX/SEO review: infinite client-cache revocation and false-Live display-name mismatch repaired with mounted cache tests and one shared readiness decision; targeted re-review clear at 0 BLOCKER / 0 HIGH.

## Release state

- Candidate implementation is locally complete and release-ready for an owner-authorised staging sequence.
- No push, merge, deploy, target migration, secret mutation, flag activation or real Google call occurred.
- Production remains `facfd36f`, Fly v1110, two started/healthy machines, and unchanged Partner public/Google activation state.
- Public Partner Network is code complete; production acceptance requires the protected rollout.
- Google Partner Presence is code complete; its live pilot remains externally blocked.

## Addendum completion — privacy and exact preview

- Four server-owned classifications exist: `PUBLIC_STOREFRONT`, `SERVICE_AREA_PRIVATE_ADDRESS`, `NOT_PUBLIC`, and `INCOMPLETE_UNVERIFIED`.
- A Partner Owner with a fresh step-up attests the exact public business/location/contact fields. Consent is recorded per populated field and version. Editing any public location output clears its approval and listing immediately; changing the shared public business name also unlists every location.
- Super Admin cannot edit Partner public values. A fresh step-up can only approve/list or unlist the exact current version after reviewing the exact customer DTO.
- Partner and Super Admin previews use the same `PublicPartnerProfileView` component and the same allowlisted DTO mapper as the public API. Authenticated status and previews are `private, no-store`.
- Service-area profiles show no street address, Directions or Maps. Public storefront Maps requires explicit consent. Google remains optional and is read only when its separate global switch is enabled.
- Browser click analytics were not added because the active cookie notice promises “No analytics or tracking”. Existing non-sensitive request path/status/duration telemetry remains available; CTA events require an owner/legal policy change.

## Production monitoring checklist (required after protected rollout)

1. Start with one Partner-attested, Super-Admin-approved location and the global directory switch off. Capture the exact 0102 migration journal row, consent/approval versions and public preview; do not copy operational values.
2. Turn on the global directory switch and, within 30 seconds, verify: directory API/HTML 200, exact profile API/HTML 200, canonical URL, sitemap inclusion, conditional structured data and safe website/phone/Maps links. Verify a malformed ref and a well-shaped unknown ref each return indistinguishable 404 responses and do not appear in search/sitemap. Test an unpublished ref only when an existing legitimate owner-authorised target is available; keep suspended and cross-tenant isolation proof in staging/disposable PostgreSQL unless matching legitimate production records already exist. Do not create or suspend a production record merely to exercise this check.
3. Verify the directory empty state with a no-match search and at 390, 768, 820, 1024, 1280 and 1440 CSS pixels. At 768–1024 the compact menu must remain available with no horizontal overflow. Keyboard focus, visible labels and one H1 must remain intact.
4. Inspect JSON, initial HTML and application logs for operational address, legal name, staff/customer data, tenant/internal IDs, tokens and provider payloads. Any private-field appearance is an immediate kill-switch event.
5. The application emits method/path/status/duration telemetry for `/api/public/partners`, `/find-a-partner`, `/partners/location/*` and `/sitemap.xml` without response bodies. At 15 minutes, 1 hour and 24 hours, the release owner must run `fly logs --app mintvault --no-tail > /tmp/mintvault-public-rollout.log` followed immediately by `node scripts/public-partner-rollout-metrics.mjs /tmp/mintvault-public-rollout.log --minutes=15`. The denominator is every GET/HEAD sample on those four route families in the preceding 15 minutes; 404s remain in the denominator but are not server errors. The script returns exit 2 and `ROLL_BACK` when there are no samples, 5xx exceeds 1%, or p95 exceeds 500 ms. Retain the JSON output in release evidence.
6. Exact rollback action: a freshly stepped-up Super Admin opens **Partner Network → Settings**, sets `public_partner_directory_enabled` to **Off**, and records the threshold breach as the required reason. Prove the directory/profile/sitemap entry disappears within 30 seconds. No cookie-bearing shell command is used or stored. Re-enable only after the release owner confirms the prior checks.
7. Keep Google off unless its separate credential/API pilot passes. Public storefront directions must continue through the consented encoded-address fallback; service-area/private locations must still show no Maps link.
