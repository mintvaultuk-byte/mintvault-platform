# Staging Rollout Plan (OWNER-GATED — execute ONLY after explicit approval)

Order (each step owner-gated; STOP on any surprise):
1. Push branch + open integration PR (protected: git push).
2. CI green on PR (full suite incl. DB-backed disposable-PG on the runner).
3. Founder decides CodeQL (Option A regex-harden w/ approval, or C dismissal). See codeql-decision.md.
4. Merge PR to main (protected).
5. Fetch main; confirm exact merged SHA.
6. Staging migration DRY-RUN: `MINTVAULT_DATABASE_URL=<staging> npm run db:migrate` → expect pending 0017, 0018, 0019 ONLY, 0 checksum-mismatch. STOP if anything else pending.
7. Founder approves the 3-migration apply (0017 partner-credit engine + 0018 index + 0019 catalogue).
8. Apply: `npm run db:migrate -- --apply` against staging.
9. Seed catalogue idempotently: `tsx scripts/db/seed-catalogue.ts` (onConflictDoNothing — safe to re-run).
10. Deploy staging: `scripts/safe-deploy.sh staging` (mintvault-v2).
11. Verify: `curl https://mintvault-v2.fly.dev/api/version` commit == merged main SHA; health OK.
12. Authenticated staging smoke test (20-scenario matrix). Capture evidence.
13. STOP. Do NOT deploy prod. Present staging report + prod-deploy proposal (not executed) for founder APPROVE/HOLD.
