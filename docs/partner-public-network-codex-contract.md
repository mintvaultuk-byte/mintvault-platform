# Codex frontend contract — MintVault Public Partner Network

Backend contracts for the Shop Finder, public shop profiles, Super Admin listing management and
Partner self-service. **Build presentation only** — every business rule below is already enforced
server-side and must not be re-implemented or second-guessed in the UI.

Branch `opus/partner-final-integration`. Migration `0058` is **not** applied to staging or
production, so these endpoints will 500 until it is. Nothing here is live yet.

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
Auth: **none**. Rate limit 120/min per client.

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
        "version": "PARTNER_QUALITY_V1",
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
Auth: **none**. `404` for unknown, paused, suspended or removed.

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
  "rating": { "available": true, "isOverride": false, "rating": 4.6, "label": "Excellent", "sampleSize": 42, "minimumSample": 10, "version": "PARTNER_QUALITY_V1", "calculatedAt": "2026-08-08T18:20:00.000Z" },
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
| `POST` | `/:id/rating/override` | `{ rating?, label?, reason, expiresAt? }` |
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

`message` is safe to display.
