# Rollout — Partner queue evidence and shop-floor workflow

**Classification:** B/C.

## Pre-rollout checklist

- [ ] Evidence, queue and navigation regression gates pass.
- [ ] Full Vitest suite, TypeScript, lint and production build pass.
- [ ] Current main and live staging are reconciled again.
- [ ] A staging deployment has explicit owner approval.

## Steps

1. Reconcile the candidate with then-current `origin/main`; do not force deploy a divergent branch.
2. Deploy staging only through `scripts/safe-deploy.sh staging` after explicit owner instruction.
3. Verify the live SHA and served bundle marker.
4. Use an authenticated staging Partner session to inspect queue statuses/thumbnails and open a valid card's FRONT and BACK.

## Who is affected

- Staging Partner users only until the owner separately authorises production.
