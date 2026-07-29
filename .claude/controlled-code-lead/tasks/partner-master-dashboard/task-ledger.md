# Task ledger — partner-master-dashboard

## Stage 0 — Baseline (2026-07-28)

| Field | Value |
|---|---|
| Task ID | `partner-master-dashboard` |
| Title | Super Admin Partner Master Dashboard — first production-ready version |
| Worktree | `/Users/cornelius/mintvault-partner-master-dashboard` |
| Branch | `feat/partner-master-dashboard` |
| Baseline commit | `6f182624` (= `origin/main` at task start) |
| Baseline commit subject | Merge pull request #265 from mintvaultuk-byte/codex/mv700-tcgdex-identification |
| Worktree status at creation | clean (no uncommitted, no untracked) |
| Governance version | 1.1 |
| Owner grant | Build locally only. **No deploy. No push. No merge.** Local commit authorised. |

### Origin/main sanity check
`git fetch origin main` succeeded; `origin/main` tip = `6f182624`. No unexpected divergence
found relative to the index. The primary checkout (`/Users/cornelius/mintvault-platform`) is
on an unrelated branch `codex/set-name-editing-system` with untracked governance dirs — NOT
touched by this task.

### Protected systems in play (must NOT be modified)
- MVGS grading logic (`shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`,
  `shared/mvgs-input-builder.ts`, `client/src/components/grading/**`, `server/grader.ts`)
- Certificate rendering (`server/labels.ts`, `server/certificate-document.ts`)
- Stripe payment + webhook code
- Admin/staff/partner authentication logic
- `cert_counter` / certificate numbering
- R2 presigned-URL signing
- Append-only credit ledger semantics
- Immutable grading-origin snapshot ("Graded by <Shop>" / HQ)

### Explicitly prohibited for this task
`git push`, any deploy, `db:push`/`drizzle-kit push`, applying any migration to any
environment, destructive SQL, secret/env changes, dependency install of NEW packages,
paid provider calls, production or staging writes.

### Scope
Read-only Super Admin cross-tenant dashboard at `/admin/partners/dashboard` + supporting
read-only API endpoints, tests, and (if unavoidable and justified) a review-only index
migration file that is authored but NOT applied.

## Stage 1 — Review plan (complete)
Five read-only reviewers, non-overlapping scopes:
| Reviewer | Scope |
|---|---|
| `database-reviewer` | partner schema, wallet/ledger, statuses, migrations, indexes |
| `backend-reviewer` | server/partner routes + services + guards + conventions |
| `frontend-reviewer` | admin routing, shell, component inventory, query conventions |
| `security-reviewer` | admin/super-admin RBAC, tenancy, IDOR, PII, flags |
| `controlled-reviewer` | quality rating, corrections, devices, grading origin, G6D state |

### Baseline gate results (before any edit)
| Gate | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm run check` (tsc) | exit 0, clean |
| `npx eslint .` | 0 errors, **2482 warnings** (the bar: add no errors, no new warnings) |
| `LC_ALL=C LANG=C npx vitest run` | Files: 146 passed / **5 failed** / 49 skipped (200). Tests: 2825 passed / 635 skipped (3460) |

**The 5 baseline failures are PRE-EXISTING and ENVIRONMENTAL, not code defects.** The fresh
worktree has no `.env`, so `MINTVAULT_DATABASE_URL` / `TEST_DATABASE_URL` are unset and the
suites abort at import (`server/config.ts:7`). Identified: `tests/rarity-structured-migration.test.ts`,
`tests/vq-backend.test.ts`, `tests/vq-fetch-art-stored-pointer.test.ts`,
`tests/vq-higgsfield-observability.test.ts` (+1 not named in captured output). None are
partner-related. DECISION: do NOT copy the main checkout's `.env` into this worktree — it
carries LIVE Stripe keys and points at the shared staging DB. DB-backed tests are reported as
**not runnable locally**, never as passed.

## Stage 2 — Reviewer investigation
(status recorded in `reviewer-status.md`)
