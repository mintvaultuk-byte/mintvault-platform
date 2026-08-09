# Codex frontend contract — MintVault Public Partner Network

Backend contracts for the Shop Finder, public shop profiles, Super Admin listing management and
Partner self-service. **Build presentation only** — every business rule below is already enforced
server-side and must not be re-implemented or second-guessed in the UI.

Branch `opus/partner-final-integration`. Migrations `0058`-`0066` are **not** applied to staging or
production. Nothing here is live yet.

⚠️ Do NOT code against "these endpoints will 500 until it is", which is what this said until
2026-08-09. It is wrong in both directions now:

- With the rollout flag `partner_public_network_enabled` **OFF** — its default, and its state in
  every environment today — every anonymous route returns **404** with the ordinary `NOT_FOUND`
  body. A dark feature must be indistinguishable from an absent one.
- With the flag ON but `PARTNER_PUBLIC_DATABASE_URL` unset, or its login role not a member of
  `partner_public_reader`, they return **503** `public_service_unavailable`.

Handle 404 and 503. Do not special-case 500.

---

## 1. Rules the UI must not fight

- **Never compute or adjust a rating client-side.** The server sends the effective rating already.
- **`rating.available === false` means show `rating.label` ("Rating building") and NO stars.** Do
  not render 0 stars, an empty star row, or "unrated" — and never substitute a number.
- **A shop with `latitude === null` is normal**, not an error. It is text-searchable and simply has
  no distance. Never place it on a map at 0,0.
- **`distanceKm` is null unless the caller supplied `lat`/`lng`.** Do not display "0 km".
- Only `ACTIVE` listings are ever returned by the public endpoints. `PAUSED`/`SUSPENDED`/`REMOVED`
  return **404**, deliberately indistinguishable from "no such shop".

---

## 2. Shop Finder

```
GET /api/shops
```
Auth: **none**. Rate limit 120/min per client. Gated by `partner_public_network_enabled` (default OFF) — see the 404 note on `/api/shops/:slug`.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | – | Matches shop display name only (substring, case-insensitive) |
| `postcode` | string | – | Any format: `ME2 2NG`, `me22ng`, `ME2-2NG`, or outward alone (`ME2`) |
| `town` | string | – | Exact, case-insensitive |
| `county` | string | – | Exact, case-insensitive |
| `lat` | number | – | −90…90. Must be sent with `lng` |
| `lng` | number | – | −180…180 |
| `radiusKm` | number | 40 | 1…250. Only meaningful with `lat`/`lng` |
| `page` | int | 1 | |
| `pageSize` | int | 20 | max 50 |
| `sort` | enum | `distance` if geo, else `quality` | `distance` \| `quality` \| `name` |

Repeating a parameter (`?town=a&town=b`) is a **400**, not a silent pick.
`sort=distance` without `lat`/`lng` is a **400** (`DISTANCE_REQUIRES_COORDINATES`).

### Response `200`

```json
{
  "rows": [
    {
      "slug": "mint-vault-test-cards-strood",
      "displayName": "MintVault Test Cards Strood",
      "tradingName": "MintVault Test Cards Ltd",
      "townCity": "Strood",
      "county": "Kent",
      "postcode": "ME2 2NG",
      "country": "GB",
      "latitude": 51.3959,
      "longitude": 0.4783,
      "distanceKm": 1.8,
      "verified": true,
      "rating": {
        "available": true,
        "isOverride": false,
        "rating": 4.6,
        "label": "Excellent",
        "sampleSize": 42,
        "minimumSample": 10,
        "version": "PARTNER_QUALITY_V2",
        "calculatedAt": "2026-08-08T18:20:00.000Z"
      }
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 5,
  "totalPages": 1,
  "appliedSort": "distance",
  "geo": true
}
```

`appliedSort` and `geo` report what the server actually did, so the UI never has to infer why the
order looks as it does.

**Ordering under `sort=quality`:** rated shops always precede unrated ones; ties break by name then
slug. A "Rating building" shop can never outrank a rated one.

---

## 3. Shop Profile

```
GET /api/shops/:slug
```
Auth: **none**. `404` for unknown, paused, suspended, removed — **or when the public network is not enabled in this environment** (`partner_public_network_enabled`, default OFF). All five are deliberately indistinguishable: telling an anonymous caller that a shop exists but is suspended, or that a feature exists but is dark, is itself a disclosure.

### Response `200`

Everything in the finder row, plus:

```json
{
  "slug": "mint-vault-test-cards-strood",
  "displayName": "MintVault Test Cards Strood",
  "tradingName": "MintVault Test Cards Ltd",
  "addressLine1": "12 High Street",
  "addressLine2": null,
  "townCity": "Strood",
  "county": "Kent",
  "postcode": "ME2 2NG",
  "country": "GB",
  "latitude": 51.3959,
  "longitude": 0.4783,
  "distanceKm": null,
  "verified": true,
  "publicSince": "2026-06-01T00:00:00.000Z",
  "phone": "01634 000000",
  "email": "strood@example.com",
  "website": "https://example.com",
  "openingInfo": "Mon–Sat 9:00–17:30",
  "description": "Independent card shop and MintVault grading partner.",
  "rating": { "available": true, "isOverride": false, "rating": 4.6, "label": "Excellent", "sampleSize": 42, "minimumSample": 10, "version": "PARTNER_QUALITY_V2", "calculatedAt": "2026-08-08T18:20:00.000Z" },
  "stats": { "cardsGraded": 42 },
  "recentCards": [
    {
      "certId": "MV-0000000205",
      "cardName": "Charizard",
      "cardSet": "Base Set",
      "cardYear": "1999",
      "cardNumber": "4/102",
      "grade": "9.0",
      "gradedDate": "2026-08-01T10:12:00.000Z",
      "frontImageUrl": "/api/public/slab-image/MV-0000000205/scan"
    }
  ]
}
```

- `frontImageUrl` is a **same-origin proxy path**, not a presigned URL. Use it directly in `<img>`.
  It re-checks publication itself, and it is cacheable.
- `recentCards` is capped at 12 and may be `[]`.
- `stats.cardsGraded` is server-derived. A partner cannot influence it.
- Link each card to the existing certificate page via `certId`.

**Never expect these fields — they are not in the DTO and never will be:** tenant/organisation ids,
wallet, credits, payments, orders, staff or user records, customer PII, audit or security events,
internal rating components, override rationale, listing internal ids.

---

## 4. Quality rating — how to render it

`rating.label` is authoritative; do not derive your own from the number.

| `available` | Render |
|---|---|
| `true` | `rating` out of 5 (one decimal) + `label` + "based on N graded cards" (`sampleSize`) |
| `false` | `label` ("Rating building") + "N of M cards graded" (`sampleSize` / `minimumSample`). **No stars.** |

`isOverride: true` means a Super Admin set this figure by hand, not the formula. `version` is
`null` in that case. Such a rating may sit below `minimumSample` — that is a deliberate, audited
exception, and `minimumSample` still reports the real gate rather than being rewritten to match.
Render it as a rating; do not claim it was computed.

Call it **"MintVault Quality Rating"**. It is an operational rating derived from MintVault's own
review outcomes — **not** customer reviews. Do not label it "reviews", "customer rating" or
"satisfaction".

Bands: `Exceptional` ≥90, `Excellent` ≥80, `Very Good` ≥70, `Good` ≥55, `Under Review` below —
thresholds on the internal 0–100 score, which is **not** exposed publicly.

### 4a. `PARTNER_QUALITY_V2` — what `version` means

`version` is `"PARTNER_QUALITY_V2"` on every rating the formula produced, and `null` on an override.
Older snapshots carry `"PARTNER_QUALITY_V1"`; if you ever surface history, do not relabel them — the
two versions counted different populations and a V1 figure is only interpretable as V1.

What V2 counts, so your copy is accurate: **reviewed units**, not approved cards. A card that
reached HQ review stays in the population whether or not it was ever approved, and repeated
resubmissions of the same physical card count **once**. `sampleSize` is a count of physical cards,
so "based on N graded cards" is the correct phrasing.

The population is a **rolling 180-day window** when it holds at least `minimumSample` units,
otherwise the shop's all-time history. This is not surfaced as a separate field and you should not
claim a period in the UI — say "based on N graded cards", never "in the last 6 months", because for
a low-volume shop the figure is all-time.

### 4b. Freshness — you do not need to render it

Ratings refresh automatically: an HQ review marks the shop dirty and a refresh runs immediately
after, with a reconciler as the safety net. There is **no** dirty/stale field on the public DTO and
none is planned. A rating you receive is the last successfully computed one, which is always a real
computed figure — never a partial or in-progress value. Do not build a "refreshing…" state; there is
nothing to show.

Staleness is an internal operations concern and appears only in the Super Admin Needs Attention
projection (section 9).

### 4c. Override expiry

An override with a past `expiresAt` simply stops applying — the response reverts to the computed
rating and `isOverride` becomes `false`, with no admin action and no delay. You never see an expired
override, so there is no "expired" state to render. Render exactly what the response says.

---

## 5. Partner self-service

```
GET /api/partner/public-listings
PUT /api/partner/public-listings/:id
```
Auth: partner session. `GET` needs `partner.location.view`; `PUT` needs **`partner.users.manage`**
(Owner/Manager only — these fields are published to the public, so editing them is a write of the
shop's public identity, not a read) and not-view-only.

`GET` returns `{ "rows": [...] }` — a tenant may run several shops, one listing per location. `PUT`
addresses a single listing by id; it does not fan out across the tenant's other shops.

`PUT` body — **these five keys only**:

```json
{ "phone": "01634 000000", "email": "shop@example.com", "website": "https://example.com",
  "openingInfo": "Mon–Sat 9:00–17:30", "description": "About the shop." }
```

Any other key returns **403 `FIELD_NOT_EDITABLE`** listing the offending fields — the API rejects
them explicitly rather than ignoring them, so the UI must surface that message rather than assume
success. Address, coordinates, display name, slug, verification, listing status and the rating are
HQ-owned and are additionally blocked by a database column grant.

Show the rating and listing status **read-only** in the partner portal.

---

## 6. Super Admin

Base: `/api/super-admin/partner-listings`. Auth: Super Admin. All mutations require a
`reason` string and are audited; responses carry `"audited": true|false` — surface `false` as a
warning, it means the change committed but the audit write failed.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Review queue. `?status=DRAFT\|PENDING_REVIEW\|ACTIVE\|PAUSED\|SUSPENDED\|REMOVED` |
| `POST` | `/` | Create DRAFT: `{ locationId, slug, displayName }` |
| `POST` | `/:id/status` | `{ status, reason }` — lifecycle transition |
| `PUT` | `/:id/public-details` | Identity, structured address, `latitude`/`longitude`, contact, `reason` |
| `POST` | `/:id/verify` | `{ verified, reason }` |
| `GET` | `/:id/rating` | Evidence + last 20 snapshots + override history. **Read-only, persists nothing** |
| `POST` | `/:id/rating/recalculate` | Recompute and persist |
| `POST` | `/:id/rating/override` | `{ rating?, label?, reason, expiresAt? }`. `expiresAt` genuinely expires. 0060 makes the effective rating fall back to the computed one AT READ TIME the moment the override lapses, and 0066's clock-driven reconciler refreshes the stored row too. Label it "expires". ⚠️ This said "advisory review-by date — nothing recalculates on a schedule" until 2026-08-09, contradicting §4b and §4c of this same document; a UI built from the old wording will describe the behaviour wrongly. |
| `DELETE` | `/:id/rating/override` | `{ reason }` — retire the active override |

Legal transitions (the API returns **409 `ILLEGAL_TRANSITION`** otherwise; the database enforces
them too):

```
DRAFT          -> PENDING_REVIEW, REMOVED
PENDING_REVIEW -> ACTIVE, DRAFT, REMOVED
ACTIVE         -> PAUSED, SUSPENDED, REMOVED
PAUSED         -> ACTIVE, SUSPENDED, REMOVED
SUSPENDED      -> ACTIVE, REMOVED
REMOVED        -> (terminal)
```

`latitude`/`longitude` must be sent **together or both null**. There is no geocoder — a Super Admin
enters coordinates by hand. A listing without them is valid.

`GET /:id/rating` returns per-metric evidence:

```json
{ "metric": "correction_rate", "available": false, "rawValue": null, "normalised": null,
  "source": "audit_log entity_id has two incompatible conventions …", "sampleSize": 0 }
```

Ratings recalculate automatically — on every HQ review that changes the evidence, and by clock when the 180-day window moves. `calculatedAt` is still worth surfacing as the age of the figure. ⚠️ This said "only when an admin presses recalculate" until 2026-08-09; that stopped being true at 0062 and is doubly untrue since 0066.

Render unavailable metrics as **"Not measurable"** with the `source` text as the explanation.
Never render them as 0, 100% or a dash implying perfection.

---

## 7. Visual states

| State | Trigger |
|---|---|
| `ACTIVE` | public endpoints return the shop |
| `PAUSED` / `SUSPENDED` / `REMOVED` | public endpoints 404; visible only in Super Admin |
| `RATING_BUILDING` | `rating.available === false` |
| `RATED` | `rating.available === true` |
| `NO_COORDINATES` | `latitude === null` — hide from map, keep in list, no distance |
| `NO_RECENT_CARDS` | `recentCards.length === 0` |

---

## 8. Errors

All errors: `{ "error": { "code": "...", "message": "..." } }`.

| Status | Codes |
|---|---|
| 400 | `INVALID_INPUT`, `DISTANCE_REQUIRES_COORDINATES`, `INVALID_SLUG`, `REASON_REQUIRED` |
| 403 | `FIELD_NOT_EDITABLE`, `ACTOR_REQUIRED` |
| 404 | `NOT_FOUND`, `LISTING_NOT_FOUND`, `NO_LISTING`, `LOCATION_NOT_FOUND`, `NO_ACTIVE_OVERRIDE` |
| 409 | `ILLEGAL_TRANSITION` |
| 429 | `RATE_LIMITED` |
| 500 | `internal_error` |
| 503 | `public_service_unavailable` |

`message` is safe to display.

### 8a. `503 public_service_unavailable` — the one you must handle

The public database is unreachable, saturated or timing out. Exact body:

```json
{
  "error": {
    "code": "public_service_unavailable",
    "message": "Shop finder is temporarily unavailable. Please try again shortly."
  }
}
```

Applies to **both** `GET /api/shops` and `GET /api/shops/:slug`. It is transient and **retryable** —
unlike `500`, which is not. Suggested handling: show the message, offer a retry, do not clear cached
results the user is already looking at, and do not report it as a client error.

It is bounded by design: the public pool gives up within ~1–2 seconds rather than hanging, so a
spinner will not sit indefinitely. Nothing about the database appears in the body — no SQLSTATE,
role, host or query — so it is safe to display verbatim.

### 8b. Suspended or ineligible shops return `404`, never `403`

A shop whose listing is not ACTIVE, or whose organisation or location has been suspended or revoked,
is absent from the finder and `404`s on its profile. This is deliberate: telling an anonymous caller
"this shop exists but is suspended" is itself a disclosure. Render your normal not-found state. A
shop can disappear between a finder result and a profile click — handle that as an ordinary 404.

---

## 9. Super Admin — Needs Attention

One backend projection of genuine exceptions. **Healthy submissions and listings never appear** —
the predicate is failure, not activity, so an empty list is the expected steady state and should be
rendered as reassurance ("nothing needs attention"), not as an empty table.

The rating slice is live today:

```
GET  /api/super-admin/partner-listings/needs-attention
auth Super Admin session + partner admin capability
```

```json
{
  "ratings": [
    {
      "listingId": "0c2f…",
      "slug": "strood-cards",
      "failureCount": 4,
      "lastErrorCode": "lock_timeout",
      "dirtySince": "2026-08-09T09:14:22.118Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `failureCount` | Consecutive failed recalculations. Only listings at or above the threshold (default 3) appear |
| `lastErrorCode` | Short classification: `statement_timeout`, `lock_timeout`, `deadlock`, `resource_exhausted`, `connection`, `schema`, `unknown`. Never driver text — safe to display, but it is an engineering hint, not user copy |
| `dirtySince` | When the listing first became stale and stayed stale — the useful "how long has this been broken" figure |

A rating that failed once and recovered never appears here: the reconciler retries automatically and
almost every real failure clears without anyone looking. Presence in this list means automatic
recovery has already been tried and has not worked.

Other exception categories (settlement stuck, security hold, post-review cancellation request,
identity/address approval, print/completion inconsistency, impossible workflow state) are defined in
`docs/partner-public-network-0058.md` §12 and are **not yet exposed on this route**. Build the page so
additional keys alongside `ratings` can be added without a redesign.

---

## 10. What updates itself, and what needs a human

| Thing | Who |
|---|---|
| Effective public rating | **Automatic** — refreshed on every HQ review, reconciled as a safety net |
| Rating override expiry | **Automatic** — lapses by clock at read time |
| Shop disappears when suspended/revoked | **Automatic** — DB trigger propagation, no listing action needed |
| Public card list and card count | **Automatic** — derived from published certificates |
| Phone, email, website, opening info, description | **Partner** (Owner/Manager) — self-service, no HQ approval |
| Display name, address, coordinates, verification, listing status | **Super Admin** — high-risk, controlled |
| Rating override create/remove | **Super Admin** — exception only, audited, reason required |
| Manual "Recalculate" | **Super Admin, exception only** — emergency tooling. Routine operation does not need it |

If a screen you are building implies a Super Admin must press something for a healthy card to
progress, that is a bug in the design — check this table before building the button.
