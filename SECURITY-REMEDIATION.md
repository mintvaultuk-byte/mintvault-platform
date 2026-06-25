# MintVault Security Remediation — `security/remediation-phases`

**Date:** 2026-06-23 · **Baseline:** OWASP Top 10 (2021/2025), ASVS 5.0
**Branch base:** `e62d650` (main) · **Status:** implemented, reviewed, tests green — **awaiting human-gated deploy**

This branch implements a phased security/robustness remediation. Every phase is
one commit, `tsc` clean, with the test suite passing (262 → 315 tests). **Nothing
has been deployed** — the deploy is the only remaining step and is gated on the
human checklist at the bottom.

**Final release-gate review (3 adversarial sub-agent lenses):** Security → **SHIP**
(0 findings) · Regression/cross-phase → **SHIP** (0 findings) · ASVS/deploy → **
FIX-THEN-SHIP** where every "fix" is a deploy-time human step (below), not a code
change. **Code is ship-ready.** Earlier per-phase reviews (Phase 1, Phase 3) had
their CRITICAL/HIGH findings fixed before commit.

---

## What the audit actually found (corrected baseline)

The original remediation plan's numbers were wrong; the verified reality:

| Plan claimed                          | Reality                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| 394 unique endpoints                  | **377 unique** (492 total registrations)                 |
| 115 duplicates                        | **115** ✓                                                |
| 46 behaviourally-different duplicates | **0** — byte-identical shadowed copies                   |
| 262 tests                             | 262 ✓ (all grading-math; **0 API tests** existed)        |
| "no public user accounts"             | **false** — `/api/auth/signup` creates `role='customer'` |

Already-clean (no action needed): BOLA/IDOR ownership checks, Stripe webhook
raw-body ordering, scanner timing-safe token auth.

---

## Phase-by-phase (commit → controls → evidence)

| Phase                  | Commit                 | OWASP / ASVS             | Status                                                                                                                                                                                                 |
| ---------------------- | ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — test safety net    | `f8f79bb`              | V1 verification baseline | ✅ route-uniqueness guard, first `requireAdmin` test, log-redaction seam                                                                                                                               |
| 1 — stop exposure      | `70847eb` (+`439de29`) | A01, A02, A04, A09       | ✅ recursive log redaction; `/api/db-check` prod-gated; redirect-log query strip. Production 5xx now collapse to a STRICT `{ error, requestId }` envelope (every other key dropped — see M1 below)     |
| 2 — CSRF               | `386a6d7`              | A01; API8                | ✅ same-origin `csrfOriginCheck`; exempts Stripe webhook + scanner token                                                                                                                               |
| 3 — route dedup        | `dfb78ba`              | A06 maintainability      | ✅ 115 shadowed dup routes removed; zero-dup CI guard; behaviour-preserving (verified)                                                                                                                 |
| 4 — readiness/shutdown | `00f7615`              | A06, A10                 | ✅ `/ready` probe; graceful SIGTERM drain                                                                                                                                                              |
| 5 — job locking        | `b582d1d` (+ commit 2) | A06, A08                 | ✅ advisory-lock guard on ALL 8 mutating jobs (pre-grade-cleanup, vault-club-grace-sweep, transfer-v2-sweep, archival-sweep, scan-reconciler, embed-corpus, ig-daily-post, weekly-reel) — see M2 below |
| 6 — CI/container       | `da27292`              | A02, A03, A08            | ✅ least-privilege CI, SHA-pinned actions, Dependabot, non-root Dockerfile + HEALTHCHECK, blocking critical audit                                                                                      |

---

## Post-verification remediation (2026-06-24)

An independent verification pass raised two MEDIUM findings; both are now closed.

- **M1 — production 5xx disclosure (closed, `439de29`).** The interceptor previously
  rewrote only `error`/`message`, so raw errors under `detail`/`details`/`debug`
  still reached clients ([routes.ts](server/routes.ts) seed/reset/grading,
  [admin-submissions.ts](server/routes/admin-submissions.ts) step-back). Replaced
  with `productionErrorEnvelope()`: in production every `status >= 500` JSON
  response collapses to a strict `{ error: "Internal Server Error", requestId }` —
  every other key dropped, including array/primitive bodies — and the interceptor
  logs only correlation metadata (requestId, status, method, normalized path),
  never the original. 4xx and non-production responses are untouched.
- **M2 — unlocked mutating jobs (closed in this pass).** `embed-corpus`,
  `ig-daily-post` and `weekly-reel` scheduled ticks are now wrapped in
  `withAdvisoryLock` (embed via the `index.ts` guard; ig/weekly around the actual
  post/reel execution inside their schedulers). All 8 mutating jobs are covered,
  enforced by [tests/job-locks.test.ts](tests/job-locks.test.ts). Manual/admin
  force-run paths are intentionally left unlocked (explicit human action; the
  per-day idempotency inside the run functions already prevents double-runs).

**Remaining LOW findings (deliberately deferred, accept-with-monitoring):**

- **L3** — 5xx via `res.send`/`res.end` ([stolen.ts:155](server/routes/stolen.ts:155) generic; [routes.ts:1786/1801](server/routes.ts:1786) empty) and the pre-middleware probes (`/ready`, `/api/db-check`) are generic but carry **no requestId** (they bypass the `res.json` interceptor). No data leak.
- **L4** — SIGTERM drains HTTP + closes pools but does not clear scheduled-job timers; a tick can still fire during the ≤10s drain (guarded by try/catch + advisory lock).
- **L5** — ad-hoc `console.error(..., err.message)` in handlers and the central error handler log raw error text **server-side** (by design, for correlation); a sensitive value embedded in an error string could reach server logs.
- **L6** — in development only, route-level 5xx still return raw `err.message` (the envelope is production-only, by design).

---

## Deferred (with residual risk) — NOT done on this branch

| Item                                                               | Why deferred                                                  | Residual risk                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Live-HTTP auth-matrix / BOLA tests                                 | needs supertest (new dep), a boot refactor, a staging test DB | low — ownership checks audited clean; covered by unit tests only                        |
| Versioned migration release-runner + repoint Fly health → `/ready` | needs staging DB testing + deploy-config change (human-gated) | medium on multi-machine rolling deploy; **single machine today**                        |
| Resend email idempotency keys                                      | needs SDK-version check + key threading                       | low — advisory lock already prevents multi-machine dup; single-machine crash-retry only |
| CodeQL, dependency-review                                          | need GitHub Advanced Security on a private repo               | low                                                                                     |
| SBOM + Trivy container scanning                                    | need image-build-in-CI plumbing                               | low                                                                                     |
| Prod-only dependency prune in Dockerfile                           | native-module (canvas/sharp) rebuild risk                     | low (image larger, not insecure)                                                        |
| Raise `npm audit` to blocking-high                                 | 1 dev-only HIGH (vite) to clear via `npm audit fix`           | low — vite not in prod runtime                                                          |
| ~100 unused-import lint warnings in routes.ts                      | pre-existing + dedup-exposed cleanup                          | none (warnings only)                                                                    |

---

## 🚦 Human-gated deploy checklist (do these on the deploy)

1. **Review the branch** and merge (one PR per phase, or squash).
2. **Container test the Dockerfile** — `USER node` + `chown` is unverified locally; confirm the image builds and the app can write any temp dirs it needs.
3. **CSRF staging-verification** — exercise the admin panel + customer flows on staging; confirm no legit same-origin POST is 403'd.
4. **fly.toml** — set `kill_timeout >= 10s` (graceful-drain window). Optionally repoint the readiness check to `/ready` (only after confirming `/ready` returns 200 on a healthy machine).
5. **Deploy staging first** (`-c fly.v2.toml`, app `mintvault-v2`), observe through one full background-job cycle.
6. **Deploy prod** (`fly deploy --app mintvault`) only on explicit go; keep the prior image for instant rollback.
7. Do **not** rotate `SIGNED_URL_SECRET` (it is not exposed; rotating breaks live customer links).
8. Confirm `SESSION_SECRET` is set in Fly secrets and is a strong 32+ char random value (`fly secrets list`).

---

## Verify locally

```bash
npm run check   # tsc — clean
npm test        # vitest — 315 pass
```

---

## Release Train A (branch `security/remediation-release`)

Cherry-picked the 10 security/ops commits onto `origin/main` (excluding the
unrelated `e62d650`). Then, per phase:

### Phase 1 — customer downloads + admin reprint

- NEW authenticated, tokenless, ownership-checked routes
  `GET /api/customer/submissions/:submissionId/{packing-slip,shipping-label}`
  (`requireCustomer`; ownership + state decided by
  [server/lib/customer-documents.ts](server/lib/customer-documents.ts);
  indistinguishable 404 for missing/deleted/wrong-owner; 400 for the owner's draft).
- Extracted `buildPackingSlipPdf` / `buildShippingLabelPdf` in
  [server/routes/submissions.ts](server/routes/submissions.ts) — shared with the
  preserved public token-gated email routes (behaviour-identical).
- Removed `packingSlipToken`/`shippingLabelToken` exposure from
  `GET /api/customer/submissions`; dashboard now uses tokenless links.
- Admin reprint: client routes through the supported `print-batch` /
  `print-batch/reprint` (claimed → 10–500-char reason dialog) via
  [client/src/lib/reprint.ts](client/src/lib/reprint.ts); the removed
  `/api/admin/printing/reprint/:certId` is NOT restored.
- Tests: BOLA/ownership (`customer-documents`), reprint routing (`reprint`),
  client contract guard (`client-endpoint-contract`).
- Review: 2 independent lenses (security/BOLA + regression/contract) → SHIP, 0 CRITICAL/HIGH.
- Gate: tsc clean; 339 tests; routes 379/379, 0 duplicates.

### Phase 2 — error correlation + safe logging (`e5a6971`, `82fae2f`)

- Every request gets a correlation id echoed as `X-Request-ID`; the central handler
  - `res.json`/`res.send` interceptor collapse EVERY 5xx to
    `{ error: "Internal Server Error", requestId }` in production
    (`server/lib/error-sanitize.ts`).
- `safeErrorSummary()` logs error class + provider-independent code + operation +
  requestId only — never raw message/stack/DSN. A source guard
  (`tests/raw-error-logging-guard.test.ts`) freezes the remaining raw-`err.message`
  log backlog monotonic (can only shrink).
- Tests: 24 `error-sanitize` cases + the source guard. Review: SHIP.

### Phase 3 — scheduler lifecycle + graceful shutdown (`108614d`)

- `server/lib/lifecycle.ts`: timer registry + in-flight guarded-job counter +
  idempotent `runGracefulShutdown` (mark → cancel timers → drain traffic → drain
  active jobs → close pools → exit; hard 10s deadline). Pools are never closed
  while a guarded job runs.
- All 8 job timers + keep-warm tracked; IG/weekly schedulers return idempotent
  cleanups and drain in-flight ticks. Lock names/intervals/cadence unchanged.
- Tests: 8 `lifecycle` cases. Independent reliability review: SHIP (a HIGH —
  in-flight IG/weekly ticks not drained — was found and fixed pre-commit).

### Phase 4 — Fly shutdown + production container (`6a32508`, `08c9c08`)

- `fly.toml` + `fly.v2.toml`: `kill_signal=SIGTERM`, `kill_timeout=15s` (> the 10s
  app deadline), `strategy=canary`, `wait_timeout=10m`, a `/ready` deploy-readiness
  check (single-machine availability caveat documented inline).
- `Dockerfile`: `npm prune --omit=dev` (verified zero devDeps in the runtime
  require graph), `TMPDIR=/tmp`, `USER node` + node HEALTHCHECK preserved. Follow-up
  `08c9c08` packages `content/legal/*.md` + `server/brand-logo.png` (read at
  runtime) into the image, guarded by `tests/docker-runtime-assets.test.ts`.
- Independent container/config review: SHIP (single-machine `/ready` finding
  resolved pre-commit). ⚠️ Docker unavailable locally → image build + non-root
  smoke + Trivy are OWED (CI/canary).

### Phase 5 — CI, lint gate, supply chain (`1d5d404`)

- Lint gate: `scripts/cricut-app/**` + `server/scripts/**` (gitignored vendored
  tools holding all 1626 errors) excluded in `eslint.config.js` → `npm run lint`
  exits 0; tracked app code keeps only warnings.
- Dependency: vite `7.3.3 → 7.3.6` (lockfile only) resolves HIGH
  `GHSA-fx2h-pf6j-xcff`; production audit 0 HIGH / 0 CRITICAL; no `--force`.
- CI (`.github/workflows/ci.yml`): least-privilege per-job gates for lint, tsc,
  tests, build, route-uniqueness, endpoint-contract, SBOM, prod/full audit,
  dependency-review, gitleaks, CodeQL, Docker build + non-root smoke + Trivy,
  ephemeral-Postgres. `checkout`/`setup-node` SHA-pinned; new actions tag-pinned +
  marked `pin-to-sha: OWED`. Independent supply-chain review: SHIP.

### Phase 6 — live HTTP authorization matrix (`cf258c9`)

- Isolated live-HTTP harness (`tests/helpers/auth-harness.ts`) mounts the REAL
  guards (requireAdmin/Auth/Customer/Grader/Staff/Capability/ScannerOrAdmin), real
  `csrfOriginCheck`, real `authorizeSubmissionDownload`, and reconstructs the
  two-layer 5xx wiring — the principal is injected via header (a faithful auth
  double; no DB/scheduler/provider touched).
- 37-test matrix across anonymous / legacy-customer / unified-user / grader /
  staff(grade/scan/print) / admin / scanner: role enforcement, BOLA/IDOR,
  `__graderProxy` in-app-only + forge-prevention, CSRF, scanner + Stripe
  exemptions, generic 5xx, rate-limit + upload limits.
- Independent OWASP access-control review: SHIP (4 findings resolved pre-commit).

### Phase 7 — complete release-train gate (this commit)

**Local gate — all green:**

| Check                                 | Result                                                           |
| ------------------------------------- | ---------------------------------------------------------------- |
| `git diff --check origin/main...HEAD` | CLEAN                                                            |
| `npm run check` (tsc)                 | 0 errors                                                         |
| `npm run lint`                        | exit 0 (0 errors, 2253 warnings)                                 |
| `npm test` (1 worker)                 | 399 passed / 25 files                                            |
| `npm run build`                       | OK                                                               |
| route inventory                       | 379 routes, 379 unique, 0 duplicates                             |
| client/server endpoint contract       | 0 real unmatched                                                 |
| production audit (`--omit=dev`)       | 0 HIGH / 0 CRITICAL (1 LOW: esbuild devtree)                     |
| full audit                            | 0 HIGH / 0 CRITICAL (2 LOW: esbuild, @babel/core — build-time)   |
| secret scan (local grep)              | clean (only the harness's dummy `sk_live_DEADBEEF` 5xx canaries) |

**Three independent read-only reviews → all SHIP, 0 code-level CRITICAL/HIGH:**

- **Security** (OWASP access-control, auth, CSRF, leakage, injection): SHIP.
  MEDIUM = CI action SHA-pinning (OWED, CI-plane); LOW = 318-site raw-error log
  backlog (frozen monotonic, Phase 18).
- **Reliability** (shutdown, timers, locks, readiness, Fly, container): SHIP. 2 NITs.
- **Regression** (customer docs, reprint, Stripe raw body, route inventory,
  existing behaviour): SHIP. Core business logic (labels, schema, pricing,
  packing/shipping) byte-unchanged; envelope scrubs 5xx only.

**OWED — remote / human gates (cannot run locally; NOT validated here):**

- Docker image build + non-root container smoke test + Trivy image scan (no local
  Docker daemon).
- First real CI run; SHA-pin the tag-pinned CI actions
  (codeql/trivy/gitleaks/dependency-review/docker/upload-artifact).
- gitleaks / CodeQL / dependency-review / ephemeral-Postgres jobs (GitHub-only).
- Staging CSRF/auth smoke (admin + customer flows) per the human-gated checklist
  above; first canary boot confirms the production image + `/ready` gate.

**Verdict: SHIP to staging review.** No code-level CRITICAL/HIGH; all
locally-runnable gates green. The residual items are remote-CI / Docker / human
staging gates that must be exercised before any production deploy. No push or
deploy performed.
