# Repository architecture damage assessment — correction and recovery baseline

**Assessment date:** 2026-09-04  
**Branch / committed baseline:** `fix/resource-hardening-staging-20260827` / `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Method:** Graphify-first inventory, then source, route, schema, migration, build, test, and governance verification by three independent read-only architecture lanes plus Lead adjudication.  
**Verdict:** `ARCHITECTURAL RECOVERY REQUIRED` / `NOT READY`

## Correction to the earlier White Ace conclusion

The earlier White Ace artifact described itself as a complete repository assessment and
said the failures were concentrated repair packages. That conclusion was not supported
by an architecture-wide wiring and authority analysis. It correctly found several
release-integrity defects, but it did not establish that the rest of the system was
architecturally bounded.

That statement is withdrawn. The prior 34-node graph remains useful only as the nested
**release-integrity subgraph** of this larger recovery program. It is not the repository
repair graph.

## How bad the damage is

The codebase is repairable, but the damage is systemic rather than local:

- The production-oriented source estate is about 333,844 lines across 968
  TypeScript/TSX/JavaScript files in `server`, `client/src`, `shared`, and `scripts`.
  Sixty-four source files exceed 1,000 lines and nineteen exceed 2,000 lines.
- `server/routes.ts` is 12,701 lines. It imports 121 modules, directly registers 199
  routes, performs 133 direct database operations, starts repair work, and manually
  mounts approximately 42 additional registrar/portal calls.
- Across `server`, 139 files import a database/pool directly while only 39 import the
  shared storage facade. Route files contain about 252 direct database operations;
  34 modules import R2; certificate writes appear 91 times across 19 modules.
- The client root declares 173 `<Route>` elements (169 with literal `path` declarations)
  and 144 `lazy(...)` calls: 140 ordinary declarations plus four DEV-conditional imports.
  Raw `fetch` remains in 102
  client files while the nominal request abstraction is used in 61. Session checks,
  logout behavior, error semantics, and cache authority are duplicated.
- Exact AST-normalized function analysis found 54 clone groups containing 145 copied
  definitions. These include server handlers/helpers and repeated home/pricing page
  implementations. The clone count is a prioritization signal, not a mandate for blind
  deduplication.
- The production import graph has confirmed harmful runtime cycles between the root
  route registrar and leaf routers, and inside the Vault Quest provider stack.
- The lint gate currently reports zero errors but 2,893 warnings, including 2,078
  explicit-`any` warnings. `server/routes.ts` alone accounts for 632 warnings.

This is not evidence that every subsystem is broken. It is evidence that architectural
authority, composition, and proof have drifted far enough that local green tests cannot
establish whole-system correctness.

## Confirmed root-cause clusters

### 1. Declared architecture and executable architecture disagree

`CLAUDE.md` describes routes and persistence as if `server/routes.ts`,
`shared/schema.ts`, and `IStorage` were singular authorities. The executable system has
multiple route roots, the main database identity plus distinct Partner credentials,
Vault Quest domain storage on the main database, direct route and service queries,
separate migration lineages, and many direct object/provider writers.

The repair is not to force every context through the already oversized `IStorage`.
MintVault needs an executable authority map and bounded-context ports for Certificate,
Submission/Payment, Identity/Auth, Print, Media, Partner, Vault Quest, and Growth.

### 2. Live client/server contracts are already broken

Confirmed examples:

- The reachable Admin Printing UI posts to a reprint endpoint deliberately removed on
  the server, so its “Reprint PDF” action always receives the unmatched-API 404.
- Admin logout is implemented inconsistently: multiple leaf pages merely navigate away,
  one uses a GET against a POST-only endpoint, and only some destroy the session.
- The global QueryClient maps 401 to `null` with `staleTime: Infinity`; typed protected
  queries assume arrays/objects and can either crash or retain protected data across a
  principal change because login/logout do not consistently clear the cache.
- Two Partner supply routers register the same orders path. Mount order makes the old
  request system shadow the paid order system used by checkout.
- The Admin Pricing UI expects snake_case records while its server/storage contract
  returns camelCase records, producing an empty grading-tier view. Public home/pricing
  pages use static commerce data while submission and payment use database-backed
  authority, allowing advertisement, selection, and charge to diverge.
- The server supports the least-privilege `SCANNER_OPERATOR` Partner role but the active
  client role model and user-management UI omit it.
- `/admin?tab=sets` is accepted as a deep link but `AdminDashboard` has no rendering
  branch for `sets`; the real page lives at `/admin/sets`.

These are consequences of missing executable route, session, role, and commercial
contract registries—not isolated typos.

### 3. Partial extraction left a coupled monolith and misleading dead bodies

The root registrar imports leaf routers that import helpers back from the root.
`server/index.ts` combines HTTP composition, readiness, workers, timers, listening, and
shutdown. `server/storage.ts` is a 4,021-line service locator. More than 500 lines of old
print logic remain unreachable after unconditional returns inside live handlers. The
Scanner watcher has the same pattern: retired entry points return while hundreds of
lines of obsolete ingestion logic remain below them.

This creates false confidence during search and review: code that looks like validation,
recovery, or auditing may not execute at all.

### 4. Schema, migration, image, and readiness truth are split

The hardened main runner recognizes the numbered main chain, while Vault Quest has a
separate partially journalled raw-SQL chain that is applied differently by CI and
operator instructions. The production image does not ship that VQ migration inventory,
VQ routes are always mounted, global readiness does not require their schema, and one
VQ job store falls back to per-process memory if schema is missing.

Object-write readiness certifies a hand-maintained seven-kind registry, not the full
writer inventory. A reachable community publication path inserts an approved public
row before object upload and audit finalization. This is a strong HIGH candidate that
still needs fault-injection reproduction before canonical acceptance.

### 5. Runtime jobs do not share one lifecycle contract

Core jobs increasingly use lifecycle tracking and advisory locks, but Instagram and
weekly-reel workflows use different timer/lock semantics. Weekly reel holds a checked-out
database lock across provider work and a configurable delay of up to 180 minutes, marks
itself generated before later notification/publication effects, and has no durable
provider-accepted/persistence-unknown reconciliation state. Aggregate configured pools
can reach 34 connections per process before external capacity is known.

The result is inconsistent shutdown, timeout, retry, idempotency, and completion meaning
across jobs.

### 6. The strongest tests are not the enforced release topology

The fail-closed isolated Partner runner exists because its 70 critical suites use
incompatible database topologies and mutate process-global environment. Hosted CI does
not invoke it; it runs a flattened suite with selected execution floors. Main typecheck
excludes tests and operational scripts. Scanner has separate package tests that hosted
CI does not invoke. Some migration tests exercise SQL excluded from the shipped runner.

Therefore the repository can produce green evidence that is not evidence for the
topology it actually ships.

### 7. Retired and one-off systems remain executable or operationally documented

The deprecated scanner-watcher is still installable and a runbook still instructs
operators to use it. Other Scanner instructions say to clone the repository and run
`npm install`, while runtime source says operator Macs must use an owner-approved signed
package and never be mutable checkouts. Incident migration/repair executables are still
built and copied into the production image.

Retirement must follow replacement proof and rollback preservation; it cannot be a bulk
delete.

## Accepted HIGH architecture findings

| ID                      | Finding                                                                                                                           | Current disposition               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `ARCH-AUTHORITY-001`    | Declared route/data/schema authority contradicts executable topology.                                                             | OPEN                              |
| `ARCH-ROUTE-001`        | Reachable reprint UI calls an intentionally removed server endpoint.                                                              | OPEN; print/evidence owner gate   |
| `ARCH-SESSION-001`      | Admin session destruction, 401 semantics, and protected cache invalidation have no single client authority.                       | OPEN; auth owner gate             |
| `ARCH-SUPPLY-001`       | Duplicate Partner order paths split paid checkout from the orders view.                                                           | OPEN; Partner/commerce owner gate |
| `ARCH-PRICING-001`      | Admin pricing shape is incompatible and public/checkout/payment pricing authorities diverge.                                      | OPEN; commerce owner gate         |
| `ARCH-ROLE-001`         | `SCANNER_OPERATOR` exists server-side but is unavailable in active client role management.                                        | OPEN; Partner/RBAC owner gate     |
| `ARCH-LEGACY-AI-001`    | An obsolete AI grading route remains live under the current feature flag and can mutate protected evidence.                       | OPEN; grading/provider owner gate |
| `ARCH-SCHEMA-001`       | Always-mounted VQ runtime, shipped migrations, journal, and readiness do not describe one schema estate.                          | OPEN; migration/VQ owner gate     |
| `ARCH-CI-001`           | Hosted CI omits authoritative isolated Partner, Scanner, and tooling proof topology.                                              | OPEN                              |
| `ARCH-SOCIAL-001`       | External-publication jobs lack durable completion/reconciliation and lifecycle-safe lock boundaries.                              | OPEN; provider owner gate         |
| `ARCH-WAA-SUBGRAPH-001` | The earlier accepted release-integrity HIGHs remain unresolved and must be completed as a mechanically validated nested subgraph. | OPEN; existing exact owner gates  |

Medium systemic work and unaccepted candidates are recorded in `issue-register.md`; they
remain in the graph so they cannot disappear merely because immediate HIGH containment
is complete.

The parent graph also imports existing Scanner `SFAP-002` (BLOCKER) and `SFAP-007`
(HIGH) by their stable IDs. Their severity and external signing/clean-Mac requirements
are not subsumed or reduced by the Medium legacy-operations architecture cluster.

## Clean areas preserved

This assessment does not reopen proven behavior without contrary evidence. In
particular: Stripe raw-webhook ordering, canonical Partner public-auth mounting, the
hardened numbered main migration runner, protected paid-order binding, current staff
proxy whitelist containment, current review-preview precedence, and frozen MVGS scoring
remain governed by their existing proof records.

## Recovery judgment

A whole-repository rewrite would compound the risk. The viable repair is a strangler
program: make contracts executable, contain confirmed HIGH breaks, characterize current
behavior, then move one bounded context at a time behind explicit ports while independent
agents prove behavior, drift, rollback, and integration. The machine-readable dependency
graph for that program is `repair-graph.json`.
