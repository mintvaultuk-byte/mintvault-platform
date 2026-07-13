# Rollback — governance-phase-9 (Phase 9A)

## What this phase changed (reversible; local only, not pushed)
- One local commit on branch `governance-phase-9` adding the governance framework to git + editing CLAUDE.md/SKILL.md.
- Removed untracked `.agents/skills/` + `AGENTS.md` (unused divergent duplicate).

## Trigger conditions
- `npm run check` or `npm run test` regresses after the edits.
- Governance snapshot drift detected (unexpected change to the lock set).
- Any app/business-logic file appears in the diff.

## Rollback steps
### If committed but not pushed (the expected state)
- `git revert <9A-commit>` (keeps history) OR, since it is local-only and the branch is dedicated:
  `git reset --hard 6439350` on `governance-phase-9` (returns the branch to the pre-9A tip).
- The framework files then return to UNTRACKED working-tree state (no loss — they existed untracked before).
### To restore the removed duplicate (if ever needed)
- `.agents/skills/` + `AGENTS.md` were untracked and are NOT recoverable from git. They are a proven-unused Codex fork; if needed, regenerate from `.claude/skills/` (the authoritative source). This is deliberate — single source of truth.
### settings.local.json
- Never touched by 9A; remains gitignored. No rollback needed.

## What rollback does NOT undo
- Nothing external — no push, no deploy, no migration, no secret change occurred. Rollback is fully local.

## Verification after rollback
- `git status` clean on `governance-phase-9`; `npm run check` + `npm run test` green; `main` and `vq-phase8-staging-integration` untouched.
