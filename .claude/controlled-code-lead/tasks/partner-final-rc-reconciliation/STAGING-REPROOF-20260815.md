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

---

# ADDENDUM — secret separation and the credential handoff (same day)

## 1. Staging secret separation — 2 of 3 done, 1 owner-gated by necessity

| Secret | Staging | Production | |
| --- | --- | --- | --- |
| `SESSION_SECRET` | `84768065c806ccbc` | `ba522bdfdf5f3ab2` | **SEPARATED** |
| `SIGNED_URL_SECRET` | `327f24432425f26a` | `dc424a4806920f3b` | **SEPARATED** |
| `ADMIN_PASSWORD` | `ee91aa784f02314e` | `ee91aa784f02314e` | **STILL SHARED — owner must set** |

Rotated with `flyctl secrets import` reading from stdin, so no value appeared in a command argument,
in output, or anywhere in this repository. Confirmed **only** by digest comparison. No production
secret was read or changed.

**`ADMIN_PASSWORD` was deliberately not rotated by me, and this is not deference — it is a
dependency.** Staging station approval runs through `requireSuperAdmin` + `requireAdminStepUp`, i.e.
the admin password. Rotating it to a value I am instructed never to print would lock the owner out of
staging admin and make sections 3–7 of this very task impossible. The owner has to know it, so the
owner has to choose it:

```bash
read -rs -p "New staging-only ADMIN_PASSWORD: " P && \
  printf 'ADMIN_PASSWORD=%s\n' "$P" | flyctl secrets import --app mintvault-v2 && unset P
```

(`read -rs` keeps it off the screen; piping keeps it out of shell history and out of the process list.)

**Staging after rotation:** v484 → both Machines on `d683eb98`, `/health` 200, `/ready` 200, partner
surface mounted (401, so the schema contract is satisfied), shared PostgreSQL rate-limit store
re-installed on both.

## 2. The credential-gated sections — made runnable, not hand-waved

`scripts/staging/at23-station-reproof.mjs` drives §3, §6 and §7 against both Machines with
`fly-force-instance-id` pinning. **The owner runs it**; credentials come from the owner's own
environment and are never printed, logged or persisted, and the evidence file records outcomes only.

Two safety properties, both verified rather than asserted:

- **It refuses any non-staging host.** Pointing it at `mintvaultuk.com` throws.
- **Its envelope construction is proven correct against LIVE staging** using a throwaway key: both
  Machines answered `invalid_station_code`, meaning the server parsed every header and the canonical
  string and failed only at station lookup. A malformed envelope fails differently.

### Why it mints a disposable station rather than using the scanner Mac's

The scanner app stores its station key encrypted through the macOS Keychain and **refuses any
plaintext fallback** (`scripts/scanner-app/lib/station-identity.js`), and that module cannot load
outside Electron. Exporting that key to run a test would defeat a deliberate security decision. So
`--new-identity` mints a throwaway identity: the private key goes straight to a `0600` file the owner
controls and is never printed; only the public key and fingerprint are shown, which are not secrets
and are exactly what `POST /api/partner/stations/enrol` expects. Both artefacts are gitignored.

### What the owner does

1. `node scripts/staging/at23-station-reproof.mjs --new-identity`
2. Enrol the printed public key on **staging** (`POST /api/partner/stations/enrol`, partner session
   with `partner.stations.enrol`), then approve the station in staging admin.
3. Export `STAGING_STATION_CODE`, `STAGING_STATION_KEY_FILE`, `STAGING_OPERATOR_SESSION`
   (an MFA-passed partner session token holding `partner.cards.scan`), plus the two Machine IDs.
4. `node scripts/staging/at23-station-reproof.mjs --sections 3,6,7 --out at23-evidence.json`
5. Send back `at23-evidence.json` — it contains outcomes only, no secrets.
6. Revoke the disposable station and delete the key file.

§4 (last-credit race), §5 (Scanner FIX) and §8 (restart continuity) additionally need an admin
session for credit adjustment, side invalidation and machine restart. The harness reports them
**NOT AUTOMATED** rather than pretending to cover them.

## 3. Final local gates on this tree

Partner gate **70 / 1284 / 0 / 0** · protected grading **587** · migrations + rollback **119** ·
rate-limit + runner integrity **24** · typecheck clean · lint 0 errors · build green ·
`git diff --check` clean.

The commits added after the staging deploy (`d683eb98`) touch only `.claude/`, `.gitignore` and
`scripts/staging/` — **none is build-reachable**, so staging's artifact is byte-equivalent to HEAD.
