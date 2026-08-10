# Partner Public Network — migration 0058 and the quality-rating evidence base

Status: **schema and service layer landed.** Rating engine, shop finder, public profile, Super
Admin management and partner self-service are implemented; see
`docs/partner-public-network-codex-contract.md` for the API contracts. Section 11 records the
hostile-panel findings that remain OPEN.

Branch: `opus/partner-final-integration`.
Migration: `0058_partner_public_network.sql` / `rollback-0058-partner-public-network.sql`.
Not applied to staging. Not applied to production.

---

## 1. Why the public address is a separate table

`partner_locations.address` is the **operational** address: where cards are physically handled, what
the connector reads, and what `0035` snapshots onto `certificates.origin_location_address` as
immutable provenance.

The public address is a different fact with a different lifecycle — Super Admin approves it, it may
lag the operational address, and it must be changeable without rewriting history.

```
CURRENT PUBLIC PROFILE   partner_public_listings      -> the shop's address TODAY
HISTORICAL CERTIFICATE   certificates.origin_*        -> the address AT GRADING TIME
```

Those two are allowed to disagree, permanently. A shop that moves from A to B shows B on its
profile while every certificate it graded at A still says A. `0035`'s `ENABLE ALWAYS` immutability
trigger enforces the second half; `0058` never writes to `certificates` at all.

`partner_locations` is **not** restructured. The only thing 0058 adds to it is a
`UNIQUE INDEX (tenant_id, id)` as a composite-FK target, and `rollback-0058` removes exactly that
and nothing else.

## 2. Listing states

```
DRAFT          -> PENDING_REVIEW, REMOVED
PENDING_REVIEW -> ACTIVE, DRAFT, REMOVED
ACTIVE         -> PAUSED, SUSPENDED, REMOVED
PAUSED         -> ACTIVE, SUSPENDED, REMOVED
SUSPENDED      -> ACTIVE, REMOVED
REMOVED        -> terminal
```

Enforced by `trg_partner_public_listing_transition` (`ENABLE ALWAYS`, so a
`session_replication_role=replica` session cannot bypass it). Only `ACTIVE` is publicly readable.
`REMOVED` is terminal on purpose: un-removing would resurrect a public URL retired for a trust or
legal reason. Recovery is a new listing with a new slug and a fresh approval, which leaves a record.

`CHECK chk_partner_public_listings_active_requires_approval` makes `ACTIVE` impossible without
`approved_at`, `approved_by` **and** `public_since`. Publishing without an approval record is not a
policy — it is unrepresentable.

## 3. Slugs

Globally unique (`uq_partner_public_listings_slug`), **not** per-tenant. A per-tenant index would
let tenant B claim tenant A's live URL; global uniqueness makes that a constraint violation rather
than a race. Shape is enforced in the database:
`^[a-z0-9]+(-[a-z0-9]+)*$`, length 3–120.

Immutable once published: the transition trigger refuses a `slug` change when `public_since IS NOT
NULL`. Before first activation it is still free to change. Rationale: after activation the slug is
in external links, QR codes and search results.

## 4. Postcode normalisation — and a bug the proof caught

`postcode_normalised` and `postcode_outward` are `GENERATED ALWAYS ... STORED`, not maintained by
the application. A normaliser living only in TypeScript is one missed call site away from an
unsearchable listing, and the finder would fail *silently* — empty result, HTTP 200.

`postcode_outward` is derived **positionally**: every UK inward code is exactly three characters, so
the outward code is "everything except the last three".

The first version of this column used the pattern `^[A-Z]{1,2}[0-9][0-9A-Z]?`. It is greedy, and it
returned `ME22` for `ME22NG` — the area, the district *and* the first digit of the inward code.
Every Strood listing would have been filed under a district that does not exist, and an outward
search for `ME2` would have returned nothing while still returning HTTP 200. This was found by
applying the migration to a real PostgreSQL 17 and asserting the value, not by reading the SQL.

Verified: `ME2 2NG`→`ME2`, `SW1A 1AA`→`SW1A`, `m1 1ae`→`M1`, `B33-8TH`→`B33`, `ME2`→`NULL`.

## 5. The anonymous-read problem

The shop finder is **anonymous**. It has no partner session, so no `app.tenant_id` GUC.
`partner_current_tenant()` returns `NULL`, and `tenant_id = NULL` is `NULL` — so a table carrying
only the standard `USING (tenant_id = partner_current_tenant())` policy returns **zero rows to every
public request**, silently, behind an HTTP 200. `server/partner/db.ts:173-177` documents this
fail-closed behaviour as the intended design of `partnerRuntimeQuery`.

`partner_public_listings` therefore carries an explicit public branch:

| policy | cmd | predicate |
|---|---|---|
| `..._public_read` | SELECT | `listing_status = 'ACTIVE'` |
| `..._tenant_read` | SELECT | `tenant_id = partner_current_tenant()` |
| `..._tenant_write` | UPDATE | `tenant_id = partner_current_tenant()` |

**The public branch is `FOR SELECT` and nothing else.** `0052:59-61` records why: PostgreSQL governs
DELETE by `USING` alone — `WITH CHECK` is never consulted for a row being removed. A permissive
non-tenant branch on `FOR ALL` would be a permissive DELETE branch over every ACTIVE listing in the
estate.

`partner_public_rating_snapshots` has no public branch and a write floor of `false`.
`partner_public_rating_overrides` is **entirely closed** to `partner_runtime` — no policy admits it
and no grant exists — because it carries `reason`, a Super Admin's internal rationale.

## 6. Partner self-service is enforced by column GRANT, not by a route handler

```sql
GRANT UPDATE (public_phone, public_email, public_website,
              public_opening_info, public_description, updated_at)
  ON partner_public_listings TO partner_runtime;
```

That is the whole partner write surface. A partner cannot write `listing_status`, `slug`,
`latitude`, `longitude`, any address column, `public_display_name`, `verified_at`, `approved_by` or
`public_since` — not through a bug in a route handler, not through a mass-assignment in a service,
not through a future endpoint nobody has reviewed. There is no INSERT and no DELETE grant anywhere.

0058's own assertion block fails the migration if any HQ-owned column becomes partner-writable.

## 7. Rating evidence — what is genuinely derivable

Established against the applied schema, and personally reproduced. **This is the constraint that
matters most: several metrics named in the original brief are not derivable, and must be reported as
unavailable rather than scored as perfect.**

| Metric | Derivable? | Source |
|---|---|---|
| Completed volume per location | **yes** | `certificates.origin_location_id` + `grade_approved_at IS NOT NULL` |
| First-pass approval rate | **yes** | `certificates.redo_count = 0` over approved cards |
| Returned-for-change rate | **yes, but not from where the brief assumed** | `certificates.redo_count > 0` |
| Rework intensity | **yes** | `SUM(redo_count) / COUNT(*)` |
| Post-publication correction rate | **partial — under-counts** | `audit_log` `cert_live_record_edit` |
| Grade variance vs a reference standard | **no** | no reference standard exists |
| Missed-defect rate | **no** | no defect snapshot is taken at submit |
| Card-identity-error rate | **no** | pre-approval identity fixes leave no record |
| Turnaround time | **no** | `partner_grading_work_items` has no `completed_at` |
| Image-quality score | **no** | `imagesForPartnerCert()` returns `quality: {}`, hard-coded |

### 7a. `returned_for_change` cannot yield a rate

`partner_grading_work_items.status` is **current state only**. There is no status-history table
anywhere in the estate. `returned_for_change` is transient: both re-entry doors
(`grading-routes.ts` submit-for-review, `grading-assignment.ts` assign) blindly overwrite it, and
neither increments a counter nor writes an event. After two bounces and an approval, the row reads
`approved` with no evidence it ever bounced.

`certificates.redo_count` **does** survive. `server/grader.ts:1128` increments it inside the
rejection CAS, and nothing in `server/` ever resets it. It is the only per-card return count that
persists. `server/grader.ts:1366` already computes grader quality from exactly this column, so the
approach has precedent in shipped code.

### 7b. The correction rate is deliberately marked unavailable in v1

Two writers of `cert_live_record_edit` use incompatible `entity_id` conventions:
`server/correction-mode.ts:502` writes the numeric `certificates.id`;
`server/routes.ts:2768` writes `canonicalCertId`, which is `certificate_number` (`MV-0000000205`).
A join on `entity_id = cert.id::text` silently drops the second writer.

The join *can* be widened to catch both. It is still reported as **unavailable** in v1, because an
under-counting correction rate makes a shop look *better* than it is — the one direction of error
that owner rule 11 forbids. It becomes available once the writers are unified.

## 8. Rating methodology — `PARTNER_QUALITY_V1` (specified, not yet implemented)

Internal 0–100; public 0.0–5.0 (`internal / 20`, one decimal).

| Component | Weight | Definition |
|---|---|---|
| First-pass approval | 0.60 | share of approved cards with `redo_count = 0` |
| Rework intensity | 0.25 | `clamp(1 - avg(redo_count) / 2.0, 0, 1)` |
| Correction cleanliness | 0.15 | `1 - correction_rate` — **unavailable in v1** |

Rules:

- **Volume is never a score component.** It feeds the sample threshold and confidence only. A shop
  cannot buy a better rating with throughput.
- **An unavailable component is excluded and its weight redistributed proportionally among the
  available ones.** It is never scored as 1.0. If fewer than two components are available, the
  rating is unavailable outright.
- First-pass approval and returned-for-change are exact complements. Both are reported as evidence;
  only one is scored, or the same signal would be counted twice.
- `evidence_availability` is persisted on every snapshot, so a later reader can always tell
  "no missed defects" from "we cannot measure missed defects".

`chk_partner_public_rating_snapshots_availability` makes the failure modes unrepresentable: a
snapshot with `rating_available = true` must carry a score, a label **and** `sample_size >=
minimum_sample`; one with `rating_available = false` must carry no public rating at all.

### Minimum sample: N = 10

Recorded rationale, since the brief requires one:

- At n = 10, one bounced card moves first-pass rate by 10 percentage points — the coarsest
  granularity still defensible on a public page.
- Below 10, a single card swings the rating by ≥12.5pp, which is noise presented as judgement.
- 10 is reachable within a pilot shop's first weeks, so shops are not stuck in "Rating building"
  indefinitely.
- Pilot volumes could not be inspected directly (no partner-originated certificates exist in
  production yet — the portal is not live there), so this is reasoned from the metric's sensitivity
  rather than from observed distribution. **Revisit once real pilot volume exists.**

Below threshold: `ratingAvailable = false`, `rating = null`,
`ratingLabel = "Rating building"`, with `sampleSize` and `minimumSample` both returned.

### Bands (on the internal 0–100 score)

| Internal | Label |
|---|---|
| ≥ 90 | Exceptional |
| ≥ 80 | Excellent |
| ≥ 70 | Very Good |
| ≥ 55 | Good |
| < 55 | Under Review |

Public label is **"MintVault Quality Rating"** — an operational rating derived from our own review
outcomes, explicitly **not** a customer-review score.

## 9. What is built

- `server/partner/public-network-rating.ts` — evidence extractor, `PARTNER_QUALITY_V1`, postcode
  normalisation, Haversine, bounding box
- `server/partner/public-network-service.ts` — finder, profile, recent cards, evidence measurement,
  snapshot + override recalculation
- `server/partner/public-network-routes.ts` — anonymous `/api/shops`, Super Admin
  `/api/super-admin/partner-listings`, partner `/api/partner/public-listings`
- `docs/partner-public-network-codex-contract.md` — the frontend handoff

Still to build: automatic/scheduled recalculation (see L2), and route-level integration tests
driving real HTTP through the finder and profile.

## 10. Proof performed

- `0058` applied to a **fresh PostgreSQL 17.10**, full chain: journalled `applied`; RLS
  `ENABLED + FORCED` on all three tables; transition trigger `tgenabled = 'A'`; 8 policies present;
  generated postcode columns correct across 5 cases; column grants exactly the safe set; overrides
  unreachable by `partner_runtime` on all four privileges; availability constraint rejects a
  published rating below minimum sample; `ACTIVE` rejected without an approval record.
- **Round trip**: applied → rollback → runner re-applies *unprompted* → applied. After rollback:
  journal row gone, no residue (no tables, no policies, no trigger function, no composite-FK index),
  and `partner_locations`, `idx_partner_locations_tenant` and the `0035` origin trigger all intact.
- `scripts/db/lint-destructive-sql.ts` clean on 0058.
- Migration manifests updated in 4 suites; `partner-rollback-integrity` (36), `partner-rls-isolation`
  + `partner-grading-bridge-migration` (101), `partner-schema-parity` and 5 further migration
  suites all green.
- `npm run check` clean; eslint clean on changed files; `git diff --check` clean.


---

## 11. Known limitations recorded at 0058 — MOST ARE NOW CLOSED

> **READ SECTION 12 FIRST.** This section is preserved as the historical record of what 0058
> shipped with. L1, L2, L4 and L6 — every HIGH in this list — were closed by migrations 0059–0062
> and the work described in section 12. Each is annotated inline below. The text of each finding is
> left unedited on purpose: a limitations list that quietly rewrites itself teaches nobody anything,
> and the reasoning that made these real is the reasoning that makes the fixes make sense.

A ten-agent adversarial panel reviewed the shipped code. Every BLOCKER/HIGH it found was
reproduced and fixed (see commit `0373ddac`). The findings below are **real and unfixed**. They are
recorded here rather than left implicit, because several of them limit what the rating may honestly
claim, and the public methodology text must not over-sell it.

### L1 — A shop partly controls its own denominator (fairness, HIGH)

> **STATUS: CLOSED** by `PARTNER_QUALITY_V2` (commit `e8da6945`). The denominator counts REVIEWED
> UNITS — `grade_approved_at IS NOT NULL OR redo_count > 0` — so an abandoned unit stays in the
> population permanently. The behavioural fixture that scored 2.9 honest / 5.0 gamed now scores 2.9
> either way. Mutation `REVIEW-DENOM1` proves it.


Evidence counts cards with `grade_approved_at IS NOT NULL`. A rejected card only re-enters review
when the **partner** resubmits it; nothing auto-resubmits and there is no timeout. So a card that is
rejected and simply abandoned is in neither the numerator nor the denominator, and its accumulated
`redo_count` is discarded with it.

Measured on the real engine: 20 cards of which 10 bounced once scores **2.9 / "Good"**; abandon the
10 bouncers and the same body of work scores **5.0 / "Exceptional"**.

Friction, not a control: abandoning a card strands its grading credits and blocks settlement of its
whole destination submission. Fixing it properly needs a durable "reached review" counter, which the
schema does not have — `partner_grading_work_items.status` is current-state-only.

**Consequence for the public methodology: do not describe the rating as a complete measure of a
shop's work. It measures the work the shop carried through to approval.**

### L2 — Ratings are stale by default; override expiry is advisory only (HIGH)

> **STATUS: CLOSED** in two halves. Override expiry is now evaluated at READ TIME (migration 0060,
> commit `88b1e2fa`) — no cron, no human, no reconciler required for correctness. Staleness is
> closed by migration 0062 (commit `42ccacd5`): lifecycle events mark the listing dirty durably, the
> refresh runs post-commit, and a bounded reconciler is the safety net. Mutations `OVERRIDE-EXPIRY1`,
> `RATING-AUTO1` and `RATING-FAIL1` prove it.


`recalculateRating` has three call sites, all manual Super Admin routes. There is no cron, job,
trigger or approval-time hook. Every published rating is frozen at whenever an admin last pressed
recalculate — a shop that degrades keeps its old stars, and one that improves keeps them too.
`calculatedAt` is exposed publicly so the staleness is at least visible, but nothing bounds it.

Consequently `expiresAt` on an override **does not automatically fire**. It is stored and shown to
Super Admin as a review-by date; an expired override keeps publishing until someone recalculates.
Treat it as a reminder, not an enforcement.

### L3 — Attribution is by card origin, not by who graded it (MEDIUM)

Evidence filters on `origin_location_id`, never on `assigned_grader_id`. If HQ reassigns a
partner-originated card to an in-house grader and that grade is rejected, the rework is charged to
the partner. At the minimum sample of 10 one such card costs ~0.4 of a public star. Whether HQ
reassignment of partner cards happens in practice is an operational question, not a code one.

### L4 — No recency window (MEDIUM)

> **STATUS: CLOSED** by the rolling 180-day window with low-sample fallback (commit `e8da6945`).
> Mutations `RECENCY1` and `RECENCY2` prove it.


Both scored components are means over unbounded history, so accumulated volume dilutes current
performance without limit. Measured: 1000 clean historical cards plus 100 recent cards that each
bounced twice scores **4.5 / "Exceptional"**, while those 100 recent cards alone score **0.0 /
"Under Review"**. The per-grader metric this design follows windows to 30 days; this one does not.
A window is `PARTNER_QUALITY_V2` territory — it changes every published value.

### L5 — Both scored components derive from the same column (MEDIUM)

`first_pass_approval_rate` and `rework_intensity` are both functions of `redo_count` over the same
rows. `MIN_AVAILABLE_COMPONENTS = 2` counts components, not independent signals, so with
`correction_cleanliness` unavailable in v1 the entire rating rests on one column. The guard is also
unreachable as configured: the two components become unavailable together (zero approved cards), so
there is no state with exactly one live component.

### L6 — The anonymous profile route drives the privileged admin pool (HIGH, infrastructure)

> **STATUS: CLOSED** by migration 0061 and the dedicated public pool (commits `2021922e`,
> `25d343b7`). Anonymous traffic runs as `partner_public_reader` against two restricted projections,
> on its own bounded pool with no privileged fallback. Mutations `PUBLIC-PRIV1`, `PUBLIC-POOL1` and
> `PUBLIC-TIMEOUT1` prove it.


`GET /api/shops/:slug` issues two `partnerAdminQuery` calls (recent cards, card count), because
`certificates` is not readable by `partner_runtime`. The admin pool is `max: 4` with no acquire or
query timeout, and it is shared with every Super Admin surface. Eight concurrent anonymous profile
requests exhaust it, and the rate limiter is per-machine. **This should be addressed before the
finder is exposed to real traffic** — either by bounding the admin pool's waits, or by denormalising
`cardsGraded`/recent cards onto the listing row as the rating already is.

### L7 — Geo search truncates at 500 and reports a derived total (MEDIUM)

The geo path applies `LIMIT 500` ordered by `slug`, then computes `total` from that truncated set.
Beyond 500 in-box listings the retained set is an arbitrary alphabetical slice, so the nearest shops
can be excluded while the API reports a confident, wrong `total`. Latent at pilot scale.

### L8 — Minor

- `override_rating_label` is unbounded free text with no vocabulary check, and is published
  verbatim. Every neighbouring field caps at 200–500 chars.
- Override create/remove are not atomic with the recalculation that publishes them; a failure
  between the two leaves the listing and the override table out of step with no reconciler.
- Recalculation appends a snapshot row per call with no dedupe or retention.
- `public_website` / `public_email` have no format validation at any layer. No client renders them
  yet; whoever builds the UI must treat them as untrusted (`javascript:` in an `href` would be
  stored XSS on an unauthenticated page).
- `0058` builds the `certificates` index non-concurrently, so applying it takes a brief write lock
  on the busiest table in the product. Worth a maintenance window on production.

---

## 12. What changed after 0058 — the hardening programme

Everything below is implemented and behaviourally proven on real PostgreSQL 17. Each item names the
migration and the mutation that keeps it honest.

### 12.1 `certificates.submission_id` never existed (migration 0049 repair, `b5908b50`)

Migration 0049, eleven runtime SQL sites and the connector's certificate INSERT all referenced
`certificates.submission_id`. That column does not exist on staging or production, is not in
`shared/schema.ts`, and no migration ever created it — only `submission_item_id` exists. 0049 was
therefore **undeployable**: its unique index, composite FK and two column-level GRANT lists each
raise 42703 against the real schema, so a staging pilot would have failed at "apply migrations",
before card one. Fifteen test fixtures hand-created a `certificates` table WITH the column, so the
entire estate was green against a table shape that exists nowhere.

The repair routes through the canonical relation the same estate already used correctly:
`certificate → submission_item_id → submission_items.submission_id`. No column was added to
`shared/schema.ts` — that would widen 150+ Drizzle selects for a value reachable one hop out. The
three-way identity guarantee is preserved transitively:

```
pgwi(destination_submission_id, submission_item_id) -> submission_items(submission_id, id)
pgwi(certificate_id, submission_item_id)            -> certificates(id, submission_item_id)
```

Mutation `SUBMISSION-ID1` reintroduces the assumption; 0049 then fails and rolls back.

### 12.2 `PARTNER_QUALITY_V2` (`e8da6945`)

**Denominator — reviewed units.** V1 counted APPROVED cards, so a unit that reached review, was
returned for change and then abandoned left the numerator and the denominator at once: abandoning
your worst work raised your score. V2 counts units that entered the review lifecycle and keeps them
there permanently.

```
REVIEWED_UNIT_PREDICATE:
  deleted_at IS NULL
  AND status = 'active'
  AND (grade_approved_at IS NOT NULL OR redo_count > 0)
```

`redo_count` is incremented inside the rejection CAS and never reset anywhere, so a bounce is
permanent evidence. `grade IS NOT NULL` is deliberately absent from the denominator — an abandoned
unit may never have been graded, and requiring a grade would reopen the exact hole. It moved to the
**first-pass numerator** instead: a unit approved with a NULL grade counts as reviewed but never as
first-pass, because we cannot prove it was cleanly approved and "we don't know" must not score as
"clean".

**One certificate row is one physical unit.** Repeated return/resubmit raises `redo_count` on the
same row, so `returned → resubmitted → returned → resubmitted → approved` is one sample carrying two
redos, not three samples. Sample size cannot be inflated by churn.

**180-day rolling window.** Used when it holds at least `MINIMUM_PUBLIC_SAMPLE` (10) reviewed units;
otherwise widened to the all-time population; and if that is also short, no rating at all. A thin
window never becomes a small rating — it becomes no rating. A unit with no usable timestamp counts
as INSIDE the window: dropping an undateable unit is the flattering direction, and this module
refuses flattering directions.

**Formula and weights** are unchanged from V1 and documented in section 8. V1 snapshots stay
interpretable: the version travels with the snapshot, `PARTNER_QUALITY_VERSION_V1` is retained as a
named constant, and only new snapshots carry V2.

Mutations: `REVIEW-DENOM1`, `REVIEW-DUP1`, `RECENCY1`, `RECENCY2`.

### 12.3 Suspension propagation (migration 0059, `230a251e`)

A listing was publicly visible on `listing_status = 'ACTIVE'` alone. Neither public query joined
`partner_organisations` or `partner_locations`, so suspending an organisation left its shop
advertised, rated and "verified" until somebody remembered to suspend the listing too.

**Why denormalised rather than a read-time join:** the public queries run with no tenant GUC, and
both source tables are ENABLE + FORCE RLS with tenant-isolation and no public branch. An `EXISTS`
join from the anonymous connection matches ZERO rows — it would not hide suspended shops, it would
hide EVERY shop, behind an HTTP 200.

So 0059 puts `org_status` and `location_status` on the listing, backfilled and kept honest by
**ENABLE ALWAYS** triggers plus a BEFORE INSERT stamp. ENABLE ALWAYS matters: propagation must fire
for every writer including a Super Admin running manual SQL during an incident. Eligibility is
`ACTIVE` on both; `PENDING` is deliberately not eligible.

Both the application predicate and the RLS policy carry the identical three conjuncts, and each is
mutation-proven **separately** — defence in depth means either layer alone hides the shop, which is
exactly why a test exercising both proves neither.

Mutation: `PUBLIC-SUSPEND1`.

### 12.4 Override expiry at read time (migration 0060, `88b1e2fa`)

`expires_at` was read only inside `recalculateRating`'s transaction while every public read consumed
the denormalised `current_*` columns, so an expired override was published verbatim indefinitely.

Correctness now happens at effective-rating SELECTION:

```
override in force := current_rating_is_override
                     AND (current_override_expires_at IS NULL
                          OR current_override_expires_at > now())
```

0060 denormalises the COMPUTED rating beside the effective one so an expiry has an honest fallback;
existing rows backfill from `partner_public_rating_overrides`, which already copies the computed
rating it displaced. Unresolvable rows fail closed to "Rating building".

**Nothing retires, deletes or rewrites an override row.** Value, reason, actor, `created_at` and
`expires_at` all survive — only the EFFECT lapses. The overrides table is not joined at read time
because `partner_runtime` holds no privilege on it and its `reason` column is internal governance
text.

Mutation: `OVERRIDE-EXPIRY1`.

### 12.5 Least-privileged public reader (migration 0061, `2021922e`)

Two queries reachable from an unauthenticated `GET /api/shops/:slug` ran on `partnerAdminQuery` —
BYPASSRLS, owner-privileged, and falling back to `MINTVAULT_DATABASE_URL` when its own URL is unset.

0061 adds `partner_public_reader` (NOLOGIN, NOSUPERUSER, NOBYPASSRLS) and two restricted views, with
**no grant on any base table**:

| Relation | Purpose |
|---|---|
| `partner_public_shop_projection` | eligible ACTIVE listings + effective rating, gates baked in |
| `partner_public_card_projection` | publication-eligible partner-origin cards only |

The views are **owner-checked, not `security_invoker`**: `security_invoker` would check the reader's
privileges on base tables, requiring table-wide SELECT on `certificates` and
`partner_public_listings` including every private column — the exact thing being removed. The view
DEFINITION is therefore the boundary, and 0061 asserts the gates are present in
`pg_get_viewdef` and that the card projection never names `private_notes`, `auth_status`,
`stolen_status`, `ownership_status` or `submission_item_id`.

Mutation: `PUBLIC-PRIV1`.

### 12.6 Dedicated public pool and the 503 contract (`2021922e`, `25d343b7`)

| Setting | Value | Why |
|---|---|---|
| `max` | 6 | Small and separate — a public spike exhausts this and nothing else |
| acquire timeout | 1000 ms | A saturated pool must say so quickly; queueing turns a spike into a pile-up |
| query timeout | 2000 ms | Client-side; frees the promise and the pool slot |
| statement timeout | 2000 ms | Server-side bound |
| lock timeout | 1000 ms | The one that matters — `query_timeout` leaves the backend still waiting |
| idle timeout | 10000 ms | Bursty traffic should not hold connections between bursts |

Each is env-overridable (`PARTNER_PUBLIC_DB_*`) but never unbounded. Every connection issues
`SET ROLE partner_public_reader`, so the restricted identity executes public SQL in every
environment. **There is no fallback** — a missing `PARTNER_PUBLIC_DATABASE_URL` fails closed.

Public database failure answers **503** with a fixed body:

```json
{ "error": { "code": "public_service_unavailable",
             "message": "Shop finder is temporarily unavailable. Please try again shortly." } }
```

503 rather than 500 is load-bearing: a client may retry a 503 and must not retry a 500, and an
outage reporting 500 looks like an application bug in every dashboard. Classification is an explicit
allowlist (`57014`, `55P03`, `53300`, the `08` class, node-postgres' client-side timeouts, missing
config) — a catch-all would convert genuine bugs into a soothing 503 and hide them. Nothing derived
from the error reaches the body: a pg connection error's message routinely carries the host and port.

Proven with real held connections and a real `ACCESS EXCLUSIVE` lock, asserting observed elapsed
time — not the test runner's timeout. Admin remains healthy throughout.

Mutations: `PUBLIC-POOL1`, `PUBLIC-TIMEOUT1`.

### 12.7 Rating automation (migration 0062, `42ccacd5`)

`recalculateRating` had three callers, all Super Admin routes, so a published rating was only as
fresh as the last time a human pressed Recalculate.

**Dirty state** on `partner_public_listings`: `rating_dirty`, `rating_dirty_since`,
`rating_last_attempted_at`, `rating_last_success_at`, `rating_failure_count`,
`rating_last_error_code`. Existing listings backfill DIRTY — none is known-fresh, and starting them
clean would assert a freshness nothing established.

**Why durable state and not just a post-commit call:** the process can die between commit and
refresh, a machine can restart, the refresh can fail. Each loses the work silently unless the
obligation is recorded. Marking dirty commits with the evidence that created it.

**The non-blocking contract.** A rating is secondary; nothing may fail a card's grading, approval,
settlement, certificate issuance, printing or completion. The dirty mark is one tiny UPDATE on the
caller's own client; everything expensive runs after the commit on its own connection behind a catch
that never rethrows. Failure mode: the listing stays dirty.

**Lock order:** `partner_public_listings` is acquired LAST, always. The approval hook sits after the
mirror transaction closes so that transaction keeps its single-table lock set; the rejection hook
fires only once its CAS confirms the unit moved. No cross-pool call from inside a transaction that
could wait on its own locks — that has no cycle for PostgreSQL to detect and simply hangs two pooled
connections.

**Reconciler:** bounded batch (default 25, hard-capped 500), no estate-wide transaction, per-item
catch, `FOR UPDATE SKIP LOCKED` for multi-machine safety, deterministic `rating_dirty_since ASC, id
ASC` ordering. Registered on the existing advisory-locked scheduler at a 5-minute interval. Pre-0062
databases are a clean no-op.

**Retry/failure policy:** failures are retried automatically and only surface to Super Admin after
`RATING_FAILURE_ATTENTION_THRESHOLD` (default 3) consecutive failures. A transient error must not
become a human task on its first occurrence. `rating_last_error_code` holds a short
application-chosen classification, never driver text.

Mutations: `RATING-AUTO1`, `RATING-FAIL1`.

### 12.8 Migration order for the pilot

Apply in ascending order; each rollback carries a descending-order guard and de-journals itself:

```
0049_partner_grading_work_items
0058_partner_public_network
0059_partner_public_eligibility_propagation
0060_partner_public_rating_override_expiry
0061_partner_public_reader
0062_partner_rating_dirty_state
0063_certificate_review_lifecycle_clock          # B1 review clock; ACCESS EXCLUSIVE, quiet window
0064_public_slab_image_projection                # B2 anonymous image path; ACCESS EXCLUSIVE
0065_certificates_reviewed_unit_index            # migrate:no-transaction — CONCURRENTLY, no window
0066_partner_rating_lifecycle_hardening          # rating CAS / lease / backoff; partner tables only
```

⚠️ **This list stopped at 0062 until 2026-08-09, and it is the list an operator applies from.**
Applying it as it stood produced an estate where the rating engine's `review_entered_at` column did
not exist and the live slab-image proxy's projection did not exist — i.e. a 500 on every rating
measurement and a 503 on every public card image. Per-migration lock modes, measured rather than
estimated, and the ordering constraint that 0065 must not share an `--apply` with a quiet-window
file, are in `docs/partner-migration-lock-safety.md` §5.

⚠️ **AND ONE STEP THAT IS NOT A MIGRATION.** After 0064 the anonymous slab-image proxy reads its
projection as `partner_public_reader` and fails closed. Before deploying the application:

```sql
-- run as a role that holds ADMIN on the group role; no migration can do this (0008 convention)
GRANT partner_public_reader TO <the login role in PARTNER_PUBLIC_DATABASE_URL>;
```

and set `PARTNER_PUBLIC_DATABASE_URL`. The public slab showcase is a LIVE production surface, and
every image on it 503s without both. `reportPartnerPublicNetworkReadiness` logs
`public_reader_role_unavailable` with the remedy at startup if the grant is missing.

`rollback-0061` deliberately REVOKES rather than DROPs `partner_public_reader`: a role is
cluster-wide, not database-scoped, so dropping it reaches outside the migration's own database, and
a NOSUPERUSER migrator may not hold ADMIN on a role another database's migrator created.

---

## 13. Release state — 2026-08-09

**Authoritative backend SHA: `c3668cf7`** (branch `opus/partner-final-integration`; PR #288
fast-forwarded to the same SHA). Staging unchanged, max applied migration **0046**. Production
unchanged at `6f182624`. Nothing deployed.

### 13.1 Database bootstrap contract — READ BEFORE PROVISIONING ANY ENVIRONMENT

The numbered migration chain is a **PARTNER OVERLAY, not a from-zero installer.** A virgin cluster
fails at `0010_partner_connector_import.sql` with `relation "users" does not exist`, because the
MintVault HQ base schema is owned by `shared/schema.ts` + `drizzle-kit`, and there is no
`0000_baseline`. The real contract is:

```
shared/schema.ts (drizzle) → numbered migration overlay 0001…0066
```

Do **not** claim, script or document "fresh database from the migrations". On that base, all 53
numbered files apply cleanly first time, and the 0066→0063 round trip returns a byte-identical
`pg_dump -s`.

### 13.2 CI test topology

`vitest.config.ts` sets `fileParallelism: !process.env.TEST_DATABASE_URL`, and `ci.yml` sets that
variable — so **CI runs test FILES SEQUENTIALLY**, one at a time. A local `npx vitest run` without
it runs up to 9 files concurrently, which is a HARSHER topology than the release gate. Reproduce
release failures with the CI environment (`pgvector/pgvector:pg16` on 55432, MinIO on 9010), not
with a bare parallel run.

Measured at `c3668cf7` in CI-equivalent topology: **272 files passed, 28 skipped, 0 failed ·
4853 tests passed, 828 skipped, 0 failed.** Zero all-skipped files.

### 13.3 Deploy-order gate

`npm run db:preflight-public` (`scripts/db/preflight-public-network.ts`) refuses the application
rollout unless every dependency is present: migrations 0058–0066 journalled `applied`;
`certificates.review_entered_at` and the six 0066 rating columns; all three public projections;
`partner_public_reader` NOLOGIN/NOSUPERUSER/NOBYPASSRLS; the reviewed-unit index present AND
`indisvalid`; the reader able to read each projection and **unable** to reach `certificates`;
0054's `cert_counter` guard enabled; and the rollout flag OFF.

Membership is proven by **doing it** — the gate connects as the login role and drops to the group
role. Read-only throughout. `--expect-flag-off=false` is the post-enable verification run.

### 13.4 The step no migration can perform

```sql
GRANT partner_public_reader TO <the login role in PARTNER_PUBLIC_DATABASE_URL>;
```

0061 creates `partner_public_reader` as a NOLOGIN GROUP role per the 0008 convention that
infrastructure grants membership out of band. Without this grant **and**
`PARTNER_PUBLIC_DATABASE_URL`, every public slab image 503s — and the slab showcase is a LIVE
production surface today.

### 13.5 Rollout order

1. `npm run db:preflight-public` — expect failures naming what is missing.
2. Apply migrations 0047 → 0066 in the grouped order and quiet windows of
   `docs/partner-migration-lock-safety.md` §5.
3. Set `PARTNER_PUBLIC_DATABASE_URL`; run the GRANT in 13.4.
4. `npm run db:preflight-public` — must pass, flag still OFF.
5. Deploy the application. Startup logs `[partner-public-network] READY … feature flag OFF`.
6. Smoke: a public `/cert/{id}` lookup, and a public slab image.
7. Enable `partner_public_network_enabled` (global row). Verify with
   `npm run db:preflight-public -- --expect-flag-off=false`.

Rollback is the exact reverse: flag OFF first (instant, no redeploy), then application, then
migrations in descending order — each rollback de-journals itself and refuses to run beneath a
later journal row.
