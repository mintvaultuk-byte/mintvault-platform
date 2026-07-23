# Active branch integration matrix

All entries were inspected from Git state and worktree status; no branch was integrated merely because of its name.

| Branch / worktree | Base / HEAD | State and overlap | Recommendation |
|---|---|---|---|
| `codex/project-control-dashboard-megs-v11` / `mintvault-project-control-dashboard-megs-v11` | `12139b6` / `12139b6` | Dirty source evidence; changes App, admin shell, feature flags, routes, schema, tests and new PCD files | Preserve untouched |
| `integration/mintvault-project-control-reviewed-candidate` / candidate | `12139b6` / `12139b6` | Dirty controlled candidate; source plus review fixes | Preserve for independent review |
| `codex/partner-g6d-submission-credit-integration` / `mintvault-g6d-submission-credit-integration` | `12139b6` / `98002e1` (2 ahead) | Clean; adds `0019`; overlaps only the two Partner test files | Founder decision required; integrate before any `0020` deployment |
| `codex/super-admin-correction-mode` / main worktree | `0fedce6` / `0fedce6` | Dirty, six commits behind `origin/main`; central route work is independent | Preserve; rebase later; do not combine here |
| `codex/partner-g6b-credit-reservations` | `0d4cc555` / same | Clean worktree, six behind; historical G6B basis | Ignore for this candidate; retain history |
| `codex/partner-g6c-admin-credit-management` | `4f6fff43` / same | Clean, one behind | Ignore for this candidate |
| `codex/partner-auth-invitations-rbac` | `12139b6` / same | Clean, no committed delta | Preserve; no action |
| `arch/unified-admin-shell` / `mintvault-unified-shell` | `eb5e6c54` / `b61deb25` | 16 ahead, 141 behind; touches admin shell | Stale; rebase later, do not merge |
| `release/unified-admin-shell` | `a7cac275` / same | 94 behind | Superseded/stale; ignore |
| `routes-split` | `4879694a` / same | 318 behind | Stale; ignore |

The Project Control adjustments to `tests/partner-schema-parity.test.ts` and `tests/partner-credit-reservation-service.test.ts` are required compatibility coverage: parity must recognize `0020`, and the reservation rollback test must remove later migrations before its rollback path. They are neither imported G6D product code nor an authorization to merge G6D.
