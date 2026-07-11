# Change manifest — governance-phase-9 (Phase 9A only)

**Date:** 2026-07-11 · **Branch/commit at write:** `governance-phase-9` @ `6439350`
**Governance snapshot at write:** `0e91bb652dae00a7b6f0f96f0aed29149672b49374e0364fea11062cc299836d`
**Owner-authorised scope:** the Phase-9 prompt authorises local (unpushed) governance commits for 9A. No protected action taken.

## Findings addressed this manifest (9A)
G1 (git-track), G2 (test/lint), G8 (durable state), G9 (session recovery), G10/G11 (source of truth), G16/G17 (authority), plus G15-partial (CLAUDE.md test claim).

## Files to change (9A)
| File | Change | Ties to |
|---|---|---|
| `.claude/controlled-code-lead/tasks/governance-phase-9/*` | NEW durable task dir (8 files) | G8 |
| `CLAUDE.md` | commit the pending governance section; correct "no test/lint scripts" line | G1, G2, G15 |
| `.claude/skills/controlled-code-lead/SKILL.md` | test/lint gates in Stage 6 + DoD; authority model (Lead vs owner + standing-grant); Session Recovery section; durable-transition rule; proof-state vocabulary | G2,G9,G16,G17,G6-vocab |
| `git add` the whole framework | version-control 41 untracked governance files (NOT settings.local.json) | G1 |
| remove `.agents/skills/` + `AGENTS.md` | unused divergent duplicate (untracked) | G10 |

## Files explicitly NOT touched
- `.claude/settings.local.json` (secrets; stays gitignored — 9B handles rule remediation, no rotation).
- The hook `.sh` behaviour (9B rewrites it after restart).
- Any app / grading / cert / payment / auth / submission code.

## Protected actions required
- [x] None this session. (push/deploy/migrate/rotate all DEFERRED and owner-gated.)

## Order of operations (one logical change at a time)
1. Create durable task dir (done). 2. Edit CLAUDE.md (test claim). 3. Edit SKILL.md (5 sub-edits). 4. Remove `.agents/` + `AGENTS.md`. 5. Verify `.gitignore` protects settings.local.json. 6. `git add` framework. 7. Regression gates. 8. One local commit "Phase 9A …". 9. STOP at restart checkpoint.

## Regression gates required (9A)
- [ ] `npm run check` (tsc) — governance edits are markdown/scripts, should not affect tsc
- [ ] `npm run test` (vitest) — must stay 427/427 (no app code touched)
- [ ] git diff review — only governance files + CLAUDE.md; no app/business-logic files
- [ ] changed-file allowlist — no grading/cert/payment/auth/submission path
- [ ] secret scan — no secret enters git; settings.local.json stays untracked

**Approved to proceed:** owner authorised local governance commits in the Phase-9 prompt — no protected action in this manifest.
