# Architecture authority and topology drift gate

MintVault contains partially separated bounded contexts alongside a large legacy root.
The architecture gate makes that condition executable. It is a containment and drift
control, not a claim that the legacy root has already been decomposed.

## Authorities

- `config/components/index.ts` is the canonical component-readiness index. Each
  component manifest declares its runtime state, readiness order, required relations,
  required migrations, and owned source roots.
- `server/lib/component-readiness-registry.ts` validates that same index and derives the
  runtime readiness registry without filesystem, database, provider, or environment
  access. A disabled component cannot remain runtime-ready.
- `scripts/architecture/authority-policy.json` owns bounded-context source rules,
  forbidden runtime dependency directions, explicit layer exceptions, migration
  classifications, and the paths of the canonical component index and exact legacy
  ledger.
- `scripts/architecture/legacy-authority.json` contains exact stable keys for accepted
  legacy topology. It has no directory-wide catch-all. `known-legacy` means contained,
  not approved.
- `scripts/architecture/generated/architecture-authority.json` is the generated,
  reviewed topology snapshot.

## Current census

The current snapshot contains 8,608 records:

| Record            | Count | Evidence captured                                                                                                                                    |
| ----------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client route      |   172 | path, rendered leaf/import target, wrapper/guard dominance chain, permission and environment guards                                                   |
| Component         |     7 | canonical manifest, runtime state, source roots, relations and migrations                                                                            |
| Job               |    37 | recurring scheduler/worker registration, cadence, lock and lifecycle evidence where statically declared                                              |
| Layer exception   |     4 | exact source/target exception and finding disposition                                                                                                |
| Migration         |   169 | lineage, number, classification and SHA-256 checksum                                                                                                 |
| Migration lineage |     6 | lineage-exclusion document checksum plus each exact collision/convergence declaration                                                                |
| Object writer     |    90 | individual object-store write/lifecycle/retention call and owner                                                                                     |
| Pricing authority | 1,779 | price/tier/discount/fee values, currency-bearing literals, imports, and static or JSX transport projections                                          |
| Provider adapter  |   166 | individual fetch/SDK operation, origin/method/callsite authority, lifecycle options and owner                                                        |
| Role authority    |   725 | capability consumers and role/actor definitions, defaults, mappings, and comparisons                                                                 |
| Route middleware  |    61 | application/router middleware prefix, order, actor and capability contribution                                                                       |
| Route mount       |    69 | Express `.use` and ordinary registrar-call composition edges in registration order                                                                   |
| Schema object     |     3 | non-table schema declarations covered by policy                                                                                                      |
| Server route      |   987 | method, declared/effective path, root-reachable mount chain and order, route-local middleware order, actor/capability evidence and delegated effects |
| Session/principal |   583 | cache-key principal binding, session fields, and auth/session provider definitions and consumers                                                     |
| Table             |   360 | Drizzle, unmanaged-schema and migration-DDL table identities                                                                                         |
| Table access      | 3,301 | individual Drizzle, constant/helper/tagged raw-SQL, or explicitly unclassified SQL access and owner                                                  |
| Timer             |    89 | one-shot timeout/watchdog/retry/debounce call, delay and tracked/untracked lifecycle                                                                 |

The scanner evaluates constants, template expressions, bounded `for...of` registrations,
pure local route helpers, imported registrars, ordinary registrar calls, and Express
receiver provenance. It composes only from an actual `express()` root; router-local or
registrar-local calls are not promoted to synthetic roots. Routes that cannot be reached
from that composition graph are rejected rather than silently counted as endpoints.

Client route records traverse nested JSX to bind each rendered leaf to its exact import
target and ordered ancestor guard chain, including guards introduced through local
component aliases. Non-public Partner leaves fail unless `PartnerRouteGuard` dominates
that leaf and resolves to the canonical guard module; a sibling guard or same-named
foreign import cannot satisfy the rule. Routes importing a disabled component also fail
even when their declaration lives in the shared root.

Admin query records are also bound to the executable cache authority in
`client/src/lib/queryClient.ts`. The gate verifies the exact public-key exception set,
the protected-by-default classifier, the principal-scoped hash branch, and both required
principal fields (`email` and `isSuperAdmin`). Public records are annotated as shared;
protected records are annotated as principal-partitioned when an Admin principal is
active. Dead references, inverted public returns, missing role binding, or public-set
drift fail hostile mutations.

Raw SQL discovery resolves lexical constants and principal-cache aliases, follows
statically identified query-helper parameters at call sites, and excludes CTE aliases
and object property names from authority. Unresolved SQL sinks remain explicit
`sql-unclassified` records. Dynamic imports and same-named bindings are resolved in
their lexical scope rather than file-wide. Provider and object-store operations are
inventoried individually; HTTP records retain the resolved origin plus callsite method,
abort signal and idempotency authority. Calls to imported/local named helpers are
followed transitively to provider/object sinks and recorded as delegated commands;
unresolved delegation remains visibly unclassified.

Migration authority includes the main and Vault Quest lineages. Duplicate identities,
including leading-zero aliases, checksum drift, malformed lineage-exclusion declarations,
missing required migrations, and an unclassified migration reference fail the gate.
Numbered Vault Quest migrations are classified `shipped-numbered-vault-quest`
only when the exact numbered COPY appears in the production Docker stage. A
removed/commented/wrong-stage copy leaves them unshipped. Requirements use closed
main/VQ estate identities; a main filename cannot satisfy VQ. Image CI separately
proves the actual bundled runner, image-owned SQL/checksum inventory and replay.
Neither source classification nor shipping closes runtime-readiness or release gates.

## Commands and review flow

`npm run architecture:check` fails on:

- an unowned topology record;
- a configured application root that disappears, or a route under an unapproved/dead
  `express()` factory;
- an added, removed, or structurally changed record relative to the snapshot;
- a forbidden runtime import without an exact exception;
- an exception that is unused, duplicated, or not bound to an open issue;
- a malformed, duplicate, split, or non-canonical component manifest;
- component-index/runtime-registry/source-root authority disagreement;
- runtime topology under a disabled component;
- an unreachable server route or an unguarded/unclassified protected Partner route;
- a missing required relation or shipped migration;
- migration identity or checksum drift.

Source line movement alone does not create architectural drift. Runtime imports and
exports are checked; named type-only imports/exports do not create false layer edges.

`npm run architecture:update` refreshes the generated snapshot only. It does not adopt
new unowned topology. Adding an exact legacy key requires an explicit manual
`--adopt-unowned --write` review, after which the resulting ledger diff must be reviewed
like source code. Every legacy entry must still resolve to a current `known-legacy`
record; removed or newly explicitly owned keys fail as obsolete, so they cannot be
reused as a silent fallback. The current reconciled ledger contains 3,673 exact keys.

The scanner is static. It never imports application modules, starts workers, connects to
a database, or calls providers.

## Deliberate limits

This Phase 2 foundation records what source proves. Actor/capability, schema, commercial,
principal, SQL, provider, and lifecycle fields can remain visibly unclassified where
static evidence is insufficient. The gate does not prove authentication correctness,
request/response behavior, idempotency, provider acceptance, transaction semantics, or
durability merely from names. Exact snapshot drift makes those declarations reviewable;
behavioral proof remains a separate graph loop.

Large legacy ownership, the Vault Quest shipment decision, protected product repairs,
and destructive retirement remain later graph nodes with their own owner and recovery
gates.
