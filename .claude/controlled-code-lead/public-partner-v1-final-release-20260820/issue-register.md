# Issue register — Public Partner Network v1 final production release

| ID | Severity | Class | Reproduction / impact | Repair | Proof state | Status |
| --- | --- | --- | --- | --- | --- | --- |
| PPNR-001 | BLOCKER | E | Fresh `origin/main` assigns `0101` to Growth while the candidate assigned it to public presence; the migration runner rejects duplicate identities. | Preserve main Growth `0101`; rename un-applied public/Google migrations and inventories to `0102`/`0103`. | Local real-PostgreSQL ordered rehearsal: 25/25 focused tests. | Locally verified |
| PPNR-002 | BLOCKER | B/E | Four merge conflicts could discard current Growth authority or reviewed public SSR/SEO authority. | Explicitly reconcile each conflict, retaining both behaviours and one hardened structured-data serializer. | Public HTTP/SSR/SEO/cache suite and targeted hostile re-review clear. | Locally verified |
| PPNR-003 | BLOCKER | B/G | Settings previously lacked a browser-reachable public-directory activation and containment control. | Render only the public switch, require a bounded typed reason, confirmation and the existing protected admin mutation wrapper. | Mounted controls/UI tests: 42/42; targeted hostile review confirms client and server step-up path. | Locally verified |
| PPNR-004 | HIGH | G | Creating suspended/cross-tenant production fixtures would mutate real records just to test negative paths. | Runbook restricts live verification to malformed/well-shaped unknown refs and pre-existing legitimate records only. | Documentation/source audit; production verification not started. | Implemented |
| PPNR-005 | HIGH | G | Partner audit/provenance/financial history prevents a safe physical delete. | Require recovery evidence and an aggregate manifest; use canonical terminal revocation only for targets later proven disposable. | Read-only database/security review; no reset started. | Owner/external gate |
| PPNR-006 | EXTERNAL FOLLOW-UP | F | Google OAuth/API credentials and live pilot prerequisites are absent. | Keep optional `0103` schema, flag and provider integration inactive. | Source/flag boundaries reviewed. | Deferred safely |
| PPNR-007 | EXTERNAL INPUT | G | A legitimate new Partner requires owner-controlled business/contact/location/access data. | Collect exact inputs and obtain action-time approval only after code release is ready. | Not applicable before owner input. | Waiting |
| PPNR-008 | HIGH | A | The critical Super Admin control-shell test used two parameterised `INSERT`s in one PostgreSQL prepared statement, which PostgreSQL rejects before it can prove exact public-profile approval. | Split the fixture into two atomic parameterised inserts. | Isolated suite 12/12; full fail-closed Partner matrix 70 suites / 1,315 assertions. | Locally verified |
| PPNR-009 | BLOCKER | B/D/E | `origin/main` advanced 33 commits from the local candidate base to `2d776db9`; safe deployment refuses a checkout that is behind main. | Reconcile the eight true merge conflicts, retain both authorities, then rerun all affected release proofs against the new exact SHA. | Read-only merge-tree deterministically reports conflicts in eight shared files. | In progress |

## Latest evidence

- `npx vitest run tests/partner-pilot-flag-controls-ui.test.ts tests/partner-management-admin-ui.test.ts tests/partner-schema-parity.test.ts`: 42/42 passed.
- `npx vitest run tests/canonical-lineage-production-rehearsal.test.ts tests/public-partner-presence-db.test.ts tests/google-partner-presence-migration.test.ts tests/partner-schema-parity.test.ts`: 25/25 passed.
- Public API/SSR/cache/privacy/Google/control suites: 40 passed, 40 environment-gated skipped.
- `npm run check`, `npm run lint` (0 errors), `npm run build`, and `npm run graph:check`: passed.
- `node scripts/ci/run-partner-suite.mjs --all`: 70/70 critical suites green, 1,315 assertions observed.
- Full `npm test`: 5,214 passed / 1,015 skipped; five suites lacked their pinned local environment. Those five were then exercised with the disposable loopback variables: 62/62 passed. The shared CI-fixture preparation script itself stopped on pre-existing local VQ schema drift and was not reset.
- `git diff --check`: clean at the time of each focused proof.
