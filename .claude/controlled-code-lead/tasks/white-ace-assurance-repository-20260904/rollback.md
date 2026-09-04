# Rollback — White Ace local proof repairs

No runtime or data rollback is required because the bounded implementation changes only test fixtures/assertions, exact scanner false-positive fingerprints, and governance/evidence records.

- Revert the five changed test files to restore their prior proof fixtures.
- Remove `.gitleaksignore` to restore the prior full-history/current-branch scanner findings.
- Re-run the focused suite and gitleaks command after either rollback.

Do not roll back or mutate any database, object store, provider, environment or deployed service for these repairs.
