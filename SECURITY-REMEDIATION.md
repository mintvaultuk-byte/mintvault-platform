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

| Phase                  | Commit    | OWASP / ASVS             | Status                                                                                                                                                        |
| ---------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — test safety net    | `f8f79bb` | V1 verification baseline | ✅ route-uniqueness guard, first `requireAdmin` test, log-redaction seam                                                                                      |
| 1 — stop exposure      | `70847eb` | A01, A02, A04, A09       | ✅ recursive log redaction; response-layer 5xx scrubber (covers ~100 handlers); `/api/db-check` prod-gated; generic 5xx + requestId; redirect-log query strip |
| 2 — CSRF               | `386a6d7` | A01; API8                | ✅ same-origin `csrfOriginCheck`; exempts Stripe webhook + scanner token                                                                                      |
| 3 — route dedup        | `dfb78ba` | A06 maintainability      | ✅ 115 shadowed dup routes removed; zero-dup CI guard; behaviour-preserving (verified)                                                                        |
| 4 — readiness/shutdown | `00f7615` | A06, A10                 | ✅ `/ready` probe; graceful SIGTERM drain                                                                                                                     |
| 5 — job locking        | `b582d1d` | A06, A08                 | ✅ advisory-lock guard on 5 mutating jobs                                                                                                                     |
| 6 — CI/container       | `da27292` | A02, A03, A08            | ✅ least-privilege CI, SHA-pinned actions, Dependabot, non-root Dockerfile + HEALTHCHECK, blocking critical audit                                             |

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
