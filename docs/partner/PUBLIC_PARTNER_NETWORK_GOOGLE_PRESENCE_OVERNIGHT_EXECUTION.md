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
2. Publication: `public_partner_directory_enabled` is the independent global kill switch. `partner_location_public_profile_enabled` requires an exact location-scoped true row; normal global fallback cannot publish all locations. Organisation and location must both be ACTIVE with a meaningful name/address and approved branding display name or trading name. One shared server decision feeds public, Partner and Super Admin status.
3. Public data: new bounded SQL and explicit DTO only; no admin objects or row spreading.
4. Search: normalized free text over approved display/location/address only. No distance, coordinates, parsed geography, fake map pins or N+1.
5. Stats: approved, active, nondeleted certificates from immutable Partner/location origin only. Zero/unavailable is omitted or rendered honestly.
6. Feedback/reviews/hours/services: omitted because no canonical authority exists.
7. Google: isolated optional integration. Missing flag/config/schema/provider disables only its routes/panel; it cannot gate Partner login or operations.
8. Google migration: authored/tested as an explicit additive package, never silently applied.

## Public field classification

| Candidate | Classification | Rule |
|---|---|---|
| Location `public_ref`, public display/location name, formatted address | PUBLIC WHEN ENABLED | Exact publication opt-in plus ACTIVE/readiness checks |
| Valid business website/phone/support email/logo | PUBLIC WHEN ENABLED | Explicit public projection rule and strict validation; absent/invalid omitted |
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
| D — Google foundation | CODE COMPLETE | OAuth/PKCE/state/encryption/binding/cache/Partner/Admin and 0101; external live pilot blocked |
| E — hostile break/fix | COMPLETE | Security, privacy, UX/SEO and final hostile reviews at 0 BLOCKER / 0 HIGH |
| F — pilot/production | BLOCKED | Requires deployment/migration approval and Google prerequisites |

## External blocker

`GOOGLE LIVE PILOT BLOCKED — EXTERNAL PREREQUISITE`

The source and production secret inventory do not prove a Google Cloud project with approved GBP API access/quota, OAuth consent/callback configuration, client credentials or `GOOGLE_BUSINESS_OAUTH_ENC_KEY`. No credentials will be fabricated and no live completion will be claimed.

## Tests and behavioural evidence

- `npm run check`: pass.
- Changed-file ESLint `--quiet`: pass. Whole-repository lint exits 0 with 2,716 documented warnings and no errors.
- `npm run build`: pass (client, server and migration runners).
- SQL destructive heuristic: 0101 pass, no obvious destructive statement.
- Runnable full suite: **316 files passed, 54 environment-gated skipped; 5,168 tests passed, 998 skipped; 0 failed**. Five separately known suites need external database environment variables and were excluded from this runnable count rather than weakened.
- Super Admin control-shell HTTP suite against a disposable restricted-role PostgreSQL topology: **12/12 pass**, including step-up, boolean, cross-tenant and not-ready publication rejection.
- Focused public/Google/canonical tests: real PostgreSQL public projection, OAuth lifecycle, RLS/constraints, callback guards, cache revocation, query budget and 0101 rollback all pass.
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
