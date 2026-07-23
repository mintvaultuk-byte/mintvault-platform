# Disposable database verification report

Environment: isolated local PostgreSQL 17.10 (Homebrew) at redacted `127.0.0.1:55432/<disposable-db>`. It was not staging, production, Neon, or a shared database. Installed extensions: `pgcrypto 1.3`, `vector 0.8.5`, and `plpgsql 1.0`. Test connection settings were local-only and are intentionally not reproduced here.

Execution sequence: clean local cluster; numbered migration runner dry run; local-only minimal legacy-core fixture after the runner established that `0010` depends on existing app tables; apply `0001`–`0018`; apply `0020`; manually apply the repository Vault Quest migration set; then verify 26 `vq_*` tables, PCD table columns, indexes, migration history and the three immutability triggers.

The PCD migration execution test applies `0020` with a real disposable PostgreSQL runner, inserts one row into each PCD table, and proves UPDATE/DELETE/TRUNCATE rejection. Focused database tests and the complete `npm test` run executed against this isolated database. The canonical full run passed 152 test files / 2,023 tests, with 24 test files / 420 tests explicitly skipped; skipped is reported as skipped, not passed. No application startup claim is made because the disposable legacy fixture was deliberately minimal rather than a complete operational app schema.
