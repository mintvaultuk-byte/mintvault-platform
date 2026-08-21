# Architecture — AFTER — Public Partner Network + Google Partner Presence

**State:** AS BUILT / LOCALLY VERIFIED (not deployed)
**Date:** 2026-08-19

```mermaid
flowchart LR
  Customer --> PublicAPI["Explicit public-safe Partner API"]
  Customer --> SSR["DB-aware SSR metadata + sitemap"]
  PublicAPI --> PubGate["Owner consent + exact-version Admin approval + global switch + ACTIVE checks"]
  SSR --> PubGate
  PubGate --> Core["Canonical Partner + immutable certificate origin"]
  Partner --> GPanel["Google panel"]
  Admin -->|view-only| GState["Google/public state"]
  GPanel --> GGate["Google-only flag + env + schema gate"]
  GGate --> OAuth["State/PKCE + explicit selection/confirmation"]
  OAuth --> GBP["Google Business Profile API"]
  OAuth --> GDB["Separate binding / cache / encrypted credentials"]
  GDB --> PublicAPI
  GGate -. failure isolated .-> GPanel
```

## Deliberately unchanged

- Grading, QA, certificates, cards, credits, stations, payments and Partner authentication authorities.
- Google cannot publish a location, change canonical MintVault address, or gate the Partner Portal.
- No reviews, ratings, hours, services or coordinates are invented.

## AS-BUILT confirmation

- The public surface uses an explicit allowlisted SQL/DTO and one shared publication decision; legal names and private management objects never become fallback public data.
- Google config/schema/provider failure is route-local. The portal-wide readiness/schema gates remain unchanged.
- Public 0101 and optional Google 0102 are additive, forced-RLS where tenant-scoped, migration-inventory classified, and applied/rolled back only in disposable PostgreSQL.

## Addendum target architecture

```mermaid
flowchart LR
  Ops["Operational location/address"] -. never projected .-> Public
  Owner["Partner Owner + fresh step-up"] --> Consent["Versioned public-only values + privacy class"]
  Admin["Super Admin + fresh step-up"] --> Approval["Approve exact consent version"]
  Consent --> Approval
  Approval --> Gate["Global switch + ACTIVE org/location + Partner listed + Location listed"]
  Gate --> Public["One allowlisted DTO used by preview/API/SSR/sitemap"]
  Public --> Logs["Existing path/status/duration request telemetry"]
  Google["Optional Google 0102"] -. optional exact Maps URI only when Maps consented .-> Public
```

The public privacy substrate is migration 0101; optional Google becomes 0102. A public launch can therefore proceed with approved MintVault public values and encoded Maps-address links while Google stays disabled.
