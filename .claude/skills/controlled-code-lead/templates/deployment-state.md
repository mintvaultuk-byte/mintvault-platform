<!--
Template: deployment state. Snapshot of what's actually live vs what's in
flight — the concrete artifact [[mintvault-concurrent-session-discipline]]
asks you to reconcile against before any dispatch or deploy.
-->

# Deployment state — <task name / date>

## Production
- Live commit: `<sha>` (confirmed via `<method — /api/version, fly releases>`)
- Live Fly release: `<vNNN>`
- DB host in use: `ep-wispy-morning-ab6f4o08` (prod) — confirm, don't assume

## Staging
- Local `.env` DB host: `ep-purple-voice-abfez796` — confirm, don't assume
- Last schema push: `<date, what changed>`

## This task's branch
- Branch: `<name>`
- Ahead of main by: `<N commits>`
- Pushed: `<yes/no>`
- Deployed anywhere: `<no / staging / production>`

## Known divergence between environments
- <e.g. "VQ tables exist on branch, not on main" — call out anything that
  means "works locally" doesn't mean "works where the owner thinks it does">

## Other in-flight sessions (if known)
- <branch/session, what it's touching, whether it overlaps this task's scope>
