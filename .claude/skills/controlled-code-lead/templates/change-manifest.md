<!--
Template: change manifest.
Written by the Lead at end of Stage 3 / start of Stage 4, BEFORE any edit is
made. For protected-action classes (see SKILL.md), this must be shown to the
owner and approved before Stage 5 begins.
-->

# Change manifest — <task name>

**Date:** <YYYY-MM-DD>
**Lead session:** <branch/commit at time of writing>

## Findings this manifest addresses
- F1 — <one-line summary> — classification <A-H>
- F2 — ...

## Findings explicitly deferred (not in this manifest)
- F3 — <one-line summary> — why deferred, what unblocks it

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `path/to/file.ts` | <what changes, one line> | <ties back to finding ID> | A |

## Files explicitly NOT touched (but might look related)
- `path/to/file.ts` — <why it's out of scope this pass>

## Protected actions required
- [ ] None
- [ ] <action> — owner approval obtained: <yes/no, date>

## Order of operations
1. <logical fix 1, one at a time per Stage 5>
2. <logical fix 2>

## Regression gates required (Stage 6)
- [ ] `npm run check`
- [ ] `npm run dev` boots
- [ ] <subsystem-specific gate>

---
**Approved to proceed to Stage 5:** <owner name / "not required — no protected action"> — <date>
