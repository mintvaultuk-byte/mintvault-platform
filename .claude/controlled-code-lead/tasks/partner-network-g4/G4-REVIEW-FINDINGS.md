# G4 Review Findings & Dispositions

Seven independent read-only reviewers (authz, connector-domain, DB/audit, API-security, UI, concurrency, scope). No Critical/High. Verdicts: authz CLEAN, API-security CLEAN, concurrency CLEAN, scope CLEAN; connector-domain ISSUES (1 Med, 1 Low); DB/audit ISSUES (2 Low); UI CLEAN (3 Low).

## Fixed
| ID | Sev | Finding | Fix | Verified |
|---|---|---|---|---|
| CD-F1 | Medium | `opRequestRevalidation` recorded audit under the borrowed `reconcile_mark_manual` label — conflated revalidation with manual-review escalation | Added `request_revalidation` to the AdminActionType union + migration 0014 CHECK; label used in opRequestRevalidation | integration test asserts a `request_revalidation` audit row and no `reconcile_mark_manual` for a revalidate call |
| CD-F2 | Low | `opRetryRecord` always recorded `retry_import`; the `resume_reserved`/`retry_interrupted` labels were declared-but-never-emitted | Resolve the label from the dispatched recovery service (reserved→`resume_reserved`, ready/importing→`retry_interrupted`) | tsc + integration green; branch labels now emitted |
| DB-F1 | Low | `idx_..._org` index had no query consumer (speculative) — same class flagged as a blocker in G3F | Removed the org index from migration 0014; reworded comment; migration test asserts the exact 3-index inventory (pkey + idem-unique + record) and org index absent | migration test 8/8 |
| F6-01 / DB-F2 | Low ×2 | A concurrent same-idempotency-key race surfaced `INTERNAL_ERROR(500)` (23505 on the succeeded-terminal insert → failed row + rethrow) instead of a clean idempotency response; safety invariant held | `withAudit` catch maps a `23505` unique-violation to `alreadyCompleted:true` (no spurious `failed` row) | tsc green; sequential idempotency still 1 succeeded row |
| UI-F2 | Low | Modal lacked `aria-labelledby`, label association, and Escape-to-close | Added `aria-labelledby`/`id`, `<label htmlFor>`, autofocus, and an Escape keydown handler | UI source-assertion test |
| UI-F3 | Low | `requiresTypedConfirm`/`unavailableReason` helpers declared but unwired — the spec's typed-confirm for high-risk (cancel-after-review / ack) was not enforced | Wired typed-confirmation (type `CONFIRM`) for high-risk actions; wired `unavailableReason` into disabled-button `title` | UI source-assertion test |
| UI-F1 | Low | Hardcoded hex where admin tokens exist (incl. an off-token red) | Banners/spinner/modal now use `var(--admin-gold/red/panel/bg)` with hex fallbacks | tsc/prettier green |
| R6-note | Low | `MAX_BATCH_RETRY` dead scaffolding (batch deferred) | Removed the unused constant + import/re-export (`batch_retry` stays a reserved CHECK value) | eslint/tsc green |

## Accepted (documented, non-blocking)
| ID | Sev | Finding | Rationale |
|---|---|---|---|
| API-XFF | Low (info) | Rate-limit `keyGenerator` trusts the first `x-forwarded-for` value | Identical pattern to the existing `adminRateLimit` (server/index.ts); the surface is behind two-step `requireAdmin`; the limiter is defense-in-depth, not the primary control. A shared multi-machine store is the documented follow-up. |
| Scope-cosmetic | Info | `prettier --write` incidentally reflowed two pre-existing blocks in admin-shell.tsx | Formatting-only, valid prettier, no behavioural change; reverting would fail `prettier --check`. |
| Batch-retry | Info | Bounded batch retry not implemented | Deferred by design (single-record retry proven first); no dead code remains after removing MAX_BATCH_RETRY. |

## Not covered / carried forward
- Live-DB target-host checks before ANY future migration application (owner-gated; not this pass — disposable PG only).
- Partner-detail (`GET /partners/:partnerId`) endpoint + its partner-scoped audit view (would re-introduce an org index when the query exists).
