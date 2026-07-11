<!--
Template: rollout plan. Part of Stage 4/7 — how this change actually goes live.
-->

# Rollout — <task name>

**Classification:** A / B / C / D / E / F / G / H

## Pre-rollout checklist
- [ ] All Stage 6 regression gates passed
- [ ] Change manifest fully implemented (no partial edits)
- [ ] For class C: staging verification completed and evidenced below
- [ ] For class E: migration validated against live target DB columns
  (see [[mintvault-db-migration-discipline]])
- [ ] For class D/F/G: owner approval captured in the change manifest

## Steps
1. <e.g. merge branch X into main>
2. <e.g. npx drizzle-kit push --config drizzle-vq.config.ts, staging first>
3. <e.g. fly deploy — PROTECTED, owner must say "deploy"/"push to production">
4. <post-deploy smoke check — which endpoint/page to hit and expected result>

## Staging verification evidence (class C+ only)
- <what was checked on staging, actual output/screenshot reference>

## Who/what is affected
- <customers, admin users, other in-flight branches>

## Timing constraints
- <e.g. avoid during an active submission, avoid a merge freeze window>
