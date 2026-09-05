# Commercial pricing recovery — existing ARCH-PRICING-001

Baseline `c228af1998fb770e12c93758d3737fc92c5a9009`, feature branch
`fix/resource-hardening-staging-20260827`. Owner authorization is already recorded
in `owner-approval-record.md`; root sole writer, Terra read-only caller discovery,
Sol independent proof. Existing task-ledger WIP and unrelated vault-worlds retained.
Preflight CRITICAL/HOSTILE. Graphify located tier/projection/quote callers; actual
schema, storage, routes and components verified by root. No broad audit.

## Locked recovery choice

`service_tiers` remains the authoritative grading commercial configuration. Its
Drizzle camel-case record is the existing Admin wire contract; repair that client,
not the database column names. Public/submission displays use one typed client-safe
projection from the same records and explicit service type. Inactive tiers are not
offered publicly; an unavailable live projection shows unavailable/retry rather
than resurrecting static advertised prices or a selectable static tier.

Existing `computeGradingQuote`, active-tier lookup on quote/charge, promotion
calculation, Stripe PaymentIntent creation and immutable paid receipt/submission
snapshots remain authoritative. Do not change amounts, taxes, tier price values,
discount policy, membership prices or grading behavior. Historical guidance may
retain dated historical facts only when clearly marked non-current; current
commercial claims must use the projection or link to live pricing without numbers.

Partner `partner_service_tiers` and supply prices are separate aggregates and are
excluded. Current tested Partner purchase authority is Owner-only; no accepted
pricing node authorizes expanding Manager grants. Keep this distinct from the
original broader commercial request and from Scanner transport compatibility.

## Sequenced file/proof manifest

P1 contract/admin/public foundation: existing `shared/commerce.ts`, projection
function/export only in `shared/schema.ts` (no schema SQL/frozen grading),
`server/routes/{admin-config,public}.ts`,
`client/src/{lib/pricing-projection.ts,pages/admin-pricing.tsx}` and
`tests/pricing-authority.test.ts`. Begin with actual Admin render on a camel-case
DB-shaped row: current filter must fail before repair. Record exact public
projection response, active/paused behavior and cache policy; preserve existing
API shape for rolling consumers. New projection fields are additive.

P2 existing consumers, topologically after P1: `client/src/pages/{home,home-v2-integrated,
home-v3,home-v4,how-it-works-v2,pricing,pricing-v2,pricing-demo,pre-grade,submit,
vault-club}.tsx`, `client/src/pages/help/faq.tsx`, `client/src/pages/seo/`,
`client/src/data/guides.ts`, `client/src/components/{ui/pricing-animated,certificate-form}.tsx`,
and `server/seo-config.ts`. No wholesale redesign or new folders. Every source in
the graph's price-bearing inventory must be dispositioned; P1 alone cannot close
ARCH-PRICING-001. Preserve existing non-price content and navigation.

P3 behavioral integration: real owned PostgreSQL admin change propagates to public,
submission, promo/no-promo, inactive tier and newly calculated quote/charge while
existing in-flight/paid snapshots are unchanged. Use deterministic provider doubles,
never paid Stripe calls. Exact additional integration fixture files must be named
before writing them. Independent held-out/changed-surface proof and a mutation
restoring static authority must bite. Run relevant type/lint/build/architecture,
clean exact-lock checks and exact-SHA CI; no waiver of restricted security gates.

## Rollback, invalidators and state

Rollback the exact projection+consumer code together to this baseline, with cache
invalidation for the existing public tier/promo keys. Never rewrite `service_tiers`,
submissions, PaymentIntents, receipts or promotions as a rollback. An old UI can
render stale information during rollback, but server quote/charge authority must
continue to reject inactive/unavailable tiers and derive current totals.

No deployment, shared migration, credentials, provider spend, frozen MVGS change,
or destructive consolidation. Record product/test/fixture/environment failures
separately and repair reproduced in-scope HIGH before closing this wave. Recovery
and owner nodes will be recorded from this packet before any pricing code changes.
Current state: P1 in progress. Actual Admin React test is red on baseline: the
camel-case grading row renders "No tiers found" instead of £37.29/17 days.
Recovery dependency is OWNER-PRICING (approval is not completion of the finding);
the repair retains the ARCH-PRICING-001 prerequisite. Parent/nested graphs validate.

P1 manifest addition, source-verified before edits: `server/storage.ts`, ONLY
`updateServiceTier`, and `tests/pricing-postgres.test.ts`. Existing raw SQL RETURNING
is cast to a camel record without mapping, and turnaround-day changes retain the
previous authoritative display label. Prove against helper-owned PostgreSQL, then
use typed Drizzle returning and reset the derived label only when days actually
change. Preserve custom labels on unrelated edits. No DDL or stored prices changed
outside the synthetic test fixture. Existing owner pricing authorization applies.

Exact baseline CI33987565951 is terminal FAILURE: Test job101363842226 and image
vulnerability gate101363842335; Gitleaks/CodeQL/dependency review SUCCESS. Restricted
security causes remain UNKNOWN and no dependent release gate is waived. User renewed
continuous authorization; stale backend goal metadata is not a reason to idle.

P1 gate manifest addition before enrollment: `scripts/architecture/{authority-policy,
legacy-authority,generated/architecture-authority}.json` and
`scripts/ci/typecheck-baselines/{architecture,tests}.json`. Independent Terra confirms
exact commerce ownership for the client hook/Admin page/shared commerce leaf;
storage/schema broader authority remains ARCH-AUTHORITY-001 OPEN. Transfer only
the same storage method's raw-SQL→Drizzle keys and schema formatter adapter key;
remove obsolete Admin-page keys. No --adopt-unowned, gate relaxation, diagnostic
baseline increase or wholesale storage/schema owner assignment. Shared inventory
writes follow Partner; remaining legacy-AI inventory writes follow pricing.

P1 behavioral evidence: original Admin render1 and owned PostgreSQL/HTTP3 executed
red before repair; root and independent Sol now8/8, zero skips. Sol held-out
contradictory price string/pence and malformed capacity fields initially reproduced;
root added shared exact price formatting plus strict nullable-string validation,
negative tests now bite and independent rerun rejects both. Custom label preserved
on price-only/unchanged-day edit; changed days clear stale label atomically. No
other storage method changed. P2/P3 and final candidate proof remain OPEN.

The existing task heartbeat is re-enabled at five minutes as an idle-resume
safeguard, with failed-runs-only notification policy preserved. Active work does
not wait for scheduled ticks. No duplicate task/automation, deployment or provider
authority was introduced. Local scheduling needs the computer/app running.

P1 checkpoint gate receipt: clean exact-lock Vitest4.1.7 copy
`/private/tmp/mintvault-h1ef-clean.x3NRtE`, five files58/58, zero skips, including
Admin-session, public-bundle and real grading-payment replay regressions. Root
TypeScript and local client/server build PASS. Scoped ESLint0errors/95warnings
across the broad touched files; no warning suppression. Tests345 and architecture3
diagnostic baselines unchanged; inventory only504/819. Independent Terra normal
architecture check8520 PASS, parent101/nested34 structurally valid, NOT READY.
Postflight remains red for existing managed CLAUDE drift/npm-egress/dirty-worktree/
protected-review governance; not waived and not called completion.

Independent Sol source hashes at P1 proof, verified again by root before checkpoint:
```text
ddf3c2535b7816f03250572809bc90649c3f14e8588632eb127ea6f9c95a9774 shared/commerce.ts
a59af84fb6916d31c6b1df7bc6f6216177d820d12f1d2621d8b4151f25058c1d shared/schema.ts
1c7db92bc485bd6ecfbf349c6eedcb3561af7966bf98ba2a7c4432232eefbf29 client/src/lib/pricing-projection.ts
150a2f36b20f26ad8123da8a6f3bff93d9f06545e443f13d7818756d7aca19ae client/src/pages/admin-pricing.tsx
5e4706bc12e9617b947ff3f89fc69cfc932c98604ba778b8319bc28249915106 server/routes/public.ts
fad5a1ebb67dae1f4d60aa4294ba15f378a17d0c54823b3516ac039e74b207f2 server/storage.ts
2b993a81bc7dcdf0b9b119f116ba7617bcecaaebcbe62c6d912486a57fcc35d0 tests/pricing-authority.test.ts
6ae264fb16c5571fc6b053026a23669f7fdafad2bad04887a0983a179c763379 tests/pricing-postgres.test.ts
```
