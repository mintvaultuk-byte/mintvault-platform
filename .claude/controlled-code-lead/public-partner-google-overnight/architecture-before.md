# Architecture — BEFORE — Public Partner Network + Google Partner Presence

**Date captured:** 2026-08-19
**Captured from:** `origin/main@facfd36f`, live `/api/version`, Fly status/secrets inventory, SELECT-only production schema/flag aggregates, Graphify and source tracing.

```mermaid
flowchart LR
  Customer -->|public website| SPA["Static SPA + closed SEO route registry"]
  Partner -->|session + tenant RLS| Portal["Partner Portal"]
  Admin -->|Super Admin| PN["Frozen Partner Network"]
  Portal --> Org["Partner organisation/location/profile"]
  PN --> Org
  Org --> Cert["Immutable certificate-origin authority"]
  Org -. no public projection .-> SPA
  Google["Google Business Profile"] -. no integration .-> Portal
```

## Current facts

- Partner/location have stable `public_ref`; no public directory API/page or publication flag exists.
- Public SSR recognition and sitemap are static; unknown paths are real 404/noindex.
- Google credentials, schema, OAuth code and provider access proof are absent.
- Optional Google must not enter whole-portal env/schema gates.
