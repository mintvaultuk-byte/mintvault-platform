# Memory — databases

- **Staging DB** = Neon `ep-purple-voice-abfez796` (neondb, PG 17.10). Local `.env`
  `MINTVAULT_DATABASE_URL` points here. (2026-07-11, verified)
- **Production DB** = Neon `ep-wispy-morning-ab6f4o08`. Lives in Fly secrets only; NEVER
  the local `.env`. Confirm host by identity before any mutation. (src: [[project_db_branches]])
- Staging and prod schemas have DIVERGED — never assume parity; validate SQL against the
  live target. (src: [[mintvault-db-migration-discipline]])
- `cert_counter` / `certificate_number`: a desync 500s the next cert allocation — check
  before any cert work. PROTECTED. (src: protected-systems.md)
- **VQ tables:** `vq_export_jobs`, `vq_generation_requests`, `vq_artwork_revisions`,
  `vq_feature_flags` (migrations 0008–0011) are APPLIED to STAGING only (Phase 8A,
  2026-07-11), NOT prod. Verified 14/14. Older vq_ Character-Bible tables on both.
- VQ migrations: hand-applied idempotent SQL via `--config drizzle-vq.config.ts`. NEVER
  plain `drizzle-kit push` (drift → destructive drop).
