# Reviewer status — governance-phase-9

## Determination at Stage 0 (2026-07-11)
Per the Phase-9 rule: do NOT launch a governance reviewer, and do NOT trust reviewer
isolation, until it is proven in a FRESH Claude Code process after restart.

- **Observed this session (via harness notifications):** `controlled-reviewer` became
  spawnable mid-session; then 10 specialist read-only reviewers (`backend/database/
  deployment/frontend/infrastructure/performance/provider/security/storage/ui-reviewer`)
  became available, each declaring `tools: Read, Bash, Grep, Glob, WebFetch, WebSearch,
  TaskOutput` (no Edit/Write/NotebookEdit).
- **Why this is NOT trusted:** all of these registered MID-SESSION. The governance audit
  proved that mid-session agent registration is exactly the unreliable path (at the audit's
  start `controlled-reviewer` was "agent type not found" and the fan-out fell back to a
  full-access `general-purpose` agent). A tool-allowlist declared in frontmatter is only a
  real boundary if the harness loaded it at process start AND enforces it.
- **9A did NOT spawn any reviewer.** 9A is Lead-only work (inventory, git, doc corrections,
  authority model). No reviewer was needed, so none was used — avoiding the
  silent-fallback-to-unrestricted-agent failure entirely.

## Required BEFORE 9B (post-restart, in a clean process)
Prove, with harmless negative-control tests, that a spawned `controlled-reviewer`:
- has NO Edit / Write / NotebookEdit (attempt → tool absent);
- cannot run mutating Bash (git commit/push, db mutation, deploy) — refuses or is denied;
- cannot spawn an unrestricted sub-agent;
- cannot deploy / push / migrate / rotate secrets / mutate storage / call paid providers.
If ANY of these is not provable → STOP; do not substitute an unrestricted agent.

## Status
- 9A: reviewer isolation UNPROVEN (not required for 9A). BLOCKS 9B until proven post-restart.
