# Grading draft optimistic concurrency

## Contract

`certificates.grading_version` is the authoritative integer token for mutable
grading evidence. It starts at `1`. A client reads `gradingVersion`, sends it
as `expectedVersion`, and every participating mutation uses one conditional
write:

```sql
UPDATE certificates
SET ..., grading_version = grading_version + 1
WHERE id = $1 AND grading_version = $2
RETURNING grading_version;
```

No affected writer performs a read-then-unconditional-update. A stale request
returns HTTP 409 with `code: "GRADING_VERSION_CONFLICT"`, the supplied and
current versions, and `reload: true`. The rejected payload is not persisted.

`updated_at` is deliberately not a concurrency token: it can have insufficient
precision and changes for unrelated activity.

## Participating writers

| Surface                             | Mutation class               | Behaviour                                                                                  |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| Admin grading panel draft save      | Draft evidence               | CAS + increments token                                                                     |
| Restricted grader draft save        | Draft evidence               | CAS + increments token                                                                     |
| Admin review draft save             | Draft evidence               | CAS + increments token                                                                     |
| Card-tool manual centering          | Draft evidence               | CAS + increments token                                                                     |
| Generated grade description         | Draft evidence               | CAS after AI generation + increments token                                                 |
| Full AI grade (`POST .../grade`)    | Draft evidence               | CAS after AI generation + increments token                                                 |
| Admin approve, legacy approve-grade | Authoritative transition     | CAS + increments token                                                                     |
| Grader submit/edit-submission       | Authoritative transition     | CAS + increments token                                                                     |
| Reviewer approve/reject             | Authoritative transition     | CAS + increments token                                                                     |
| Super Admin correction              | Authoritative correction     | Transactional CAS + increments token                                                       |
| Scan-ingest centering bootstrap     | Background additive evidence | Never overwrites non-null human evidence; when it fills an empty field it increments token |

AI suggestion-only operations (`measure-centering`, `detect-defects`,
`grade-card`, `analyze`, `identify-and-analyze`, and `grade-with-ai`) update
only AI analysis/suggestion or identity metadata. They do not overwrite the
human grading-evidence columns listed above and therefore do not participate in
`grading_version`. Image crop/recrop writes are likewise outside this evidence
token; the grading panel subsequently saves any human defect/evidence change
through the versioned draft route.

The generic admin certificate metadata PUT is also intentionally outside this
table: it no longer writes grade, grade type, label, or subgrades. It preserves
those fields and cannot bypass the versioned grading routes.

## Client behaviour

The shared grading panel owns one in-memory token and serializes draft saves
through a promise chain. A successful response can only advance its token;
delayed responses cannot lower it. A 409 cancels the debounce, stops queued
autosaves and finalisation, shows one actionable conflict banner, and never
auto-retries the stale payload. The operator explicitly reloads current data
before continuing, leaving their local work visible until then.

The card tool reads and updates that same parent-owned token so its direct
centering write cannot race the panel's autosave. Legacy AI controls also send
the token and give a reload instruction on conflict.

## Migration and rollout

1. Take the normal backup/checkpoint and rehearse on a disposable PostgreSQL
   database. Run `npm run db:lint-sql migrations/0025_grading_optimistic_concurrency.sql`.
2. Apply `0025_grading_optimistic_concurrency.sql`. It is additive and
   idempotent: existing rows receive `grading_version = 1` through the
   non-null default.
3. Before deploying the server, temporarily set
   `GRADING_CONCURRENCY_COMPATIBILITY_MODE=true` on every application instance.
   This narrowly accepts a _missing_ token from an old cached browser by using
   the version read immediately before that request's CAS. Malformed tokens are
   still rejected. It is a rollout bridge, not steady-state conflict protection.
4. Deploy the server and current client together, invalidate/purge any static
   asset cache, and require active grading tabs to reload. Monitor logs for
   `[grading-concurrency] accepted missing expectedVersion` and 409 conflict
   audit events.
5. Once that compatibility log is quiet for the agreed browser/session cache
   window, unset `GRADING_CONCURRENCY_COMPATIBILITY_MODE` everywhere. Missing
   `expectedVersion` is then a 400 and all clients receive strict protection.

Do not deploy strict server enforcement ahead of the client without this bridge
or an equivalent forced client refresh: an old browser does not send a token.

## Rollback

The manual, owner-approved rollback statement is in
`migrations/rollback-grading-optimistic-concurrency.sql`; it is intentionally
not part of the migration runner. Roll back application code first, rehearse on
a disposable database, and only then drop the token column during a maintenance
window. Dropping the column removes conflict history and must not be used as a
routine recovery action.
