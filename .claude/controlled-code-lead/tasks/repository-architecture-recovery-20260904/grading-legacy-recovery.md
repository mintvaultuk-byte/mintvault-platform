# Legacy AI grading recovery packet

## 2026-09-05 carry-forward checkpoint

Current baseline `aa4ec14a273da779f550fd4bb777ca1616d5e518`, pushed to draft PR336.
The retirement was already implemented in80a20611; no product reimplementation or
new audit is required. Independent Terra reran the unchanged five-case tombstone
suite under scrubbed Node20:5/5 PASS. This proves exact source composition and
typed responses plus a synthetic Express pre-parser request harness; the harness
uses an admitting auth stub and is NOT proof of real Admin login/global middleware
in the whole application. Existing normal Admin login proof remains separately
recorded in pricing/Partner/Admin packets. Final candidate composition stays OPEN.

Root reviewed exact source and hash continuity. Current TypeScript/scoped pricing
lint/build and106pricing regressions are recorded in pricing-recovery.md; they are
not relabelled full legacy integration proof. Clean legacy+architecture rerun is
recorded below. Initial clean architecture red was a stale copied policy/inventory
fixture, not product failure: synchronize the three committed inventory files,
without adoption or waiver, and rerun. All release/security/hostile vetoes retained.
After inventory sync the same test exposed three genuinely stale expectations:
retired guide£19 and two snake_case Admin fields. Add exact test-only scope
`tests/architecture-authority.test.ts`: assert the retained illustrative£120 AST
currency record and the actual camelCase price/max-value expressions. The normal
authority gate and hostile extraction mutations are unchanged; never restore stale
product prices to satisfy the test. This wave writes existing recovery/graph/task/
issue/proof records plus those three test expectations. Rollback is proof-only;
never restore retired implementations. No new folder/framework/baseline waiver.

Final clean and independent Sol32/32 (architecture27/tombstone5), zero skips.
Independent three-line expectation review CLEAN; no gate/extractor/mutation change.
Architecture test SHA256:
`ba4d853f2c239c3ba9e45a38d4080f4796bb1bd9fac634dd5c7824ebe2f5a726`.
Original sandboxed independent listener attempt is environment failure, not proof;
approved local-loopback rerun is authoritative. Final candidate/hostile gates stay
OPEN. Parent101/nested34 validation and ordinary postflight recorded at checkpoint.
Checkpoint: scoped lint0errors/0warnings; graph valid NOT READY. Ordinary postflight
retains managed-CLAUDE/npm-egress/dirty/protected-review failures and graph warning.
No acceptance override. Recovery approval is PROVEN under standing owner authority;
repair/proof remain IN_PROGRESS until immutable-candidate requirements are met.

Source SHA-256:
```text
7b65089bc0d557c8418feb0472167443b4b63d70d55c97f8d2b7e6145bbe2ad7 server/routes.ts
f0b6d4ae620a3a70e46e572f339db84f6a968197687cfa8d374321bd8d2551fb server/lib/retired-ai-grading.ts
59c333cb8575354d90ec5fcf7c76e2872474d8bd56fc6d2a70bc2e53d827d32a tests/legacy-ai-route-tombstone.test.ts
5e4532faf873df5fb7e1ab6191b9ce4979e6cee957ee80856217bf10e964deaa client/src/components/certificate-form.tsx
```

**Wave:** `REPAIR-LEGACY-AI`
**Pre-wave checkpoint:** `c3534c856be747e7e66459559d875e3ff3d6f109`
**Pre-wave tree:** clean
**Owner authority:** `owner-approval-record.md` authorises every listed owner gate, directs the Lead to choose the safest behavior-preserving option, and says not to pause between waves. Production/staging deployment, migration application, protected MVGS work, secrets, paid providers, object deletion, and release remain excluded.

## Reproduced contract damage

1. `POST /api/admin/certificates/:id/analyze-v1-legacy` is not a harmless placeholder. When `AI_FULL_GRADE_ENABLED` is true it reads certificate/object state, calls a provider directly, and writes grading fields without the canonical command, revision, or evidence lifecycle.
2. `POST /api/admin/certificates/grade-with-ai` admits a large multipart body, crops and publishes timestamp-keyed objects, invokes identification and grading providers, signs URLs, and may update a certificate directly. It has no route-level feature gate, durable command identity, object journal/cleanup contract, grading lock/revision binding, or canonical prediction evidence.
3. No repository client or test calls either exact URL. The mounted grading UI uses `POST /api/admin/certificates/:id/grade`, which remains supported and unchanged.

These are two independently reachable bypasses around the supported grading authority. A partial retirement would leave the same architectural defect reachable through the other identity.

## Owner-authorised disposition

Retire both exact legacy route identities as authenticated, unconditional, typed HTTP 410 tombstones:

- `POST /api/admin/certificates/:id/analyze-v1-legacy` returns `{ "error": "Legacy AI analysis route is retired", "code": "LEGACY_AI_ANALYZE_RETIRED" }`.
- `POST /api/admin/certificates/grade-with-ai` returns `{ "error": "Legacy AI grading upload route is retired", "code": "LEGACY_AI_GRADE_UPLOAD_RETIRED" }`.

Each tombstone is mounted after `requireAdmin` and before every legacy route-local feature-flag check, AI limiter, body or multipart parser, grading-domain database/object read or write, provider call, grading service, prediction/evidence mutation, and audit side effect. The platform's bounded global middleware and authentication/session authority remain unchanged; authentication may perform its normal principal lookup before returning or admitting the tombstone. The tombstone does not redirect, translate, or enqueue the legacy payload and does not reveal retirement state to an unauthenticated caller.

The supported `POST /api/admin/certificates/:id/grade` route and its mounted client remain unchanged. This wave does not change `AI_FULL_GRADE_ENABLED`, `/identify`, `/:id/identify-and-analyze`, `/:id/grade`, or `/identify-image`.

## Compatibility and recovery boundary

- Repository callers have no compatibility dependency on either retired identity. Unknown external/manual callers receive a stable typed 410 rather than an apparently successful partial workflow or a revived bypass.
- No schema, migration, dependency, environment variable, object, prediction, certificate, audit record, payment, entitlement, MVGS rule, or production datum is changed.
- No provider or storage call is needed to prove retirement.
- The old implementations are not a safe application rollback because restoring either reopens the HIGH defect. Failed-cut recovery is to keep or reapply both tombstones. If the tombstone helper cannot be mounted, disable both route identities at the router boundary until the same unconditional contract is restored.
- Any future support requires a new owner-approved canonical enrollment with command identity, bounded upload admission, object-write coordination and cleanup, grading lock/revision binding, durable evidence, provider controls, audit semantics, and independent proof. It must not be introduced by removing these tombstones alone.

## Proof requirements

- Exact handler proof for both typed 410 response bodies and statuses.
- Mounted-source proof that each route has only `requireAdmin` plus its terminal tombstone and contains no route-local feature, AI rate, upload/body parsing, grading-domain DB, R2/object, provider, grading, prediction, evidence, or audit effect.
- Adversarial request proof that malformed or oversized multipart input reaches neither a parser nor an effect before returning 410.
- Reachability proof that the supported `/:id/grade` route and mounted client remain present while no repository client references either retired literal.
- Architecture snapshot and hostile mutation proof: status drift, a conditional tombstone, a pre-tombstone effect, or either missing tombstone must fail.
- Full repository type, test, architecture, graph, build, lint, and integration gates appropriate to the pre-existing baselines.

Invalidators: owner disposition change; either exact route identity, middleware ordering, response code/body, supported grading route/client, feature flag, provider, object lifecycle, grading command/evidence contract, recovery procedure, or candidate-base change.
