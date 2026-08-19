# Task ledger — Public Partner Network + Google Partner Presence

## Stage 0 — Baseline (recorded 2026-08-19)

- Branch: `codex/public-partner-google-overnight-20260819`
- Commit: `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
- `git status`: clean isolated worktree
- Production commit: `facfd36f` via `https://mintvault.fly.dev/api/version`; final reconciliation found Fly release v1110 with two started machines and passing HTTP checks
- Production schema: journal through `0100_growth_commercial_attribution.sql`; Partner location migration `0084` applied
- Production flags: `partner_login_enabled`, `partner_onboarding_enabled`, `partner_portal_enabled` globally enabled; no public-directory or Google-presence rows
- Google prerequisites: no Google client ID, client secret, OAuth encryption key, or proved GBP API approval/quota in production secrets
- Protected systems in play: production data (read-only evidence only), additive migration package, external Google provider, SEO/public serving, Partner tenant/RBAC boundaries
- Explicit scope: public-safe Partner directory/profile; publication authority; Partner/Super Admin operator wiring; SEO; isolated Google code/test/schema foundation; evidence and rollback
- Explicit prohibited actions: push, merge, deploy, production/staging writes, migration application, secret mutation, live Google OAuth, dependency installation, grading/QA/payment/card/station/credit authority changes

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-19 | Source, production, migration, flags and external prerequisite evidence captured |
| 1 — Review plan | done | 2026-08-19 | Three read-only specialists assigned; hostile reviewer reserved |
| 2 — Investigation | done | 2026-08-19 | Source/authority, security/privacy, UX/SEO reports received |
| 3 — Lead verification | done | 2026-08-19 | Findings reproduced in source; flag/public-ref no-migration public strategy accepted |
| 4 — Implementation authorisation | done | 2026-08-19 | Manifest and protected boundaries recorded |
| 5 — Implementation | done | 2026-08-19 | Sole lead writer; exact 57-file candidate re-manifested at Stage 6 |
| 6 — Regression | done | 2026-08-19 | Typecheck/build/targeted lint/SQL lint; 316 runnable files and 5,168 tests pass; real HTTP/PG/browser/perf/rollback |
| 7 — Final report | done | 2026-08-19 | Public code complete; Google live pilot and all deployment/activation remain external/protected |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| Agent A — source/authority | data model, Graphify, routes, stats, slug/publication | read-only final received 2026-08-19 |
| Agent B — security/privacy | public DTO, tenant boundary, OAuth/token/log safety | read-only final received 2026-08-19 |
| Agent C — UX/SEO/accessibility | discovery, SSR/sitemap, mobile, Maps, dead ends | read-only final received 2026-08-19 |
| Agent D — hostile/release | post-package break/fix and final release verdict | final targeted result: 0 BLOCKER / 0 HIGH |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Campaign ledger: `docs/partner/PUBLIC_PARTNER_NETWORK_GOOGLE_PRESENCE_OVERNIGHT_EXECUTION.md`
