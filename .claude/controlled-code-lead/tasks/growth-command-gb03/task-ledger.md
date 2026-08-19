# Task ledger — Growth Command GB-03

## Stage 0 — Baseline (2026-08-19 BST)

- Governed repository: `/Users/cornelius/mintvault-platform`.
- Source worktree deliberately untouched: `fix/canonical-card-detector-20260817` at `53e4dbd` with unrelated Scanner/Partner documents and test files untracked.
- Canonical main: `4166102d5291da0370776c2fe77317bbed00e634` (`chore(deploy): make partner network build flag explicit`).
- Production before GB-03: both `mintvaultuk.com/api/version` and `mintvault.fly.dev/api/version` reported `4166102d` at Stage 0; Fly release `v1090` was complete.
- B1 release: `7489761c`; `git merge-base --is-ancestor 7489761c 4166102d` succeeds. B1 source is therefore retained by the GB-03 base.
- GB-03 worktree/branch: `/Users/cornelius/mintvault-growth-command-gb03`, `codex/growth-command-gb03`, created clean from `origin/main` at `4166102d`.
- Protected systems: production deployment, production database/migrations, Resend transactional email, Partner operational routes. GB-03 must not touch Partner auth, tenancy, credits, Scanner, Stripe, or MVGS.
- Explicit scope: public `/partners` acquisition page, a non-operational Partner-application lead capture, attribution, internal notification, SEO, tests and handover.
- Explicit exclusions: Partner accounts/tenants/onboarding, public directory/location pages, payments/ROI claims, Scanner/stations and all protected grading/payment/auth changes.

## Stage progress

| Stage | Status | Notes |
| --- | --- | --- |
| 0 — Baseline | complete | Current main, live hosts, B1 ancestry, active worktrees and dirty source captured. |
| 1 — Review plan | complete | Three non-overlapping read-only reviews: lead storage, public route/SEO, security/privacy. |
| 2 — Investigation | complete | Reports reconciled in `issue-register.md`. |
| 3 — Lead verification | complete | Generic contact persistence, portal route collision, SSR policy and live legal flag rechecked. |
| 4 — Implementation authorisation | complete for source-only package | Exact bounded change set is in `change-manifest.md`. Production migration and publication remain owner/legal gated. |
| 5 — Implementation | complete | Public page, isolated source-only lead contract, SSR/sitemap, notification path and handover are implemented. |
| 6 — Regression | complete | Focused GB-03/B1/migration suite: 53 passed. Partner regression suite: 133 passed, 36 intentionally skipped. `npm run check`, `npm run lint` (0 errors; 2,603 baseline warnings), production build and `git diff --check` pass. Full suite reached 4,881 passing tests; five suites require unavailable test database environment variables. |
| 7 — Final report | complete — owner action required | Hostile re-review cleared repaired source defects. No production action is permitted until the public privacy notice and migration authority are supplied. |

## Review assignments

| Reviewer | Scope | Result |
| --- | --- | --- |
| `lead_capture_audit` | generic contact persistence, schema, audit and notifications | Dedicated non-Partner lead record required; no edit. |
| `partner_public_audit` | `/partners` route, portal isolation, public SEO and internal discovery | `/partners` is collision-free; no edit. |
| `security_privacy_audit` | abuse controls, attribution, email and legal surface | reusable controls found; live privacy policy is unpublished and blocks PII-capture publication. |
| `gb03_hostile_review` | migration, truthful publication state, PII leakage, activation sequencing and duplicate oracle | All actionable source defects repaired and re-reviewed; external legal/migration authority remains. |
