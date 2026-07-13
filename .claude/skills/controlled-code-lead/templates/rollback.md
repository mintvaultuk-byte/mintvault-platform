<!--
Template: rollback plan. Every change manifest needs one before Stage 5 starts,
per the top-level CLAUDE.md rule: "Always create a backup plan."
-->

# Rollback — <task name>

## Trigger conditions
What observed symptom means "roll this back":
- <e.g. npm run check fails after merge>
- <e.g. /api/version doesn't match expected commit post-deploy>
- <e.g. admin dashboard fails to load cards>

## Rollback steps

### If not yet committed
- `git status` first, then `git checkout -- <files>` or `git stash` — never
  a blind `git checkout .` without checking what else is in the tree.

### If committed but not pushed
- `git reset --soft HEAD~1` (or revert the specific commit) — confirm no
  other work has landed on top first.

### If pushed / deployed
- `git revert <commit>` (never rewrite pushed history)
- Redeploy the prior known-good commit via the project's deploy path
  (`scripts/safe-deploy.sh` — see [[project_safe_deploy]] memory — never a
  raw `fly deploy` for this)

### If a migration was applied (class E)
- State whether the migration is reversible. If it is additive-only
  (`ADD COLUMN IF NOT EXISTS`), rollback of the migration itself is usually
  unnecessary — only the code reading the new column needs reverting. If it
  drops/renames anything, the reverse DDL must be written and validated
  against the live DB BEFORE the forward migration ships, not improvised
  after.

## What rollback does NOT undo
- <e.g. any cert numbers already issued, any Stripe charges already made,
  any emails already sent — call these out explicitly so the owner knows
  what a rollback can and can't fix>

## Verification after rollback
- <which command/endpoint confirms the system is back to the pre-change state>
