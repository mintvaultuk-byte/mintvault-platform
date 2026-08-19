# Deployment state — Growth Command GB-03

- Stage-0 production SHA: `4166102d`.
- Candidate: release worktree `codex/growth-command-gb03-release`, final release commit captured immediately before deployment; it is based on `origin/main` `4166102d` and retains B1 (`7489761c`) by ancestry.
- Deployment authority: B2-R authorises the controlled additive migration, reviewed Privacy Notice, `PRIVACY_NOTICE_LIVE` and `PARTNER_APPLICATIONS_LIVE` only after all release gates and hostile review pass. The two flags default false and share one exact SSR/API gate.
- No deploy, migration, production lead or notification has been attempted. Production remains at `4166102d`.
