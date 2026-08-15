# STAGING RE-PROOF — affected AT-23 sections (2026-08-15)

Purpose: re-prove the AT-23 sections made runtime-relevant by RC-F11 (station rate limiting)
against the final pushed RC, on two live staging Machines.

**The RC SHA CHANGED during this pass, on staging evidence.** `eaa7c181` was deployed, probed, and
found to have a real defect; it was fixed and `d683eb98` deployed. Section 7 of the brief anticipated
exactly this ("treat that as a release issue and adjust from evidence, then rerun").

| | |
| --- | --- |
| **FINAL RC SHA** | **`d683eb9835003ee857d18c0a1c120a3a32e5e0a2`** (supersedes `eaa7c181`) |
| Staging app / release | `mintvault-v2` **v483** |
| Machines | `8d9349be072948`, `d8d14d0f34d378` — exactly two, both started, checks passing |
| Serving | **both** report `commit: d683eb98` |
| `origin/main` | `36699531` — contained |
| Production | `36699531` / **v1084** — untouched by this pass, and contained in the RC |
| Rollback (staging) | v482 image `deployment-01M02KKA0CGRAS9V4QK9NW91YB`; prior v481 `…01M00CYZQKKVZDT53ACNEM2R44` |

## The finding that changed the candidate

The brief's section 7F asked whether both Machines observe shared enforcement. Probing the deployed
`eaa7c181` answered it, and the answer was no:

```
Machine A  /api/partner/stations/calibrations  x75  ->  60 served, then 429
Machine B  immediately afterwards              x10  ->  all served
Machine A  re-checked                                ->  still 429
```

`express-rate-limit`'s default store is **per-process**. Production runs two Fly Machines, so the
three RC-F11 limiters had an effective ceiling of **2× the published budget** (240/240/120 per minute
per station) with no shared state. The previous record claimed a single budget; that claim was wrong,
and only running against the real artifact exposed it.

A shared PostgreSQL store already existed and was already installed at boot
(`server/partner/rate-limit-store-pg.ts`, swapped in by `mount.ts`, invariant I19). The gap was one
substitution wide, so it was closed rather than documented:

```
rateLimit({...})  ->  partnerRateLimit({ name, windowMs, max, failClosed, keyFn })
```

Budgets, keys and route positions are unchanged (120/120/60 per minute, per station, after both
station guards). **Only the store changed.** `failClosed: true` costs nothing real: every one of
these routes needs the same database to do its work, so a store outage would have failed the request
anyway — it never turns a working scan into a refused one.

**Proven live on the new candidate**, both Machines, in the boot log:

```
[partner] shared PostgreSQL rate-limit store installed (limits are fleet-wide).
```

The four pre-existing limiters in `station-routes.ts` stay on `express-rate-limit` deliberately —
outside this repair's scope — and their 2× property is now measured and recorded rather than assumed.

## Section results

| § | Section | Result |
| --- | --- | --- |
| 1 | Pre-flight (git, staging state, isolation) | **GREEN** |
| 2 | Deploy exact RC to staging, both Machines | **GREEN** |
| 3 | Scanner NEW cross-Machine | **NOT RUN** — see below |
| 4 | Last-credit race cross-Machine | **NOT RUN** — see below |
| 5 | Scanner FIX cross-Machine | **NOT RUN** — see below |
| 6 | Station authority | **PARTIAL** — unauthenticated boundary GREEN, authenticated matrix NOT RUN |
| 7 | Rate-limit hostile proof | **PARTIAL** — see the table below |
| 8 | Process restart continuity | **GREEN** |
| 9 | Post-staging gates | **GREEN** |

### Why §3–§6 are NOT RUN, honestly

Every one of those sections requires a request signed by an **approved, enrolled station**
(`requireSignedStation` → Ed25519 over method+URL+body) plus an MFA-passed operator session.
Producing that on staging means enrolling a station, approving it as admin, and holding its private
key — i.e. entering the staging `ADMIN_PASSWORD`/`ADMIN_PIN` and handling a station secret. Those
credentials are the owner's and are not mine to enter.

**These sections are NOT claimed green, and no result is inferred from the local suites.** The local
suites do prove the same behaviours against real PostgreSQL over real HTTP — `partner-station-new-card`
(27), `partner-scanner-fix` (23), `partner-pilot-concurrency`, `partner-card-job-grading-bridge` — but
they run single-process, which is precisely the dimension staging exists to add.

### §7 in detail

| Requirement | Result |
| --- | --- |
| A — legitimate batch below threshold | **GREEN** (local: 60-card batch fully served) |
| B — abusive burst eventually 429s | **GREEN** — measured on staging (60 → 429) and locally for all three |
| C — keyed by intended station identity | **GREEN** (local) |
| D — Station A cannot consume Station B | **GREEN** (local, including across Machines) |
| E — Partner A cannot consume Partner B | **GREEN** — per-station key is strictly narrower than per-tenant |
| F — both Machines observe shared enforcement | **FIXED** — was NO on `eaa7c181` (measured); now fleet-wide, store install logged on both Machines |
| G — suspension/revocation beats rate-limit state | **NOT RUN** — needs station credentials |
| — unauthenticated flood cannot consume a station budget | **GREEN on staging** — 40 unauthenticated POSTs to `/card-jobs` returned 400, never 429, proving the limiter sits after authentication |

### §8 restart continuity — what was proven

Machine `8d9349be072948` was restarted mid-service. Machine `d8d14d0f34d378` served throughout. The
restarted Machine returned on the same SHA with `/ready` 200, the partner surface mounted (401, not
503 — so the schema contract still satisfied), an identical station boundary, and the shared
rate-limit store re-installed. No observable authoritative state was process-local.

Not proven without credentials: that a *session*, *Card Job*, *wallet* or *idempotency key* survives
a restart. Those are proven by the local suites, not by this staging exercise.

## Isolation (verified by digest comparison; no secret value was read)

| | Staging vs production |
| --- | --- |
| `MINTVAULT_DATABASE_URL` | **different** ✓ |
| `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **different** ✓ |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | **different** ✓ |
| `RESEND_API_KEY` | **different** ✓ |
| `STAGING_ONLY` | present on staging only ✓ |

**Three pre-existing shared values, recorded as findings:** `SESSION_SECRET`, `SIGNED_URL_SECRET`
and `ADMIN_PASSWORD` are **identical** on staging and production. Not blocking this exercise (sessions
live in the differing database), but a staging compromise would hand over a production-valid session
signing key, presigned-URL HMAC key and admin password. Worth rotating independently.

Staging has no `STRIPE_WEBHOOK_SECRET` (production does) — consistent with AT23S-F1.

## Local gates on `d683eb98`

| Gate | Result |
| --- | --- |
| Pinned Partner gate | **70 suites / 1284 passed / 0 failed / 0 skipped** |
| Protected grading (20 files) | **587 passed**, 2 platform-gated skips |
| Migrations + rollback | **115 / 115** |
| Station rate-limit behavioural (fleet-wide model) | **9 / 9** |
| `npm run check` · `npm run lint` · `npm run build` · `git diff --check` | clean · 0 errors · green · clean |

No protected grading file is touched by this pass.

## Concurrency note

Production was deployed by a concurrent session **three minutes before this pass began**
(v1084 / `36699531`). That is the fifth move of main or production during this programme. The RC
contains it, so there is no clobber risk — but re-read `fly releases` and `/api/version` immediately
before any production action.

## Verdict

**PRODUCTION-DEPLOYABLE: NO** — not because a defect is open, but because the authenticated
Scanner NEW / FIX / last-credit-race / station-authority sections have **not** been re-proven on
staging against `d683eb98`, and RC-F11 now changes those exact paths more than it did before: they
perform a PostgreSQL upsert per request and fail closed if the counter cannot be read.

**What would close it:** someone holding the staging partner/station credentials runs AT-23 §Scanner
NEW, §FIX, §last-credit race and §station authority against `d683eb98` on both Machines. That is a
credential-gated step, not an engineering one.
