# Correction: the four non-admin grading routes ARE already bounded

**Status:** corrects a false claim in commit `a89acba3` on this branch.
**Date:** 2026-08-16.

## What `a89acba3` claimed

> "The four non-admin routes (staff.tsx, grader.tsx, admin-staff.tsx, partner/grading.tsx)
> never give the canonical shell a BOUNDED parent: they supply min-h-screen ancestors."

**That is wrong.** It was reached by grepping for `h-[calc(100dvh-4.5rem)]`, finding zero
matches outside `admin-dashboard.tsx`, and concluding no bound existed.

## What is actually true

Each of those routes early-returns into a `fixed inset-0` overlay before the page's
`min-h-screen` root is reached (`staff.tsx:425`, `grader.tsx:87`; the other two render the
overlay as a sibling). The workstation's real container is:

| route | container |
| --- | --- |
| staff.tsx:432 | `fixed inset-0 z-40 flex flex-col …` |
| grader.tsx:92 | `fixed inset-0 z-40 flex flex-col …` |
| admin-staff.tsx:1204 | `admin-root fixed inset-0 z-50 flex flex-col …` |
| partner/grading.tsx:197 | `fixed inset-0 z-50 flex flex-col …` |

A `position:fixed` box with `inset-0` and `height:auto` is over-constrained, so CSS resolves
its height to the initial containing block — the viewport. That height is **definite**, and
each box is already `flex flex-col`. The chain below it (`GradingWorkstation` root `flex-1`
→ shell `h-full` → row `flex-1` → aside → `CardPreviewPanel` `h-full min-h-0`) is unbroken.

`tests/canonical-grading-workstation-architecture.test.ts:122` states the contract directly:
*"/admin is the ONLY surface that is not a `fixed inset-0` overlay, so it must supply the
bound explicitly."* Test BB3 additionally asserts each active grading view provides one
bounded flex-column context.

## Why adding the wrapper would have been a REGRESSION

`md:h-[calc(100dvh-4.5rem)]` replaces "fill the exact remaining space" with "be exactly
100dvh − 72px, whatever the real chrome is". The real chrome above the mount is:

| route | chrome above mount | with conditional banners |
| --- | --- | --- |
| staff | 24px (1.5rem) | 74px with the redo banner |
| grader | 41px (2.56rem) | 91px with the redo banner |
| admin-staff | 85px static | up to ~331px (msg/err/QA strip/reject panel) |
| partner/grading | 33px (2.06rem) | constant |

None is 72px. Inside a `fixed inset-0` box there is no document growth, so an offset that is
too large leaves a dead band and one that is too small overflows **with no scroll owner** —
exactly the "black bar at the bottom" class the shell comment says was removed on purpose
(`CanonicalGradingWorkstationShell.tsx:36-41`).

`admin-staff.tsx:1315` already has the dedicated `flex min-h-0 flex-1 flex-col` slot; a second
bound there would conflict (`flex-basis:0%` replaces a height).

Note the `4.5rem` on `/admin` is itself empirical, not derived — the box model there computes
to ~53px. It is safe on `/admin` only because that parent chain is `min-h-*` with `height:auto`
and no clipping. **It is not transferable.**

## Consequence for the owner's cropping report

The root cause of the reported `/staff` crop is **NOT** a missing route bound and remains
**unidentified**. Do not re-apply the wrapper. The next place to look is the left rail's
internal sizing under a real authenticated route at 1280×800 and 1024×768 — measure
`[data-testid="grading-workspace"]`, `grading-preview-panel` and
`grading-interactive-card-host` — not the dev harness, which self-bounds with `h-screen`.

## Trap worth knowing

The architecture guards are `toContain`/`toMatch` string assertions. They prove the four
routes *have* the `fixed inset-0` container; **none of them would have caught a second,
conflicting bound added underneath it.** The suite would have gone green on the regression.
