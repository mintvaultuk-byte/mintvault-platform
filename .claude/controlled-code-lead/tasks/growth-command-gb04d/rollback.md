# Rollback — GB-04D Growth Command

## Baseline containment

- Do not deploy until staging, exact-SHA CI and hostile-review gates pass.
- If a dashboard-only incident occurs after activation, use the narrowest existing feature/route containment available and preserve payment, grading, Partner and Scanner behavior.
- The pre-change production artifact is Fly v1112, source `ee7fbe43`, image `registry.fly.io/mintvault:deployment-01M0EW6KY7JGV6M851K600EY37` (reconfirm exact registry identity before rollout).
- Application rollback must use the repository's reviewed safe release path or an exact-image procedure validated in staging; never reset/rewrite shared Git history.

## Trigger conditions

- Super Admin authorization regression or provider-secret exposure.
- Growth endpoint causes material production load, checkout/payment impact, or cross-tenant data exposure.
- False-green health/capacity state from missing/stale authority.
- Broken Growth controls or mobile/desktop loss of access.
- Served `/api/version` or bundle identity does not match the exact candidate.

## Verification after rollback

- Both Fly machines started with passing checks.
- `/api/version` equals `ee7fbe43` (or the then-current captured pre-release SHA).
- Public revenue path, authenticated Growth, Partner and Scanner smoke checks return their expected real outcomes.
- No migration/data rollback is expected unless Stage 4 explicitly changes this plan with separate owner approval.
