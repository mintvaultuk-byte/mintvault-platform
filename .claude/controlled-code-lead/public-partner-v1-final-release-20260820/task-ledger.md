# Task ledger — Public Partner Network v1 final production release

## Stage 0 — Baseline (recorded 2026-08-20)

- Integration branch: `codex/public-partner-v1-final-release-20260820` at `f4285b71a5fd0cad578e845d9aaed43768309541`, a clean worktree created from freshly fetched `origin/main`.
- Candidate preserved unchanged: `132e9ab49bfb05cd3c152dd9efe0f34153bc6810`, based on prior main `facfd36f`.
- Production: `facfd36f`, confirmed at 04:52 UTC by both production `/api/version` hosts; Fly `mintvault` release `v1110`; both `lhr` machines started with `1/1` checks.
- Production journal read-only evidence: migrations `0091`–`0100` were already applied by an independent programme; there is no `0101` row or public-presence table. Their previously requested exclusion is therefore satisfied without this task applying them.
- Owner authorisation: the owner-authored release instruction permits this release, only public-presence migration 0101 (renumbering may be required by a current-main collision), and reset/removal only of Partner records proven to be genuinely disposable tests. It does not authorise Google 0102/0103, secrets, financial mutations, Scanner/MVGS work, ambiguous deletion, or the transmission of business/personal details through browser forms.
- Protected systems: production database, schema migration, deployment, Partner data/PII/publication. Grading, payments, credits and Scanner are excluded from changes.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-20 | Fresh refs and live health/version read-only evidence captured. |
| 1 — Review plan | done | 2026-08-20 | Four non-overlapping read-only scopes completed or finalising. |
| 2 — Investigation | done | 2026-08-20 | Main moved after initial baseline; four reviewer reports were verified against source and target evidence. |
| 3 — Lead verification | done | 2026-08-20 | Accepted PPNR-001 through PPNR-007; blockers are addressed only by the bounded manifest. |
| 4 — Implementation authorisation | done | 2026-08-20 | The bounded reconciliation manifest authorises local code/test work only. |
| 5 — Implementation | done | 2026-08-20 | Candidate merged locally; four conflicts reconciled; public migration renamed to 0102, Google to optional 0103; public-directory control added. |
| 6 — Regression | in progress | 2026-08-20 | Focused UI, real PostgreSQL lineage/public migration, public HTTP/SSR/SEO/cache and Google isolation suites are green; TypeScript/lint/build are green. Full suite code execution is green apart from a shared local-fixture preparation failure, whose five affected suites were run safely with their pinned loopback variables. |
| 7 — Final report | pending | | |

## Accepted investigation findings

| ID | Severity | Class | Evidence | Planned resolution |
|---|---|---|---|---|
| PPNR-001 | BLOCKER | E | Current `origin/main` owns `0101_growth_reviews_and_conversion.sql`; candidate owns a distinct 0101, which the migration runner rejects. | Preserve main 0101; renumber candidate public-presence/Google package only after target journal proof; retain Google unapplied. |
| PPNR-002 | BLOCKER | B | Candidate/main have proven route/SEO/static/test merge conflicts; choosing either side drops live authority. | Explicit reconciliation merge retaining Growth and Partner public authorities, then fresh release proof. |
| PPNR-003 | BLOCKER | B/G | Settings lacks a public-directory kill switch or a reason/step-up flow, despite server support and rollout dependence. | Add a dedicated, typed-reason, confirmed, fresh-step-up control and mounted regression proof. |
| PPNR-004 | HIGH | G | Production negative fixtures must not be fabricated. | Restrict live negative checks to malformed/unknown and legitimate existing data; keep suspension/cross-tenant proof in DB tests. |
| PPNR-005 | HIGH until proven | G | Physical Partner deletion conflicts with intentionally retained audit/security/financial/provenance history. | Produce live inventory + backup/reset manifest; prefer canonical REVOKED termination for safe tests. |
| PPNR-006 | EXTERNAL FOLLOW-UP | F | Google prerequisites are absent. | Keep Google schema/flag/OAuth inactive; public Maps-address fallback is independent. |
| PPNR-007 | EXTERNAL INPUT | G | A fresh legitimate Partner needs owner-controlled identity/contact/location/Owner access. | Request the exact information and action-time approval only when the system is ready to receive it. |

## Reviewer assignments

| Reviewer | Scope | Result |
|---|---|---|
| Source authority | Main/candidate conflicts, migration identity, deployment/flags | complete — PPNR-001/002 accepted |
| UX/SEO/accessibility | Browser acceptance and control reachability | complete — PPNR-003/004 accepted; Google classified non-blocking external follow-up |
| Hostile reviewer | Migration preflight/rehearsal/rollback | complete — no standalone code defect; preflight gate requirements accepted |
| Security/privacy | Dependency inventory and reset authority | complete — no physical delete authority; terminal revocation only after recovery/manifest gates |

## Next authorised action

Finalize local governance evidence and create an unpushed reconciliation commit. No push, deployment, migration, flag activation, Partner reset, or Partner creation is authorised to execute.
