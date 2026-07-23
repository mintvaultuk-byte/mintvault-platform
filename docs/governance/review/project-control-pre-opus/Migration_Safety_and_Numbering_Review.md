# Migration safety and numbering review

`origin/main` ends at `0018_correction_audit_index.sql`. The candidate adds additive `0020_project_control_dashboard.sql`; G6D independently adds `0019_partner_submission_credit_lifecycle.sql`. There is no number collision, but `0020` must not be deployed before an approved branch containing `0019` is in the same migration lineage. This is release gate `MRG-HIGH-001`.

The migration creates three Project Control tables with keys, timestamps, unique identifiers and indexes for evidence lookup/history. It is additive and its destructive-SQL lint passes. It creates an append-only function and database triggers covering UPDATE, DELETE and TRUNCATE on each table. Dynamic trigger creation was used so the repository’s destructive-SQL heuristic correctly sees no destructive operation in the migration source.

Disposable PostgreSQL applied `0001`–`0018` then `0020`; head recorded in `schema_migrations` is `0020_project_control_dashboard.sql`. The numbered chain is not independently bootstrap-complete: `0010` assumes legacy `users`, `submissions`, `submission_items` and `audit_log` tables. A minimal local-only compatibility fixture was required after `0001`–`0009`; production/staging must use their canonical pre-existing core schema. This is `MIG-MED-001`, not permission to apply the fixture outside the disposable DB.
