# Public Partner publication and Google isolation

## Context

MintVault needs customer-facing Partner discovery without exposing internal Partner DTOs or coupling an optional Google integration to the frozen Partner Portal and grading authorities. No existing publication status, human slug, Google schema or production Google prerequisites exist.

## Alternatives considered

1. Treat every ACTIVE Partner as public — rejected because operational existence is not publication consent.
2. Add a human-slug/publication workflow migration — deferred because stable external `partner_locations.public_ref` and canonical scoped flags support the safe minimal release.
3. Reuse Partner management DTOs — rejected because they contain private contacts and internal operational data.
4. Put Google config/schema into portal-wide readiness — rejected because an optional provider outage could take Partner login/operations down.

## Decision

- Use `/partners/location/:publicRef` and an explicit allowlisted public SQL/DTO.
- Require the independent global directory switch, exact location opt-in, ACTIVE organisation/location, meaningful name/address, and approved branding display name or trading name.
- Share one server publication-readiness decision across public, Partner and Super Admin surfaces; never fall back to legal name.
- Keep Google behind its own flag/config/schema gate and persist OAuth state, connection identity, encrypted credential and public cache separately in prepared migration 0103. Current main owns Growth 0101 and the public-presence schema therefore follows as 0102.
- Keep Google failure outside all grading, QA, cards, credits, stations and Partner login gates.

## Consequences

- Public pages fail closed and can be withdrawn through either global or exact-location control.
- Human-readable slugs, hours, services, coordinates and reviews remain future work until real authorities exist.
- 0101 must be separately owner-approved/applied before Google activation; production credentials and a real provider pilot remain external prerequisites.

## Evidence and affected tests

- `tests/public-partner-presence*.test.ts`, `tests/public-partner-cache-revalidation.test.ts`, `tests/public-partner-query-budget.test.ts`
- `tests/google-partner-presence-*.test.ts`, `tests/google-partner-callback-guards.test.ts`
- `tests/partner-admin-control-shell-integration.test.ts`, `tests/canonical-lineage-production-rehearsal.test.ts`
