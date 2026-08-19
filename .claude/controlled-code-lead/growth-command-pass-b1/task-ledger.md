# Task ledger — Growth Command Pass B1

## Stage 0 — Baseline (recorded 2026-08-19)
- Branch: `codex/growth-command-pass-b1`
- Commit: `f024f9388658946edbeff91158d7fd895b1e7b2c`
- `git status`: clean
- Production commit: `36699531` via `https://mintvaultuk.com/api/version`; it is behind this baseline.
- Build/test status: pending baseline gates.
- Protected systems in play: Stripe confirmation/webhook fulfilment boundary, submission ownership access, public certificate data.
- Explicit scope: GB-01 paid-success recovery and multi-card validation; GB-02 SSR metadata, canonical, Journal/sitemap, real 404, and noindex policy.
- Explicit prohibited actions: deployment, push, migrations, database or production writes, Stripe/provider changes, Scanner or Partner changes, and changes to payment semantics/idempotency/auth.

## Stage progress
| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-19 | Isolated worktree clean. |
| 1 — Review plan | done | 2026-08-19 | Two non-overlapping read-only reviews assigned. |
| 2 — Investigation | done | 2026-08-19 | Both reviews completed; one certificate-report canonical defect found and repaired. |
| 3 — Lead verification | done | 2026-08-19 | Verified root causes, API/client contracts, route policy, and reviewer finding. |
| 4 — Implementation authorisation | done | 2026-08-19 | Change manifest contains only B1 files; no protected action. |
| 5 — Implementation | done | 2026-08-19 | GB-01 and GB-02 only. |
| 6 — Regression | done | 2026-08-19 | Focused 11/11, typecheck, lint, build, diff and local HTTP proof complete. |
| 7 — Final report | done | 2026-08-19 | Local-only handover; deployment deliberately not performed. |

## Reviewer assignments
| Reviewer | Scope | Report |
|---|---|---|
| `gb01_reviewer` | Success retrieval token boundary and multi-card validation | completed — accepted |
| `gb02_reviewer` | SSR SEO, route/noindex policy, Journal and sitemap | completed — accepted after report-route fix |

## Links
- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`

## Verification evidence
- `npm test -- --run tests/growth-command-pass-b1.test.ts` — 11/11 passed.
- `npm run check -- --pretty false` — passed.
- `npm run lint` and changed-file lint — exit 0; existing repository warnings only, no lint errors.
- `npm run build` — passed.
- `git diff --check` — passed.
- Local HTTP smoke proved 200 own canonicals for `/`, `/pokemon-card-grading-uk`, `/pricing`, `/submit`, and a Journal article; `/not-a-real-mv-path` was 404 with `X-Robots-Tag: noindex, nofollow`.
- Full `npm test` result: 4,999 passed, 1,014 skipped, 1 existing Partner assertion failure, and five suites require deliberately absent local database variables. Those blockers are outside B1 and were not changed.
