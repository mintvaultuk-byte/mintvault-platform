# Implementation budget — Partner Pilot Pass 2, package A

**Written:** 2026-08-12 before implementation.

| Metric | Estimate |
|---|---|
| Files | 27 (24 Pass 1; three 0074 hardening/proof files) |
| Lines | approximately 1,900 added/removed |
| Commits | 2 provenance-preserving local commits |
| Tests | 7 targeted suites, TypeScript, production build and diff check |
| Duration | one focused integration cycle |

## Basis

Both source commits are directly inspectable and their relevant parent content
matches the candidate baseline. No environment mutation is part of this package.

## Actuals

| Metric | Actual |
|---|---|
| Files | 27 provenance-preserving source/test files |
| Lines | 942 added / 1,058 removed across the two integrated commits |
| Commits | 2 local cherry-picks with `-x`: `77b075a5`, `a520b9da` |
| Proof | 204 focused authority/MVGS tests, 17 real-PostgreSQL 0074 migration tests, TypeScript and build passed before Package B/C |

No conflict or unplanned protected-system expansion occurred.

---

## Package B budget

| Metric | Estimate |
|---|---|
| Files | 5 |
| Lines | approximately 110 added/removed |
| Commits | 1 local source-and-proof commit |
| Tests | focused flag/preview/authority tests, TypeScript, build and full available suite |
| Duration | one focused repair cycle |

The package remains below the documented 25% scope-expansion threshold and
does not alter a protected runtime or external system.

### Package B actuals

Five source/test files changed. The 94-test focused authority/preview suite,
TypeScript and production build passed. The feature gate fails closed whenever
the tenant/location flag cannot be resolved.

---

## Package C budget

| Metric | Estimate |
|---|---|
| Files | 8 |
| Lines | approximately 420 added/removed |
| Commits | 1 local source-and-proof commit |
| Tests | scanner boundary, Partner grading UI, migration source/real-PG where available, TypeScript and build |
| Duration | one focused capture-lifecycle cycle |

The migration is an unapplied source artefact. Applying it remains separately
owner-gated by PP2-F4's just-in-time production journal inventory.

### Package C actuals

Six production files, one numbered migration and two proof files changed. The
21-test scanner boundary/schema subset, TypeScript, production build and lint
all passed. The one-active-station index is source-only and the browser arm
route deliberately refuses to operate until that index exists.
