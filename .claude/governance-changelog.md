# Governance Changelog

**Rules for this file:** append-only. Every future governance update appends
a new entry at the bottom with all seven fields (Version, Date, Reason,
Files changed, Breaking changes, Migration required, Rollback). Never
rewrite, reorder, or delete previous entries — corrections go in a new
entry that references the old one.

---

## Version 1.0

- **Version:** 1.0
- **Date:** 2026-07-11
- **Reason:** Install a permanent governance system for all coding work in
  this repository — Lead Engineer authority model, read-only reviewer
  agents, mandatory Stage 0–7 workflow, evidence standards, issue
  classifications (A–H), protected-actions approval gates, drift
  prevention, and Definition of Done.
- **Files changed:**
  - Created: `.claude/skills/controlled-code-lead/SKILL.md`
  - Created: `.claude/skills/controlled-code-lead/templates/` (reviewer-report,
    change-manifest, rollout, rollback, issue-register, task-ledger,
    deployment-state, protected-systems)
  - Created: `.claude/controlled-code-lead/protected-systems.md` (live copy)
  - Created: `.claude/agents/controlled-reviewer.md`
  - Created: `.claude/hooks/protected-action-guard.sh` (advisory)
  - Created: `.claude/settings.json` (PreToolUse hook wiring)
  - Modified (append-only): `CLAUDE.md` (governance section)
- **Breaking changes:** none — restates existing CLAUDE.md golden rules in
  workflow terms; does not loosen or replace them.
- **Migration required:** none.
- **Rollback:** delete the files listed above and remove the appended
  CLAUDE.md section. `.claude/settings.local.json` was never touched, so
  owner pre-approvals are unaffected by rollback.

---

## Version 1.1

- **Version:** 1.1
- **Date:** 2026-07-11
- **Reason:** Evolve governance additively — versioning + changelog,
  self-test suite, permanent project memory, session recovery protocol,
  Definition of Proof, architecture snapshots, implementation budgets,
  confidence scoring, specialist reviewer library, hook upgrade roadmap
  (documented only, no behaviour change), governance health report.
- **Files changed:**
  - Created: `.claude/governance-version.md`
  - Created: `.claude/governance-changelog.md` (this file)
  - Created: `.claude/governance-tests/` (run-all.sh, test-reviewer-readonly.sh,
    test-hook-detection.sh, test-state-persistence.sh, test-governance-files.sh)
  - Created: `.claude/project-memory.md`
  - Created: `.claude/skills/controlled-code-lead/templates/definition-of-proof.md`
  - Created: `.claude/skills/controlled-code-lead/templates/architecture-before.md`
  - Created: `.claude/skills/controlled-code-lead/templates/architecture-after.md`
  - Created: `.claude/skills/controlled-code-lead/templates/implementation-budget.md`
  - Created: `.claude/skills/controlled-code-lead/templates/confidence-scoring.md`
  - Created: `.claude/skills/controlled-code-lead/templates/governance-health-report.md`
  - Created: `.claude/agents/frontend-reviewer.md`, `backend-reviewer.md`,
    `database-reviewer.md`, `security-reviewer.md`, `storage-reviewer.md`,
    `infrastructure-reviewer.md`, `deployment-reviewer.md`,
    `provider-reviewer.md`, `performance-reviewer.md`, `ui-reviewer.md`
  - Created: `.claude/hooks/HOOK-UPGRADE-ROADMAP.md`
  - Created: `.claude/controlled-code-lead/governance-health-2026-07-11.md`
  - Modified (append-only): `.claude/skills/controlled-code-lead/SKILL.md`
    ("Version 1.1 extensions" section)
  - Modified (append-only): `CLAUDE.md` (v1.1 note inside the governance section)
  - Modified (additive detection only): `.claude/hooks/protected-action-guard.sh` —
    detection patterns added during the v1.1 self-test build and the
    post-build adversarial audit: env-file mutation in either token order
    (`sed -i`/`perl -pi`/redirect/`tee`), flagged-command forms
    (`git -C <path> push`, `fly -a <app> deploy|secrets`), runner-agnostic
    `db:push`, `DROP database/schema/view/sequence/role`, `aws s3 rb`,
    `s3api delete*`, `rclone purge/deletefile`, `curl -X DELETE`. Every
    v1.0 pattern retained; detects strictly more than v1.0; advisory
    contract (always exit 0, warning banner only) unchanged.
  - Post-audit hardening of the self-tests (same release): reviewer test
    upgraded from a forbidden-tool blocklist to a strict read-only
    ALLOWLIST (only Read, Bash, Grep, Glob, WebFetch, WebSearch,
    TaskOutput), now globs every agent file instead of a hardcoded list,
    fails on unregistered non-reviewer agents, and rejects uninspectable
    YAML block-list tool grants. Verified to catch `Edit(path)` permission
    specifiers, MCP write tools, and `Task`-based agent spawning.
- **Breaking changes:** none. All v1.0 behaviour preserved; hook remains
  advisory; `controlled-reviewer` unchanged; no protection weakened.
- **Migration required:** none for existing work. New tasks additionally
  produce a Definition of Proof, an implementation budget (before Stage 5),
  confidence scores (Stage 7), and architecture snapshots for
  infra/provider/storage/deployment/database work.
- **Rollback:** delete the files created above and remove the two appended
  sections (SKILL.md "Version 1.1 extensions"; CLAUDE.md v1.1 note). This
  restores exact v1.0 behaviour — v1.0 files were not edited otherwise.

---

## Version 1.2

- **Version:** 1.2
- **Date:** 2026-08-10
- **Reason:** Install the owner-provided Graph of Loops Build Controller as
  permanent governance alongside the existing No-Bullshit Completion
  Controller. It prevents a single implementation, test, review, or metric
  loop from certifying a false green, while the existing controller preserves
  the release stop condition once independent proof is complete.
- **Files changed:**
  - Created: `docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md` (single canonical
    Graph controller).
  - Modified: `AGENTS.md` and `CLAUDE.md` (mandatory canonical-load references
    to both controllers).
  - Modified: `.claude/governance-tests/test-governance-files.sh` (requires
    both canonical files and both entry-point references; supports a temporary
    isolated root for adversarial mutation proof).
  - Modified: `.claude/governance-version.md` and this append-only changelog.
- **Breaking changes:** none. The installation is additive and leaves all
  Golden Rules, protected grading authority, security/payment protections,
  deployment gates, and the No-Bullshit controller intact.
- **Migration required:** none. Future substantial engineering tasks read both
  canonical controllers before work.
- **Rollback:** locally revert the installation commit. This removes only the
  Graph-controller document, its root references, the associated integrity
  checks, and this Version 1.2 record; it does not affect runtime code,
  database state, secrets, payments, grading, or deployments.
