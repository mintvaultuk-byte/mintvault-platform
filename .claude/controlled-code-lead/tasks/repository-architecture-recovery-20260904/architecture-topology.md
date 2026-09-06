# Architecture topology and authority map — recovery baseline

## Current executable topology

| Surface           | Present composition                                                                                                                                | Failure mode to remove                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| HTTP/runtime      | `server/index.ts` composes middleware, sessions, routes, readiness, jobs, listen, and shutdown.                                                    | HTTP and worker lifecycles cannot be reasoned about independently.                         |
| Routes            | `server/routes.ts` plus approximately 42 registrar/portal calls and late mounts.                                                                   | Manual order, collisions, root↔leaf imports, inline domain logic, and dead handler bodies. |
| Persistence       | Main `db`/`pool`, `IStorage`, Partner runtime/admin/audit/connector pools, Vault Quest storage, route-local queries.                               | No executable table/command owner map; transaction authority is convention.                |
| Schema/migrations | Numbered main chain, excluded unnumbered SQL, VQ raw-SQL chain, schema registry, CI fixtures.                                                      | Build, deploy, readiness, and runtime do not name one estate.                              |
| Objects/providers | Direct R2 and provider imports across routes, services, and jobs; partial durable coordinators.                                                    | Writer inventory and lifecycle class are not complete readiness inputs.                    |
| Client routing    | One `App.tsx` root with 173 `<Route>` elements, 169 literal-path declarations, and 144 `lazy(...)` calls (140 ordinary plus four DEV-conditional). | Variants and dead deep links are production-reachable without an ownership registry.       |
| Client data/auth  | QueryClient defaults, `apiRequest`, raw `fetch`, repeated session queries and page-local logout.                                                   | 401, cache lifetime, logout, and principal transition semantics diverge.                   |
| Jobs              | Root-started timers plus bespoke locks, tracking, leases, retries, and provider flows.                                                             | “Complete,” drain, idempotency, and crash recovery mean different things per job.          |
| Tests/CI          | Large Vitest tree, isolated Partner runner, Scanner Node suites, source-text tests, CI subsets.                                                    | Local/hosted green does not necessarily exercise the production topology.                  |

## Target authority rules

1. Route adapters declare method, path, order, actor/capability, request/response schema,
   command owner, provider effects, and retirement state in an executable manifest.
2. Each bounded context owns its tables, commands, repositories, events, and object
   lifecycles. Partner retains its required distinct credentials/role boundaries on the
   same physical database. Vault Quest currently uses the main database authority and
   requires an explicit owner decision before any new identity/RLS boundary; neither
   context is forced through the main `IStorage` monolith.
3. Client surfaces use one route registry, one principal/session authority per actor
   family, and one generated or checked API contract. A principal change clears all
   protected cached data.
4. Pricing has one commercial authority from administration through advertisement,
   selection, quote, charge, receipt, and audit. Static presentation metadata may not
   carry chargeable values.
5. Jobs register schedule, lease/claim, concurrency, timeout, lifecycle tracking,
   shutdown behavior, completion state, provider idempotency, and reconciliation.
6. Schema readiness is component-aware and bound to the exact shipped migration
   inventories. Missing required schema fails closed; optional components are visibly
   disabled rather than silently in-memory.
7. Authoritative objects use durable coordination; derived objects are reproducible;
   ephemeral objects have TTL/cleanup. Readiness derives from the writer inventory.
8. CI invokes the same authoritative runners and runtime identities that release claims
   cite. Skips, missing services, and source-text-only assertions cannot count as proof.

## Strangler boundaries

Extraction order follows consequence and coupling, not file size:

1. Identity/session and commercial contracts.
2. Print and grading route adapters, including legacy tombstones.
3. Partner supplies and roles.
4. Route manifest, shared commands, and removal of root↔leaf cycles.
5. Schema/VQ release authority and object writer registry.
6. Job registry and external-publication state machines.
7. Client route/data decomposition and retirement of production variants.
8. Scanner and one-off operational retirement after replacement acceptance.

Every boundary is characterized before movement, changed by the Lead in a sequential
shared-workspace wave, independently verified, checked for drift, and connected to the
rollback and integration loops.
