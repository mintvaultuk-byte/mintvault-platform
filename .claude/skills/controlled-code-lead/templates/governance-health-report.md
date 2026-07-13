<!--
Template: Governance health report (governance v1.1).
Produce one whenever the owner asks "is governance healthy?", after any
governance version bump, and periodically at the Lead's judgement. Fill it
from live inspection (run the self-tests, list the actual files), never from
memory. Keep dated copies under .claude/controlled-code-lead/.
-->

# Governance health report — <YYYY-MM-DD>

## Governance version
- Version: <from .claude/governance-version.md>
- Changelog entries: <count, latest version/date from .claude/governance-changelog.md>

## Active protections
- <enumerate from SKILL.md "Protected actions" + CLAUDE.md golden rules —
  confirm the lists still agree with each other>

## Active hooks
| Hook | Wired via | Mode | Verified how |
|---|---|---|---|
| protected-action-guard.sh | .claude/settings.json PreToolUse (Bash) | advisory | <ran self-test / manual probe> |

## Active reviewer agents
| Agent | Read-only confirmed how |
|---|---|
| controlled-reviewer | <self-test: tools frontmatter check> |
| <specialists present> | |

## Governance files
- [ ] governance-version.md present, version matches changelog head
- [ ] governance-changelog.md present, append-only intact
- [ ] project-memory.md present, updated within <N> days
- [ ] SKILL.md + all templates present
- [ ] live protected-systems.md present
- [ ] governance-tests/ present

## Self-test status
- Run: `bash .claude/governance-tests/run-all.sh`
- Result: <N passed / N failed — paste the summary line>
- Failures: <none / listed with cause>

## Missing components
- <anything the current governance version says should exist but doesn't>

## Outstanding governance improvements
- <e.g. hook blocking mode (see .claude/hooks/HOOK-UPGRADE-ROADMAP.md),
  items deferred in past changelog entries>
