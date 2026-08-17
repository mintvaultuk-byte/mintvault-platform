/**
 * The Super Admin focus-surface height contract — the ONE place the /admin
 * grading route's outer geometry is expressed.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 * The workstation box used to be bounded with `md:h-[calc(100dvh-4.5rem)]`:
 * a GUESS that exactly 4.5rem (72px) of chrome sat above it (compact
 * AdminHeaderRow + container padding). Runtime reproduction measured the real
 * chrome at ~47px, so the box was ~25px shorter than the space it was given.
 * That difference is unreachable, application-owned, and paints as the black
 * band the owner reported below the workstation.
 *
 * No constant can be correct here. The header is a shared primitive whose
 * height depends on its own content (breadcrumb text, how many action buttons
 * a role renders, whether it wraps at a narrow desktop width) and on the font
 * metrics of whatever is inside it. Any number hard-coded in this file is
 * right for exactly one combination and silently wrong for the rest. So the
 * subtraction is not re-tuned — it is DELETED, and the relationship is
 * expressed the way CSS already knows how to express it:
 *
 *   surface     = a definite-height flex column (desktop only)
 *   header      = shrink-0            → takes exactly the height it needs
 *   workstation = flex-1 + min-h-0    → takes exactly what is left, whatever
 *                                       that turns out to be
 *
 * The browser measures the header. We never do. There is nothing left to guess
 * and nothing to keep in sync when the header's content changes.
 *
 * ── Why every part of the desktop chain is load-bearing ─────────────────────
 * `flex-1` on the workstation only works if its PARENT has a definite height.
 * `flex-1` is `flex: 1 1 0%`, and on a flex item `flex-basis` replaces `height`
 * for main-axis sizing — so a `flex-1` item resolves against its parent, and if
 * that parent's height is AUTO it grows to content instead. The surface used to
 * be exactly that: `min-h-[100dvh]` with height auto. That is why the previous
 * repair documented "NO flex-1" as load-bearing and used a fixed height on the
 * child instead — with an auto-height parent, `flex-1` really did inflate the
 * page to 2568px and push the Live Certificate Preview below the fold.
 *
 * That warning was conditional on the auto-height parent, not on `flex-1`
 * itself. `md:h-[100dvh]` on the surface removes the condition: the parent is
 * now definite, so `flex-1` resolves to the remaining space rather than to
 * content. Both halves must land together — `md:flex-1` without `md:h-[100dvh]`
 * reintroduces the exact PR #234 / 2568px regression.
 *
 * ── Why this is breakpoint-scoped (PR #234) ─────────────────────────────────
 * PR #234 was rolled back from production the same day because a layout repair
 * made the viewport bound UNCONDITIONAL, which bounded small screens too and
 * trapped their scrolling. The documented fallback is preserved here and pinned
 * by tests: below `md` the surface keeps `min-h-[100dvh]` with height auto and
 * the workstation keeps height auto, so the page flows and scrolls normally.
 * Every desktop-only token below is `md:`-prefixed for that reason.
 *
 * These are exported as constants (not inlined) so the /admin route and the
 * dev geometry harness that measures it cannot drift apart: the harness proves
 * the same strings the route ships.
 */

/**
 * The focus surface: a normal scrollable block below `md`, and a definite
 * 100dvh flex column at `md` and above.
 *
 * `md:min-h-0` is not decoration — it retires the mobile `min-h-[100dvh]` so
 * the desktop height is the single authority. Leaving both live would make a
 * later change to either one silently unable to shrink the surface.
 *
 * `p-2.5` sits inside the 100dvh because Tailwind's preflight sets
 * `box-sizing: border-box` globally, so the padding is contained by the height
 * rather than added to it. The surface is therefore exactly one viewport tall
 * and the document never gains a scrollbar from it.
 */
export const ADMIN_FOCUS_SURFACE_CLASS = "flex min-h-[100dvh] flex-col p-2.5 md:h-[100dvh] md:min-h-0";

/**
 * The header region. `shrink-0` is required, not cosmetic: a flex item defaults
 * to `flex-shrink: 1`, so once the surface has a definite desktop height the
 * header would be compressed by any overflow pressure from below instead of
 * the workstation absorbing it — the breadcrumb would crush before the pane
 * that owns the internal scroll ever did.
 */
export const ADMIN_FOCUS_HEADER_CLASS = "shrink-0";

/**
 * The workstation box. Height auto below `md` (page scrolls); at `md` it takes
 * exactly the surface height minus the measured header, with no constant in
 * the expression at all.
 *
 * `min-h-0` overrides the automatic minimum size of a flex item
 * (`min-height: auto`), which would otherwise floor the box at its content
 * height and let a tall grading body push the surface past the viewport —
 * defeating the bound and stopping the right pane from ever scrolling
 * internally.
 */
export const ADMIN_FOCUS_WORKSTATION_CLASS = "flex min-h-0 flex-col md:min-h-0 md:flex-1";
