# Governance Version

| Field | Value |
|---|---|
| **Governance Version** | 1.1 |
| **Release Date** | 2026-07-11 |
| **Author** | Claude (Lead session), commissioned and approved by Cornelius Oliver (owner) |

## Summary

Version 1.1 extends the `controlled-code-lead` governance system installed as
Version 1.0 on 2026-07-11. All changes are **additive** — no v1.0 skill,
agent, template, hook, or instruction was removed, rewritten, or weakened.
The advisory protected-action hook remains advisory (see
`.claude/hooks/HOOK-UPGRADE-ROADMAP.md` for the documented-but-not-enabled
blocking design).

## Major changes (1.0 → 1.1)

1. **Governance versioning** — this file; future governance changes bump the
   version here and append to `.claude/governance-changelog.md`.
2. **Governance changelog** — append-only history at `.claude/governance-changelog.md`.
3. **Self-test suite** — `.claude/governance-tests/` validates reviewer
   read-only guarantees, hook detection patterns, state persistence, and
   governance file integrity. Run: `bash .claude/governance-tests/run-all.sh`.
4. **Permanent project memory** — `.claude/project-memory.md`, required
   reading at the start of every coding session.
5. **Session recovery protocol** — mandatory session-start reads and
   restatement, defined in SKILL.md "Version 1.1 extensions".
6. **Definition of Proof** — `templates/definition-of-proof.md`; five
   verification levels; "fixed" requires Integration Proof or higher.
7. **Architecture snapshots** — `templates/architecture-before.md` /
   `templates/architecture-after.md`; mandatory for infrastructure, provider,
   storage, deployment, and database work.
8. **Implementation budget** — `templates/implementation-budget.md`;
   estimate before Stage 5; stop and explain at ~25% overrun.
9. **Confidence scoring** — every Stage 7 report ends with four scored
   confidences; `templates/confidence-scoring.md`.
10. **Specialist reviewer library** — ten read-only specialist agents
    alongside the unchanged `controlled-reviewer`.
11. **Hook upgrade roadmap** — blocking mode, dev/production governance
    modes, and approval tokens documented (NOT enabled) in
    `.claude/hooks/HOOK-UPGRADE-ROADMAP.md`.
12. **Governance health report** — `templates/governance-health-report.md`.

## Compatibility notes

- Fully backward compatible with Version 1.0. Every v1.0 file is preserved
  byte-for-byte except append-only extensions to
  `.claude/skills/controlled-code-lead/SKILL.md` and `CLAUDE.md`.
- The Stage 0–7 workflow, Lead/reviewer authority split, issue
  classifications (A–H), evidence standards, protected-actions list, and
  Definition of Done are unchanged; v1.1 adds requirements on top of them,
  never relaxes one.
- `controlled-reviewer` is unchanged; specialist reviewers are additions,
  not replacements. The Lead chooses which reviewers a task needs.
- `.claude/settings.json` (hook wiring) and `.claude/settings.local.json`
  (owner pre-approvals) are untouched by v1.1.
- Nothing in v1.1 changes any runtime application code, database, or
  deployment — governance files only.
