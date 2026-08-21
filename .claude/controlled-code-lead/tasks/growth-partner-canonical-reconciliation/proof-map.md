# Proof map — Growth / Partner canonical reconciliation

| Claim | Authority | Required proof | Invalidated by |
| --- | --- | --- | --- |
| Candidate contains both releases | Git DAG | Both `718f60e7` and `337776e6` are ancestors of final SHA. | Any rebase, reset or new merge. |
| Growth visual behavior is retained | Approved visual source and focused UI/runtime tests | Existing visual and Growth regression suites; build artifact inspection. | Growth/UI source or harness change. |
| Partner public presence is retained | Live source plus Partner public/portal/SEO/maps suites | File/migration identity and behavioral test matrix. | Partner route/service/schema/public-page change. |
| Migration plan is safe | Immutable files, `scripts/db/migrate.ts`, disposable test topology | Identity, schema-parity and canonical rehearsal tests; no production migration run. | Migration file/runner/journal change. |
| No prohibited external action occurred | Git/Fly/provider state and task boundaries | No deploy invocation, no config mutation, no migration execution. | Any external mutation. |

## Local proof recorded 2026-08-21

- Growth: 9 files / 75 assertions passed.
- Partner public, portal, management, discovery/SEO/maps and Google-security boundaries: 13 files / 136 passed, 28 explicitly skipped.
- Payment and Scanner shared boundaries: 8 files / 103 passed, 2 explicitly skipped.
- Migration / schema: 4 files / 25 passed against disposable test topology.
- Typecheck, lint (0 errors), production build, Graphify build/check, Engineering OS and governance self-tests passed.
- Broader suite: 5,376 passed, 1,015 skipped, 5 DB-environment failures; classified GPR-004, not a candidate defect.

## Security repair proof recorded 2026-08-21

- GitHub Advanced Security’s seven high CodeQL findings on the initial merge were accepted as GPR-005 rather than waived because the candidate would make those live lines canonical.
- The Google OAuth callback allows exactly 30 actor-bound exchanges per minute and returns 429 before a 31st provider exchange.
- Metadata injection still renders SEO tags when malformed tags occur before the trusted base markup, using a bounded scanner that cannot trigger the reported polynomial tag regex.
- 35 focused assertions, `npm run check`, changed-file lint (0 errors), production build and Graphify build/check passed. A new exact-SHA CodeQL result remains required.
