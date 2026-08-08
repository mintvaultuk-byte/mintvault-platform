# Partner Public Network — migration 0058 and the quality-rating evidence base

Status: **schema landed, service layer not yet built.** This document records the decisions that
0058 encodes, and the evidence findings that constrain what the rating may claim. It is the
starting point for the rating service, the finder/profile APIs and the Codex UI contract.

Branch: `opus/partner-final-integration`. Baseline `74f5296e` (CI green).
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

## 9. What is NOT built yet

The schema is landed and proven. Still to build:

- evidence extractor + `PARTNER_QUALITY_V1` service + recalculation endpoint
- `GET /api/partners/public/shops` (finder, Haversine distance, sort/pagination)
- `GET /api/partners/public/shops/:slug` (profile, allowlist DTO, recent eligible cards)
- Super Admin listing/rating management APIs
- Partner safe self-service endpoints
- behavioural test suites, the 12-mutation matrix, execution floors
- Codex frontend contract

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
