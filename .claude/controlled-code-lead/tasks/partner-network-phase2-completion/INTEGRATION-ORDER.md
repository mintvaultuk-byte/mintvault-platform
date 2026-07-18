# Partner Network Phase 2 Completion — Integration Order & Scope Decision

Base: `main` @ `9c3535a3` (Phase 1 + Phase 2 backend submission slice merged).

## Scope decision for this pass (read first)

The full instruction specifies nine increments (A–I), each production-grade with its
own migrations, RLS, multi-layer tests, and independent review — realistically several
weeks of engineering. Attempting all nine in one pass would force a choice between
rushing untested code into `main` or fabricating "done" on work that isn't. Neither is
acceptable per this project's standing rules (no silent-failure claims, no unwired
work reported as shipped).

This pass therefore delivers **Increment A (Portal shell/navigation)** and
**Increment B (Submission wizard UI)** to the same rigor as prior Phase 1/2 work —
real code, real tests, independent review, controlled merge — because together they
are what turns the already-merged backend into something a person could actually use
end-to-end for the core "create → review → submit" journey (spec steps 1–11).
Increments C–I (tracking detail beyond a basic list, information-request workflow,
user/location management UI, documents, notifications, the trusted grading connector,
Super Admin Phase 2 UI, billing) are **explicitly deferred**, scoped below, and not
claimed as done. This file itself satisfies the "written integration order" requirement
for the whole programme, including the deferred increments, so a future session can
pick up any of them without re-deriving the plan.

## Reuse inventory (do not duplicate)

- Auth/session/MFA/RBAC: `client` has no existing Partner UI at all — building fresh,
  but the API contract is 100% fixed (Phase 1 `/api/partner/auth/*`, `/session`,
  `/mfa/*`, `/session/location`; Phase 2 `/api/partner/submissions*`,
  `/dashboard/submissions`).
- Design system: reuse MintVault's existing Tailwind/shadcn component set from
  `client/src/components/ui/*` and the gold/dark palette already used elsewhere in the
  app (`client/src/index.css` tokens) — no new design system.
- Routing: reuse the existing Wouter router pattern already used by `client/src/App.tsx`.
- Data fetching: reuse TanStack Query conventions from `client/src/lib/queryClient.ts`.

## Increment order (this pass)

1. **A — Portal shell**: route scaffold, auth guard, layout (org/location header,
   nav, mobile menu), session-expired/emergency-stop/feature-disabled states, sign-out.
   Branch: `feat/partner-phase2-portal-shell`.
2. **B — Submission wizard UI**: 5-step wizard (Customer → Service → Cards → Review →
   Submit) wired to the merged Phase 2 APIs, draft autosave with conflict handling,
   dashboard, and a submission list wired to the existing list API. Branch:
   `feat/partner-phase2-submission-ui`.

Both land on the integration branch `feat/partner-network-phase-2-completion`, then go
through the same Stage 0–10 controlled merge review used for the backend slice before
touching `main`.

## Deferred increments (NOT built this pass — scope recorded for later)

| #   | Increment                                                                      | Why deferred                                                                                                                                                                                                                                      | What it needs                                                          |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C   | Tracking detail beyond list/detail (info-request workflow, correction history) | New `partner_submission_information_requests` + `partner_submission_amendments` tables, a full correction-record state machine — a increment in its own right                                                                                     | Migration 0008, its own RLS/review cycle                               |
| D   | User/location management UI                                                    | Phase 1 already has the underlying admin-shell APIs; Partner-self-service screens need new list/invite/suspend UI + safeguard tests (self-escalation, last-owner-removal)                                                                         | New Partner-facing API routes wrapping Phase 1 primitives, UI          |
| E   | Documents/printing                                                             | Needs a reproducibility/audit design decision (which library, PDF vs HTML-print) before implementation                                                                                                                                            | Design decision, no live PDF dependency without review per instruction |
| F   | Notification outbox                                                            | New `partner_notification_outbox` table + processor design                                                                                                                                                                                        | Migration 0008/0009, idempotent event-key design                       |
| G   | Trusted grading-connector                                                      | The highest-risk increment — explicitly called out in the instruction as one that may need to STOP with "PHASE 2 CONNECTOR BLOCKED" if the existing MintVault schema can't safely accept a handoff. Needs its own architecture spike before code. | Architecture decision on the trusted role/path, own migration          |
| H   | Super Admin Phase 2 operations UI                                              | Depends on connector (G) existing to be meaningful (retry/attempt-history controls need attempts to exist)                                                                                                                                        | Built after G                                                          |
| I   | Launch-readiness hardening + full 50-step E2E proof                            | Needs C–H to exist first — the specified 50-step proof exercises info-requests, connector, notifications, user management, none of which are built this pass                                                                                      | All of C–H                                                             |

Recommended real-world order for a future session: **G before C/D/E/F/H** — the
connector is the highest architectural risk and gates whether the rest of the
"submission enters MintVault's real pipeline" story is even buildable as specified;
resolving it early avoids building UI against an assumption that later proves unsafe.

## Explicit owner decisions this pass leaves as configuration, not hard-coded guesses

Per the instruction's list — none are answered with an invented value; all default to
the safest/most conservative behaviour:

- Customer email/phone: optional (Phase 2 spec already established this).
- Pricing: `partner_service_tiers` remains the single source of truth; UI always
  labels amounts "Estimated — price confirmed by MintVault," never a firm quote.
- Card categories: sourced from one shared constant (`shared/partner-card-categories.ts`,
  new in this pass), not hard-coded per screen, so a future owner decision on the
  approved list changes in one place.
