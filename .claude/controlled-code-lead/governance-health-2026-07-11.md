# Governance health report — 2026-07-11

Produced for the v1.0 → v1.1 governance version bump, from live inspection
(self-test run + file enumeration), per
`templates/governance-health-report.md`.

## Governance version
- Version: **1.1** (`.claude/governance-version.md`, released 2026-07-11)
- Changelog entries: 2 (1.0 and 1.1, both 2026-07-11) — append-only intact

## Active protections
- CLAUDE.md golden rules 1–10 (unchanged) and the SKILL.md "Protected
  actions" list agree: git push, deploy, migrations, secret/env changes,
  DNS, production writes, destructive staging writes, paid provider calls,
  storage deletion, destructive SQL — all owner-approval-gated, every time.
- Lead/reviewer authority split: only the Lead session may edit, commit,
  or approve; reviewers are evidence-only.
- Stage 0–7 workflow, A–H classifications, evidence standards, drift
  prevention, Definition of Done (v1.0) + Definition of Proof, budgets,
  confidence scoring, architecture snapshots, session recovery (v1.1).

## Active hooks
| Hook | Wired via | Mode | Verified how |
|---|---|---|---|
| protected-action-guard.sh | `.claude/settings.json` PreToolUse (Bash) | **advisory** (always exit 0) | self-test: 28 detection + 6 silence + advisory-contract assertions, all passing |

## Active reviewer agents
| Agent | Read-only confirmed how |
|---|---|
| controlled-reviewer (v1.0, unchanged) | allowlist self-test (tools = Read, Bash, Grep, Glob, WebFetch, WebSearch, TaskOutput only) |
| frontend-, backend-, database-, security-, storage-, infrastructure-, deployment-, provider-, performance-, ui-reviewer (v1.1) | same allowlist self-test; negative-tested — a planted agent with `Edit(path)`, an MCP write tool, or `Task` fails the suite |

## Governance files
- [x] governance-version.md present; version matches changelog head (1.1)
- [x] governance-changelog.md present, append-only intact, 7-field entries
- [x] project-memory.md present (created today, all 11 sections populated)
- [x] SKILL.md + all 14 templates present (8 v1.0 + 6 v1.1)
- [x] live protected-systems.md present (8 protected systems)
- [x] governance-tests/ present (runner + 4 suites)
- [x] HOOK-UPGRADE-ROADMAP.md present (documentation only, nothing enabled)

## Self-test status
- Run: `bash .claude/governance-tests/run-all.sh` (2026-07-11, post-audit)
- Result: **4 suite(s) passed, 0 failed**; runner exit 0; `.tmp` cleaned up
- Failures: none

## Missing components
- None against the v1.1 specification. (This report itself was the last
  gap found by the adversarial audit; closed by this file.)

## Outstanding governance improvements
1. **Governance files are untracked in git** — durability and the roadmap's
   git-based rollback depend on committing `.claude/` governance files.
   Owner-gated like any commit; recommended next time work is committed.
2. **Hook blocking mode** — designed but not enabled
   (`.claude/hooks/HOOK-UPGRADE-ROADMAP.md`); requires owner approval and a
   version bump. Known advisory-matcher limitations (keyword false
   positives on read-only scans, quote-obfuscation evasion, semantic SQL
   gaps) are documented there and must be solved before blocking ships.
3. **Body-ban greps are documentation-presence checks** — the binding
   reviewer enforcement is the tools allowlist; the prose greps only verify
   the bans are documented. Acceptable by design; noted for honesty.
4. **run-all.sh has no per-suite timeout** — a hung test would hang the
   runner. Low priority; revisit if a suite ever grows a long-running check.
