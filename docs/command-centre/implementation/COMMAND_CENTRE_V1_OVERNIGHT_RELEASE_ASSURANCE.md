# MintVault Command Centre V1 — overnight release assurance

**Decision date:** 2026-08-20 (Europe/London)  
**Branch:** `codex/command-centre-v1-reconciliation-20260819`  
**Current-main authority:** `origin/main` = `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`  
**Final candidate identity:** the commit containing this evidence file; the exact SHA is verified from Git and `/api/version` in the owner handoff because a commit cannot self-contain its own hash.  
**Decision:** **NO — not ready for owner production authorisation.** Production was not accessed or changed.

## Release-gate result

| Gate | Result |
|---|---|
| BLOCKERS open | 0 |
| HIGH open | 1 — `CC-OA-001` protected Admin client-IP authority |
| Release-blocking MEDIUM open | 1 — `CC-OA-025` exact-candidate Pilot OFF/ON live proof |
| Zero-dead-UI | PASS |
| Current-main reconciliation | PASS — 0 behind, merge-base exactly `facfd36f` |
| Rollback | READY and executed on staging |
| Ready for owner production authorisation | **NO** |

## Why the decision remains NO

### CC-OA-001 — protected Admin client-IP authority (HIGH, owner-blocked)

The owner authorised only replacing the raw leftmost `X-Forwarded-For` parser with Express `req.ip`, and required a stop if the application's trust-proxy authority was unsafe. The required precondition failed:

- `server/index.ts` configures `app.set("trust proxy", 1)`.
- Under Fly's public proxy topology, the app-facing rightmost forwarded hop is Fly infrastructure. Hop-count `1` therefore does not establish the external client as the only trusted address.
- The current leftmost parser remains forgeable by prepended values. Although `req.ip` ignores that leftmost value in the reproduced chain, hop-count `1` selects Fly's app IP rather than the external client, so legitimate proxied resolution fails and the parser-only substitution is not correct.

Per the owner's safety condition, the protected auth parser, login, passphrase, PIN, MFA, session, cookie, role and permission paths were left byte-unmodified. Closing this finding requires separate authority for a topology-correct client-IP design and its full auth regression matrix.

### CC-OA-025 — exact-candidate Pilot OFF/ON proof (release MEDIUM, evidence gate)

The exact repaired candidate was exercised live while the persisted flag remained ON. The authorised Super Admin UI was used to attempt OFF, but its native confirmation dialog could not be controlled by the available browser automation; the flag remained authoritatively ON. No direct database write, route bypass or credential extraction was used. Local real-QueryClient tests prove success→401/403/404/Pilot-OFF cache eviction, and the earlier `60b9e268` artifact completed ON→OFF→ON, but neither substitutes for the required exact-candidate live transition. This gate remains honestly open.

## Repaired and independently retested

All other reproduced BLOCKER/HIGH/release-MED findings are closed:

- privileged dashboard cache is session-scoped and evicted on logout, 401/403/404, Pilot OFF and unmount;
- London finance windows convert BST/GMT boundaries to the UTC-naive storage representation;
- connector `Date` values are validated and normalised before attention ordering;
- Partner counts fail closed above the 100-row authority bound;
- core and Partner reads use absolute destructive deadlines, bounded waves and no post-timeout pool work;
- Partner onboarding is set-based, keeps global flags inside the same read budget, preserves unreadable wallet/schema truth as UNKNOWN and supports pre-0091 staging schema;
- canonical `Metric<number>` credit envelopes are unwrapped correctly;
- 401/403/404 UI states, locked hierarchy, filters, breadcrumb, timing, accessibility, reduced motion and canonical Partner deep links are implemented;
- client/server build compatibility is baked consistently and rollout pins `--partner-network-consolidation true`;
- runtime harness signal and unexpected-child cleanup paths leave no disposable database;
- the 320px KPI token overflow is contained and guarded by a real Chrome/CSS regression.

Three isolated hostile reviewers independently retested auth/grading, Partner/domain and data/resilience scopes. Apart from `CC-OA-001`, they reported no remaining source BLOCKER/HIGH/release-MED finding. The mobile repair received a separate independent retest.

## Exact local proof

| Proof | Result |
|---|---|
| Current Command Centre glob | 18 files, 109/109 passed |
| Prior expanded Command Centre pass before the proof-only mobile commit | 19 files, 129/129 passed |
| Canonical isolated Partner matrix | 70/70 suites, 1,313 assertions |
| Runtime harness lifecycle | 10/10, zero disposable-database residue |
| Scanner protected subset | 5 files, 34/34 |
| Protected aggregate | 239 passed, 11 skipped |
| Protected grading retest | 69 passed, 2 skipped; protected diff clean |
| PostgreSQL 17 finance matrix | BST, GMT, month boundary, future/null/deleted/currency cases passed |
| Mobile layout control/candidate | pre-fix 885px document at 320px; candidate 320px with 256px card, `min-width:0`, `overflow-wrap:anywhere` |
| Typecheck | PASS |
| ESLint (`--quiet`) | PASS |
| Production build with canonical Partner flag | PASS |
| `git diff --check` | PASS |

The repository's generic flattened root test remains an invalid substitute for its shipped isolated Partner runner because process-global environment and cluster-global roles collide across suites. The canonical isolated matrix is the authoritative Partner result; this orchestration limitation was not misrepresented as green.

## Exact staging proof

The repaired runtime artifact `3d65b960` was deployed to staging before the proof-only mobile-test commit:

- image `registry.fly.io/mintvault-v2:deployment-01M0E2K5QPTYAYN0N8GJGAJQSX`;
- digest `sha256:925e8f94d670ecb0adafaf0af19aea2d9ed2ebd686c687efb63882f94962b2cd`;
- two LHR machines, both started with 1/1 health checks;
- live views Overview, Attention, Work Tree and Skills rendered;
- 320, 768 and 1280px viewports had no document overflow;
- bottom-sheet/dialog geometry, Tab/Shift+Tab focus wrap, Escape close and focus restoration passed;
- search capped at 80 characters and department/KPI/registry filters composed correctly;
- Partner onboarding rendered authoritative VALUE `6` on the pre-0091 schema; unavailable/unknown source truth stayed explicit;
- 1/5/10/20 protected-read tiers completed 1/1, 5/5, 10/10 and 20/20 with no failure;
- 15m44s protected soak completed 90/90, min 322ms, max 981ms, average 454ms, crossing London midnight without a timeout/error/5xx signature.

After this evidence commit, staging is redeployed once more and accepted only if both machines are healthy and `/api/version` equals the exact final Git SHA. That identity is reported in the final owner handoff.

## Rollback proof

Rollback was executed on staging, not inferred:

1. deployed prior image `registry.fly.io/mintvault-v2:deployment-01M0DTK3VQNA3FESW58R851JGT`;
2. verified both machines healthy and `/api/version` commit `60b9e268`;
3. restored repaired image `registry.fly.io/mintvault-v2:deployment-01M0E2K5QPTYAYN0N8GJGAJQSX`;
4. verified both machines healthy and `/api/version` commit `3d65b960`.

The prior image digest is `sha256:e2524959029d7ceac1cc96c2f104b6bdd001383f5fc8a8f2c50898be2254ed0d`. V1 adds no migration or write/backfill rollback requirement.

## Production boundary

Production remains forbidden. No production query, deployment, flag, configuration or data mutation occurred. The two open gates above must be closed and the affected proofs rerun before an owner production-authorisation answer can become YES.
