# Programme: Super Admin Project Control Dashboard

| Field | Value |
|---|---|
| Programme ID | `super-admin-project-control` |
| Phase | P1 — foundation build (database, backend, frontend, engines) |
| Branch | `codex/super-admin-project-control-master` |
| Worktree | `/Users/cornelius/mintvault-project-control-master` (isolated) |
| Baseline commit | `e6c7c139` (origin/main tip, = production at time of build) |
| Governance version | 1.1 |
| Proof level reached | **Locally verified** (see Definition of Proof below) |
| Date | 2026-07-25 |

## Stage 0 — Baseline

- Main session was on `codex/set-name-editing-system` @ `584ba6e2`; local `main` was stale at
  `e6fd64da`. Fetched `origin/main` = `e6c7c139` and branched the new worktree from that, so the
  build sits on the same commit production is running.
- `git worktree list` shows ~80 live worktrees — this is precisely the condition the dashboard
  exists to make legible.
- Protected systems in play: **none touched.** No grading file, no Stripe/webhook file, no auth
  logic, no cert numbering, no R2 signing, no existing table.
- Prohibited for this task, per the brief and the governance model: no deploy, no merge, no push,
  no migration application, no production write, no new dependency.

## Stage 1–3 — Review plan and verification

Investigated directly by the Lead rather than fanned out to reviewers (the harness for this
session was instructed not to spawn agents). Verified before writing anything:

- An earlier Project Control build exists as an unmerged WIP commit `19aa73dd` on
  `integration/mintvault-project-control-reviewed-candidate` (three `project_control_*` tables,
  five server files, one page). It is not on `main`, and memory records it as carrying migration
  0019/0020 collisions. **Decision: build fresh on a clean migration number rather than resume
  it.** That earlier candidate is superseded by this work, not merged into it.
- Route/module conventions confirmed against the live code (`server/routes/admin/catalogue.ts`,
  `server/partner/admin-routes.ts`), not from memory.
- Migration numbering confirmed by listing `migrations/`: 0019–0024 are contested across unmerged
  branches and production. 0030 chosen as collision-free.
- `requireSuperAdmin` confirmed to exist at `server/auth.ts:200` before being relied on.

## Stage 4 — Change manifest

Additive only. See `change-manifest.md`.

## Stage 6 — Regression

| Gate | Result |
|---|---|
| `npm run check` (tsc) | PASS, 0 errors |
| `npm test` (full Vitest) | 2282 passed, **0 failed**, 635 skipped |
| `npm run lint` | 0 errors; 0 warnings on any new file |
| `npm run build` | PASS — client chunks + server bundle produced |
| Route runtime proof | PASS — all 17 routes mounted, all return 401/403 unauthenticated |

Pre-existing, NOT caused by this work: 5 test *files* fail to import in a bare shell
(`vq-backend`, `vq-fetch-art-stored-pointer`, `vq-higgsfield-observability`,
`auth-security-migration`, `rarity-structured-migration`). Proven identical on the untouched
`/Users/cornelius/mintvault-platform` worktree before this branch existed.

Two tests were updated because they are deliberate manifest pins that fire on ANY new migration —
`partner-schema-parity` (pins the migration inventory) and `partner-credit-reservation-service`
(clears journal rows ≥0018 to reach its evidence guard). Both were updated to acknowledge 0030;
neither guard was weakened.

## Definition of Proof

| Dimension | State |
|---|---|
| Design | Complete |
| Implementation | Complete and wired (routes registered, pages routed, engines used) |
| Verification | **Locally verified** — typecheck, full unit suite, lint, production build, and a real-HTTP route/auth proof |
| Activation | **Not activated.** Migration 0030 is authored and NOT applied to any environment. Nothing is deployed, merged, or pushed. |

The dashboard is **not** "live". Until 0030 is applied, `/admin/project-control` will load and
show its "migration has not been applied" message.

## Protected actions NOT taken (and not authorised)

- `git push` — not done.
- merge to `main` — not done.
- deploy (staging or production) — not done.
- migration application (`npm run db:migrate --apply`, `db:push`, raw DDL) — not done.
- dependency install — not done (the route integration test was written against the repo's own
  `http.createServer` + `fetch` pattern specifically to avoid adding `supertest`).
- secret/env change — not done.

## Next authorised action

Owner review of this report. Nothing else is authorised.

---

## Phase 2 — Hostile-review remediation (2026-07-26)

Independent hostile review of `b4073169` returned **NEEDS CHANGES** with 2 Critical, 9 High and
11 Medium findings. All were remediated on the same branch and worktree; migration 0030 was
revised in place because it had not been applied anywhere.

| Gate | Result |
|---|---|
| `npm run check` (tsc) | PASS, 0 errors |
| Project Control suites | 246 passed, 0 failed (6 files) |
| Full `npm test` | 2,459 passed, **0 failed**, 635 skipped |
| `npm run lint` (touched files) | 0 errors, **0 warnings** |
| `npm run build` | PASS |
| Migration integrity (disposable local DB) | 34 passed — FKs, cascades, triggers, checks, rollback |

The same 5 pre-existing test FILES fail to import in a bare shell (`vq-backend`,
`vq-fetch-art-stored-pointer`, `vq-higgsfield-observability`, `auth-security-migration`,
`rarity-structured-migration`). Proven identical on the untouched worktree before this branch
existed; unrelated to this work.

## Proof level after Phase 2

| Dimension | State |
|---|---|
| Design | Complete |
| Implementation | Complete and wired |
| Verification | **Integration verified locally** — engines, runtime authorization across all 25 routes × 6 identities, and migration integrity against a real disposable PostgreSQL |
| Activation | **Not activated.** Flag `super_admin_project_control_enabled` is absent (fail-closed). Migration 0030 not applied to staging or production. Nothing deployed, merged or pushed. |

## Next authorised action

Second hostile review. Nothing else is authorised.

---

## Phase 3 — Second-hostile-review remediation (2026-07-26)

Second independent hostile review of `a36916d8` returned **NEEDS CHANGES**: no unresolved
Criticals, four mandatory High findings, and a set of Medium/hardening items. All repaired on the
same branch; migration 0030 revised in place because it remains unapplied outside disposable
local databases.

| Finding | Repair |
|---|---|
| H-1 production evidence environment | `production_check` now requires a canonical `production` environment; staging/local/preview/test/blank/malformed all fail closed, with a named shortfall. |
| H-2 commit-scoped evidence | New `shared/project-control-scope.ts` is the single authoritative scoper; every engine routes through it. Commit-independent kinds narrowed to three, justified in code. |
| H-3 optimistic locking / audit atomicity | The UPDATE now RETURNS and the row count decides; zero rows ⇒ 409, no audit row, no claimed version. `expectedVersion` mandatory. |
| H-4 redaction gaps | Cloudflare 37-hex, `GOCSPX-`, Slack webhooks, lower/mixed-case PEM, dotted/spaced/slashed key names, glued shapes, once/twice-encoded URLs. Error logs redacted. |
| Idempotency | Stable `idempotency_key` on deployments and test runs, derived from identifying facts, never from a timestamp. |
| Illegal transitions | Rejected with 409; a Super Admin override is explicit, reasoned and separately audited. |
| Iterative tree | Sorting, roll-up and collection are iterative; 5,000-deep chains and cycles no longer overflow. |
| Refresh limiting | Expensive-route limiter plus single-flight coalescing and a server-side minimum refresh interval. |
| Drift disclosure | `DRIFT_DISCLOSURE` on every report and rendered in both clean and drifted states. |

**Found and fixed during this pass, beyond the brief:** the redaction assignment pattern was
quadratic — 50,000 characters of ordinary words took 4.3 seconds, a denial-of-service on any long
evidence field. Bounded quantifiers plus a fail-closed input cap: now 6 ms, with a performance
regression test.

| Gate | Result |
|---|---|
| `npm run check` | PASS |
| Project Control suites (9 files) | 367 passed, 0 failed |
| Full `npm test` | 2,582 passed, **0 failed**, 635 skipped |
| Lint (touched files) | 0 errors, 0 warnings |
| `npm run build` | PASS |
| Migration + concurrency (disposable local DB) | 55 passed |

Proof level unchanged: **Integration verified locally. Not activated anywhere.**

---

## Phase 4 — Third-hostile-review remediation (2026-07-26), recorded 2026-07-29

**This section closes a documentation gap, not an engineering one.** Phases 1–3 above were
written before two further commits landed, so the ledger described `7562f055` while the branch
tip was `ab81d4f3`. A reconciliation audit on 2026-07-29 found the branch two commits ahead of
its own record and reported the findings as unresolved. They are not.

### The "M-1 / M-2 / M-3" naming

A verbal hand-off referred to three open Mediums as **M-1, M-2 and M-3**. That numbering appears
nowhere in this repository — not in this ledger, not in a commit message, not on any branch. The
third hostile review numbered its findings **H3-1 … H3-4**: one High and three Mediums.

**M-1/M-2/M-3 are H3-2, H3-3 and H3-4 under an informal name. All four H3 findings are fixed and
committed.** Verified by reading the code, not the commit messages:

| Finding | Severity | Fix | Code evidence |
|---|---|---|---|
| H3-1 — a deployment is not a verification | High | Production category reads `not_started` with a named shortfall; deployment credit still earned; readiness capped below 100%; next action becomes `verify_production` | `shared/project-control-readiness.ts:488-501`; `"verify_production"` at `shared/project-control.ts:790,909` |
| H3-2 — genuine redeploys swallowed | Medium | Request idempotency separated from event identity; identity needs a caller-supplied `externalId`/`externalRunId`/`idempotencyKey`; missing or malformed ⇒ HTTP 400 | `server/project-control/idempotency.ts:105,126,134-140`; `IDEMPOTENCY_KEY_PATTERN`, `EXTERNAL_ID_PATTERN` |
| H3-3 — separator collision | Medium | `"\|~\|"` concatenation replaced with length-prefixed, name-sorted, domain-separated encoding; `IDEMPOTENCY_DOMAINS` carries a `/v1` suffix so the encoding can change without re-identifying history | `server/project-control/idempotency.ts:21-46`. The only two surviving `"\|~\|"` strings are in the comment describing the removed behaviour — no live code path uses it |
| H3-4 — self-certifying evidence | Medium | An `evidenceRef` must resolve to a real record on that package, of a kind that can prove a requirement, supporting not contradicting, non-stale, surviving commit and environment scoping | `shared/project-control-readiness.ts:120,128,139` |

Found beyond the brief in the same pass: the redaction assignment pattern was quadratic —
50,000 characters of ordinary words took 4.3 s, a denial of service on any long evidence field.
Bounded quantifiers plus a fail-closed input cap brought it to 6 ms, with a performance
regression test.

No migration change was needed: 0030 already carried the idempotency columns and the
timestamp-free unique indexes. Its full lifecycle was re-verified on fresh disposable databases —
forward, idempotent rerun, rollback, second forward, zero leftover objects.

### Commits in this phase

| Commit | Content |
|---|---|
| `ee9f158e` | Partial H3-1: production-verification evidence restricted to `production_check`. Committed separately because it had been left uncommitted in the worktree by a prior session. |
| `ab81d4f3` | H3-1 completion, H3-2, H3-3, H3-4, plus the severity-canonicalisation and iterative-layout hardening. 69 new cases across three suites; event identity exercised against a real disposable PostgreSQL 17 through the real service functions with genuine concurrent connections. |

### State recorded 2026-07-29 by the preservation pass

| Fact | Value |
|---|---|
| Branch tip | `ab81d4f3` |
| Working tree | clean |
| Position vs `origin/main` | 5 ahead, 19 behind (`main` moved to `6f182624`) |
| `npm run check` | PASS, 0 errors — re-run 2026-07-26 and again during the 2026-07-29 pass |
| Migration 0030 | authored, **not applied** to staging or production (both journals hold 23 rows, no `project_control%` table exists on production) |
| Feature flag | `SUPER_ADMIN_PROJECT_CONTROL_ENABLED` **unset**; `isProjectControlEnabled()` fails closed |
| Remote backup | **`git push` is BLOCKED by GitHub secret-scanning push protection.** Two synthetic fixtures in the adversarial redaction suite are shaped like real Slack credentials: `tests/project-control-redaction.test.ts:49` (`xoxb-…`) and `tests/project-control-hardening.test.ts:299` (a `hooks.slack.com` webhook URL). Both are placeholder test data proving the redactor catches Slack shapes; neither is a real credential. Resolving this needs an owner decision — allow the two strings via GitHub's unblock URLs, or reshape the fixtures. Until then the branch is preserved as a verified `git bundle` under `/Users/cornelius/mintvault-preservation-bundles/`. |

### Next authorised action

Independent hostile review of `ab81d4f3` — the fourth pass has not been reviewed by anyone but
its author. Then, and only then: rewrite `server/project-control/seed-data.ts` against the
2026-07-29 reconciliation (its `partner-portal` package points at this branch; G6B and G6C are
recorded as `not_deployed` when both are merged and running dark in production), merge dark,
apply 0030 to staging, and set the flag — as four separate owner approvals.
