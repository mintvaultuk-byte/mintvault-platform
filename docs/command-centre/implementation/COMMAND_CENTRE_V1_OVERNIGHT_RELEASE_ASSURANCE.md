# MintVault Command Centre V1 — overnight release assurance

**Decision date:** 2026-08-20 (Europe/London)

**Branch:** `codex/command-centre-v1-reconciliation-20260819`

**Current-main authority:** `origin/main` = `e057a67d116162e65f0898c02f52d9a249c25069`

**Final candidate identity:** the commit containing this evidence file; the exact SHA is verified from Git and staging `/api/version` in the owner handoff because a commit cannot self-contain its own hash.

**Decision:** **YES — ready for owner production authorisation.** Production was not accessed or changed.

## Release-gate result

| Gate | Result |
|---|---|
| BLOCKERS open | 0 |
| HIGH open | 0 |
| Release-blocking MEDIUM open | 0 |
| Zero-dead-UI | PASS |
| Current-main reconciliation | PASS — 0 behind; candidate descends from `e057a67d` |
| Rollback | READY; earlier rollback executed on staging and immediate prior image captured |
| Ready for owner production authorisation | **YES** |

## Final two-gate closure

### CC-OA-001 — protected Admin client-IP authority (HIGH, closed)

The proposed `req.ip` replacement was correctly rejected. `server/index.ts` uses `trust proxy=1`, and the observed Fly chain makes Express select Fly's app-facing hop rather than the originating client. The final authority is independent of `req.ip` and caller-controlled forwarding metadata:

- Fly runtime is detected only from Fly's injected machine/app environment.
- The direct socket peer must be a single RFC1918 IPv4 Fly proxy hop; loopback, public, link-local, CGNAT and malformed peers fail closed in Fly runtime.
- `Fly-Client-IP` must be one canonical IPv4/IPv6 value and `Fly-Forwarded-Port` one valid port. Duplicate or malformed values fail closed.
- `X-Forwarded-For`, `Forwarded`, `X-Real-IP` and Express `req.ip` never participate in protected Admin identity.
- Local/non-Fly tests use only the direct socket peer and ignore forwarded headers.

The two-machine Fly probe observed Fly overwriting `Fly-Client-IP`, `Fly-Forwarded-Port` and `Fly-Region` while preserving a caller-prepended XFF value; both app socket peers were RFC1918 IPv4. Direct localhost retained forged Fly headers, proving why peer validation is mandatory. Public IPv4 and IPv6 probes both resolved through the documented Fly header. Authoritative references: [Fly request headers](https://fly.io/docs/networking/request-headers/), [Fly app services](https://fly.io/docs/networking/app-services/), and [Fly Machines runtime environment](https://fly.io/docs/machines/runtime-environment/).

The independent bypass reviewer reproduced the legacy control as `[200,200,200]` under rotated forged XFF and the candidate as `[200,200,429]`. Its held-out matrix passed 136/136, including raw duplicate headers, 100 forged rotations, IPv4/IPv6/mapped canonicalisation and Fly/local peer boundaries. The expanded protected Admin wiring passed 194/194. Normal login, PIN, sessions, roles and Partner/customer/staff/grader boundaries were unchanged.

Staging intentionally has no `ADMIN_IP_ALLOWLIST` configured, so membership admission is not claimed from that environment. Staging proves the exact Fly header/topology contract and both-machine artifact health; allowlist semantics are proven by real Express and independent hostile tests.

### CC-OA-025 — exact-candidate Pilot OFF/ON proof (release MEDIUM, closed)

The native Super Admin Pilot Controls UI at `/admin/partners/settings` completed ON → OFF → ON, including the real JavaScript confirmation dialog. No database write, environment toggle, route bypass or credential extraction was used.

- OFF persisted across refresh, removed Command Centre navigation and made `/admin/command` render the source-hiding feature-state denial.
- ON persisted across refresh, restored navigation and returned the authorised live dashboard with current KPIs and attention data.
- The final flag state is ON.
- Both Fly machines run the same embedded candidate and share the uncached persisted flag authority.

The evidence-only final commit is redeployed and the same native transition is repeated before the owner handoff.

## Other repaired findings

All earlier confirmed BLOCKER/HIGH/release-MED findings remain closed: privileged cache eviction; London finance boundaries; `Date` connector normalisation; Partner 100-row truth; core/Partner absolute destructive deadlines; set-based Partner readiness; unreadable flag/wallet/schema truth; canonical credit metrics; auth-state UI; locked hierarchy/filter/breadcrumb/timing/accessibility/reduced-motion/deep-link behavior; build compatibility; harness cleanup; and 320px overflow containment.

## Exact local proof

| Proof | Result |
|---|---|
| Admin client-IP/auth surface | 9 files, 194/194 passed |
| Independent client-IP hostile matrix | 136/136 passed |
| Command Centre glob | 18 files, 109/109 passed |
| Canonical isolated Partner matrix | 70/70 suites, 1,313 assertions, zero skips |
| Protected grading/current-code aggregate | 40 files, 765/765 passed |
| Scanner application | 152/152 passed |
| Mobile layout control/candidate | pre-fix 885px document at 320px; candidate 320px document with 256px KPI card |
| Typecheck | PASS |
| ESLint (`--quiet`) | PASS |
| Production build with canonical Partner flag | PASS |
| `git diff --check` | PASS |

The first isolated Partner run encountered one disposable-cluster connection termination in `partner-runtime-integration`; that suite passed 47/47 on a clean immediate replay, and the required whole-matrix rerun then passed all 70 suites and all 1,313 assertions. No failed run was represented as green.

## Exact staging proof

The final two-gate runtime artifact `8c1aac56` was deployed to staging as Fly v544:

- image `registry.fly.io/mintvault-v2:deployment-01M0ET8GH7D6MWY4845F0SWW9W`;
- digest `sha256:a79cf53ffe264c9f145a9e8152fa0d9619cebc8771dcbef112cf4cc8bdf43fe3`;
- two LHR machines, both started with 1/1 health checks and `/api/version=8c1aac56`;
- native Super Admin Pilot ON → OFF → ON passed and staging was left ON;
- live `/admin/command` returned authorised operational data after re-enable;
- Partner settings, protected grading, Scanner and payment/credit matrices remained green.

After this evidence commit, staging is redeployed once more and accepted only if both machines are healthy, `/api/version` equals the exact final Git SHA, and the native Pilot transition passes again. That exact identity is reported in the final owner handoff.

## Rollback proof

The earlier staging image rollback was executed, not inferred: v532 (`60b9e268`) was restored, verified 2/2 healthy, and the repaired image was restored and verified again. The immediate pre-two-gate recovery image is Fly v543:

- image `registry.fly.io/mintvault-v2:deployment-01M0ERFXFDRYJ2EP44HWAKRHQ9`;
- digest `sha256:d018716271b2ccb1681d44bbdc41c0e99e44c233dfd2b76c6367591a194a9b03`;
- embedded source `a4491693`;
- two healthy LHR machines at capture.

V1 adds no migration, business-data mutation or write/backfill rollback requirement. The Pilot OFF control is immediate containment.

## Production boundary

Production remains forbidden. No production query, deployment, flag, configuration or data mutation occurred. Release execution now waits for explicit owner production authorisation.
