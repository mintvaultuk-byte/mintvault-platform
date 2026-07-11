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

## 9B.1 PROOF (resumed session)
Spawned a `controlled-reviewer` and ran harmless negative controls:
- **Self-reported toolset:** Read, Bash, WebFetch, WebSearch. Edit / Write / NotebookEdit /
  Agent(Task-spawn) = ABSENT.
- **Frontmatter allowlist (committed def):** `Read, Bash, Grep, Glob, WebFetch, WebSearch,
  TaskOutput` — precise word-match confirms Edit/Write/NotebookEdit/Agent all ABSENT.
- **Objective Write probe (Lead-verified on disk):** reviewer instructed to Write a probe
  file → the probe file was NEVER created (`reviewer-isolation-probe.txt` absent) → the
  reviewer has no Write capability. Not the agent's word — the filesystem's.
- **Sub-agent:** no Agent tool → cannot fan out to an unrestricted agent.
- **HONEST caveat (soft edge):** the reviewer HAS Bash, a general shell that could in
  principle run a mutating command (git commit/push, deploy, db). Its read-only-ness is
  enforced by the reviewer's own hard-constraint prompt + approval-gating (a background
  reviewer auto-denies approval-gated actions), NOT by an intrinsic Bash sandbox. This is a
  known limitation; 9B.4 (hook) + 9B.3 (deny/ask) are its mitigations.

## Verdict
- Reviewer isolation for the HARD mutation classes (Edit/Write/NotebookEdit, sub-agent spawn)
  is PROVEN. The reviewer is demonstrably more restricted than `general-purpose`. 9B may
  proceed. No silent substitution occurred.
- Bash-mediated mutation remains a policy/approval control, not a tool sandbox — documented,
  not hidden.
