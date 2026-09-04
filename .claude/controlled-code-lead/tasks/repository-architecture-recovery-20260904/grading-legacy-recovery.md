# Legacy AI grading recovery packet

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
