# Partner contract recovery — bounded implementation packet

Baseline: `0494d5fbed5cb30f8379bb507d28c9b2a0a09c0b`, branch
`fix/resource-hardening-staging-20260827`. Root is sole shared writer. Existing
task-ledger WIP is retained; unrelated `docs/planning/vault-worlds/` is excluded.
Authority: `owner-approval-record.md`; no new per-item decision is required.

## Disposition and boundaries

- Retain both historical aggregates byte-for-byte. No SQL migration, conversion,
  deletion, or rewrite of either `partner_supplies_*` requests or
  `partner_supply_*` commerce records is needed.
- Paid history remains GET `/api/partner/supplies/orders` and `/partner/orders`,
  under `partner.orders.view`. Legacy history becomes GET
  `/api/partner/supplies/requests` and `/partner/supplies/requests`, under
  `partner.supplies.view`. Separate guarded routes do not grant Finance access
  to legacy requests.
- Canonical legacy creation becomes POST `/api/partner/supplies/requests`.
  Retain POST `/api/partner/supplies/orders` as an explicit compatibility alias
  to the SAME legacy handler, with identical permissions, idempotency, outbox,
  freeze and rate limits. It must never mean payment or create a paid order.
  Existing GET clients cannot retain the ambiguous response: update the shipped
  client atomically with the route split; both APIs remain independently named.
- Paid checkout, server-derived prices/tax/tenant identity, webhook/replay,
  refunds and all server grants stay unchanged. Client purchase affordances
  reflect the existing conjunction of `partner.orders.submit` and
  `partner.credits.purchase`; server remains authoritative.
- Extract the existing five-role server transport map to a shared contract.
  Client types, invitation/edit choices and guard consume it. Preserve server
  hierarchy, final-owner protection, step-up, revocation and audit behavior.
  Finance/Trainee remain unsupported edit labels; no role gains a capability.
- Remove the paid catalogue's redundant inner PartnerShell. Its existing route
  guard remains the shell authority. No redesign, new dependency or folder tree.

## File manifest and proof sequence

Root implementation: `shared/partner-team-roles.ts`,
`server/partner/{team-service,supplies-routes}.ts`,
`client/src/lib/partner-api.ts`, `client/src/pages/partner/{users,supplies,supplies-orders}.tsx`,
`client/src/{App.tsx,components/partner/partner-shell.tsx}`.
Keep paid and legacy page exports in the existing orders module.

Proof: `tests/partner-contracts.test.ts` for real mounted HTTP against an owned
native PostgreSQL 17 cluster, existing realistic migration/browser fixture,
normal login, restricted runtime, Owner/Manager/Finance and cross-tenant reads;
source/DOM tests for shared roles, guards and one shell. Preserve and run existing
paid checkout/webhook/replay/refund, legacy outbox and Scanner least-privilege
suites. Any additional exact fixture/CI inventory/type/architecture snapshot
changes must be recorded here before integration, without loosening gates.

Required red-to-green: mounted paid GET currently returns the legacy aggregate;
new legacy GET currently 404; Finance currently receives the wrong capability
denial; Scanner Operator absent from the client's edit contract. Verify stored
items, money, tax, delivery and history digests before/after read-only proofs.
No mock principal is adequate for the HTTP claim. Provider boundary doubles in
the existing commercial suite are not real Stripe provider proof.

Additional exact proof surface: `tests/partner-contracts-ui.test.ts` renders the
actual paid/legacy/role client components with deterministic query responses;
this is UI behavior proof, not real browser/session proof. Architecture owner
policy/generated snapshot and existing test-ratchet inventory may be updated
only to name these exact files and reviewed route/role edges; no debt increase.
Retire only four obsolete legacy-authority keys for the moved client role union in
`scripts/architecture/legacy-authority.json`; the shared map receives explicit
Partner ownership, not a new legacy exception. Keep both POST paths literal and
their guard sequences explicit for the existing AST gate, with one common handler.
The component manifest deliberately admits runtime roots only, not `shared/`.
Keep that manifest unchanged and assign this exact shared file via the existing
`ownerRules` mechanism instead; do not broaden the manifest validator. Update the stale positive buy
control assertion in `tests/partner-supply-access.test.ts` to require the stronger
conjunction; preserve its unpriced-product refusal. No runtime requirements change.
The new delivery view must render both historical approved-location raw-address
snapshots and structured partner overrides. Independent review caught overlapping
Supplies/Requests nav activation: suppress only the parent link on request pages.

Actual browser extension (same owned H1i runner, no new service): exact write
scope adds `scripts/ci/partner-browser-fixture.ts`,
`scripts/ci/run-disposable-integration.mjs`,
`scripts/command-centre-runtime-harness.ts`,
`scripts/command-centre-mobile-layout-check.mjs`, and
`tests/{disposable-integration-runner,command-centre-runtime-harness}.test.ts`.
Optional supply-contract bootstrap applies unchanged 0112 only to its owned empty
database and seeds one synthetic paid snapshot and one legacy snapshot. It does
not call Stripe or claim to prove webhook ingestion. Preserve the existing three
identities and eighteen browser checks; add four mandatory ordered checks for
paid UI, legacy UI, Scanner Operator choice and Finance readonly behavior.

Independent Sol observes the changed risk surface; Terra verifies compatibility
and predecessor wiring separately. Author checks alone cannot close proof nodes.
Exact-lock, scoped lint/type/architecture and non-force wave checkpoint follow.
All exact-candidate, restricted security and final hostile vetoes remain open.

## Rollback and stop conditions

Atomic code rollback to the baseline restores the old router/client/type contract
without touching either database lineage. This restores the known shadowed paid
view as a limitation, not loss of history. No downgrade migration is appropriate.
During local proof compare both histories before/after; demonstrate old/new
route behavior in a disposable test fixture, never by modifying shared data.

No deploy, shared database, provider call, production/live credential, protected
MVGS change, broad audit or destructive worktree cleanup. Reproduced in-scope
BLOCKER/HIGH goes through repair and independent recheck in this same cycle.
Physical scanner/printer/NFC and unavailable hardware remain external gates.

State: recovery approved under the existing owner record. Terra independently
verified the predecessor wiring and 64/64 topology/lifecycle controls at the
baseline: `REPAIR-CI-TOPOLOGY` is locally FIXED, not PROOF-CI/release PROVEN.
The recovery gate depends on the two owner decisions, like RECOVERY-ADMIN-PRINT;
the repair itself retains both OPEN findings as prerequisites. Depending on
closed findings before approving their recovery would be circular gate semantics.
No finding/proof/release edge or veto is removed.
The exact shared architecture/type inventory write scopes now overlap the
partially implemented legacy-AI wave. Its remaining writes are explicitly ordered
after this Partner checkpoint. Root remains sole writer; no legacy-AI source is
changed here and no historical proof is re-certified by the dependency edge.

Terra found no in-repository caller of the old typed legacy creation wrapper and
recommended removing its POST path. Root chooses the safer rolling-client
compatibility alias: one shared handler, unchanged mutation semantics, tested
with a single idempotency key across both routes. External callers remain unknown;
no deprecation deadline or removal is invented without evidence.

## Local implementation and independent evidence — 2026-09-05

Baseline0494 plus this exact packet; no deployment, shared migration or real provider
payment. Both applied SQL files, payment service/webhook, server permission grants,
and dependency manifests/locks remain unchanged. Runtime roots remain unchanged.

Real HTTP red baseline: six executed failures reproduced wrong legacy rows for
Owner/Manager, Finance403 and missing requests404; fixture/auth successfully booted.
Final mounted HTTP7/7 proves both tenant-specific nonempty histories, paid snapshot
fields, Finance separate read authority, historical data equality across profile
change/repeated reads, canonical legacy create plus old POST replay, one request,
one ORDER_RECEIVED event/notification and unchanged paid payment rows.
No bypass/mock principal; only outbound email boundary is a deterministic double.

Root real PG regression: four files40/40 (HTTP7, unchanged paid/legacy/Scanner
behavior). Root integrated CI/React/HTTP controls: seven files145/145. Clean
exact-lock Vitest4.1.7 copy: ten files178/178. Zero failed/skipped in these accepted
runs. UI9/9 renders actual components and covers both delivery snapshot formats,
VAT included/unconfigured, refunds, shared Scanner role guard, separate histories,
and capability conjunction/unpriced refusal. This is not a mock-page browser claim.

Real Chrome152.0.7977.76, existing owned runner, required ordered22/0/0, exit0:

- Root `fd2e297c-1b15-4bd3-8dff-f4d73d504fc7`, URL127.0.0.1:62174,
  app74569/browser74577; actual shutdown and exact-label containers0. Subsequent
  literal-POST spelling change is covered by final HTTP and independent browser.
- Independent Sol `87dc2310-8cd9-4b01-8bbb-7f006a11a432`, app76219/browser76245;
  both PIDs absent and exact-label containers0.
- Clean exact-lock `f66e519d-0a58-44a9-b284-b2a2a577671d`, URL127.0.0.1:62850,
  app76857, orderly shutdown, accepted report22/0/0.

Browser uses real login/cookie/logout for Owner/Manager/Finance, exact paid and
legacy snapshot cards, enabled Scanner Operator invitation choice (not submitted),
one Finance shell/nonempty disabled catalogue, legacy403 and checkout403 before
payment handling. The fixture adds no identity or route to production. Its partial
application schema still causes unrelated worker missing-relation logs; this is
explicitly not a whole-application readiness or physical-hardware proof.

Independent Sol final focused35/35, helper-owned runtime47/47, final-owner DB2/2;
initial sandbox EPERM and obsolete source assertion were not accepted as proof.
Root strengthened the two-tenant fixture and fixed overlapping nav activation from
independent feedback. Stale buy assertion now requires the stronger permission
conjunction. A temporary auto-review refusal about the DB variable name was resolved
by read-only verification of env-i and generated owned URL assignment before retry;
no live URL or credential was inspected, inherited or used.

Build/main TypeScript/scoped lint pass (0 lint errors/warnings). Test ratchet345,
script ratchet11, architecture ratchet3 unchanged; only exact file inventories
500→502 tests and817→818 application entries changed. Syntax67 and mandatory CI
topology pass. Architecture8498→8511 records: new explicit route/permission/shared
role/fixture edges, four obsolete role-union legacy keys removed, no new exception.
Graph101+34 valid, NOT READY. Engineering postflight remains red on existing managed
CLAUDE drift/npm-egress/dirty tree/branch-wide protected review; no override used.

Proof-time SHA-256:

| File | Digest |
| --- | --- |
| server/partner/supplies-routes.ts | 11f897f34a4d3962b807bef7bd2d6dc08a3e6de89ff085417da1f489fc5297c7 |
| server/partner/team-service.ts | 3f48804afd6346dc42a44fbfab935a17258040fd3655e449cb23f2ff21b28abe |
| shared/partner-team-roles.ts | d4afe5f0f7267e6829df0321f02826fdfd65295fd1329dc5c4915dfb7ad879f5 |
| tests/partner-contracts.test.ts | 7e58bb8ec846361199ddfd04901210c338fedbc3d5975c22f2ce4b6386fba4b8 |
| tests/partner-contracts-ui.test.ts | bd4cb844abd2ea4126766fefdfa946e2c5fee666cd72c2426193b961d6f45d85 |
| scripts/ci/partner-browser-fixture.ts | 986da929d91345705ec3362f988015f5c04d629264e47691fb65b831dd145cda |
| scripts/ci/run-disposable-integration.mjs | 000c39387afc5b1771160aac51c02e839913a167647ae37f86dfc8300d8ac504 |
| scripts/command-centre-mobile-layout-check.mjs | 2b00de764f6736e035c9af105819d82c122cc6189ce454d31f6e1bb0c2602153 |

ARCH-SUPPLY-001 and ARCH-ROLE-001 are FIXED_WIP / exact-candidate proof pending.
Do not mark the global release, PROOF-CI or restricted HY-SECURITY lines green.
Latest pushed0494 primaryCI33980226901 is terminal FAILURE at Test and production
image vulnerability gate. Dependency review, Gitleaks and CodeQL pass. Restricted
causes remain UNKNOWN, not re-investigated in this wave.

Follow-up retained for the schema-authority wave: existing rollback0112 script
still names0069, compares>69 and deletes0069 journal row. Sol source-verifies it
fails closed before mutation on a journaled0112 estate. It is not used by this
route-only rollback and is not a software blocker for this packet; no SQL edited.
