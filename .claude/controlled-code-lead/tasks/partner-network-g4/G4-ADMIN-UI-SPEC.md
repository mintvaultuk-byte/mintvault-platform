# G4 Admin UI Spec

Inside the existing admin app. Add lazy route `/admin/partner-network` (before the `Layout` catch-all in `App.tsx`) + a `NavLink` in the `NAV` array (`admin-shell.tsx`). Each page: self-auth-gate (`fetch("/api/admin/session")` → redirect `/admin/login?next=`), renders `AdminShell`, TanStack Query + prefix `invalidateQueries`, `apiRequest`, admin primitives (`Panel/StatCard/Badge/AdminButton/Chip`), gold/Manrope tokens. Pure logic (status→badge mapping, reason validation, query-key builders) exported for source-assertion tests (no DOM harness).

## Pages
1. **Partner Operations Overview** (`/admin/partner-network`): StatCards (partner count, connector count, eligible/processing/failed, reconciliation-required, manual-review, expired-claim); recent operational actions; search + filters; links to partner/record detail. Clear banner when global processing is disabled (read-only flag state).
2. **Partner Detail**: summary, connectors, queue summary, unresolved work, recent activity.
3. **Connector Detail**: safe config summary (redacted), status, latest validation, processing counts, record table, worker/retry metrics, reconciliation summary, audit history. Pause/resume/disable controls shown DISABLED with an inline "deferred — requires owner approval" note (not wired).
4. **Connector Record Detail**: timeline (source received → validation runs → fingerprint changes (old vs newer, no raw payload) → owner resolution → reservation → attempts → retries → reconciliation → destination mapping → final outcome → admin actions). Action buttons (retry/reconcile/resolve/manual-review/ack/release-claim) each open a modal with a required reason `<textarea>`; disabled when the current state doesn't permit the action, with a visible reason-why-unavailable.
5. **Manual Review Queue**: deterministic ordering, filters, reason/status, partner+connector, age, source ref, review action (approve-retry/cancel/retain) via reason modal.
6. **Reconciliation Queue**: inconsistency type, source state, destination state, mapping state, recommended safe actions, explicit decision control (retain/retry/mark-manual) via reason modal.
7. **Worker & Queue Health**: dormant/active state, global connector-flag state (READ-ONLY), emergency-stop state (READ-ONLY), queue counts, retry counts, worker configuration, last processing activity. Prominent "processing globally disabled" state.
8. **Connector Audit History**: actor, action, target, reason, result, timestamp, request ID, before/after summary. No secrets.

## Safety UX
Status badges; plain-language errors (from mapped codes); disabled controls for invalid actions with visible reason; confirmation modal for every mutation; typed-confirmation reserved for high-risk (all high-risk ops are deferred this pass, so no typed-confirm needed for the shipped safe ops beyond the reason field); per-record outcomes for batch; loading/empty states; accessible labels; keyboard nav; responsive. No optimistic completion — await server confirm then invalidate.

## Test approach (no DOM harness)
Source-assertion (`readFileSync` + `toContain` on `data-testid`s) + imported pure helpers (status→badge, reason validation, query-key builders) + real-HTTP integration for the API the pages consume.
