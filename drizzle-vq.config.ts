import { defineConfig } from "drizzle-kit";

/**
 * Vault Quest migrations — SEPARATE from the grading config on purpose.
 *
 * `tablesFilter: ["vq_*"]` means drizzle-kit only ever introspects and diffs
 * vq_-prefixed tables. It physically cannot propose a change to any grading
 * table, on staging or prod — which matters because the live DB has drifted
 * from shared/schema.ts, so a whole-DB diff could otherwise suggest destructive
 * changes. This file, and `drizzle.config.ts`, must never be merged.
 *
 * ⚠️ DO NOT run `drizzle-kit push` or `generate` against VQ. Vault Quest tables are
 * managed EXCLUSIVELY by hand-applied raw SQL in `migrations-vq/*.sql` (apply in order;
 * the drizzle journal is intentionally frozen at 0002). This config exists so an
 * introspection/diff is *scoped* to vq_* if ever needed for inspection — NOT as an apply
 * path. `shared/vq-schema.ts` now re-exports every operational + production table so that
 * even if `push` is run by mistake it is NON-destructive (Reviewer 3 F-1, Phase 10A);
 * previously it would have proposed DROPPING all 13. To apply a migration:
 *     psql "$VQ_DB_URL" -v ON_ERROR_STOP=1 -f migrations-vq/00NN_name.sql   (staging first)
 */
if (!process.env.MINTVAULT_DATABASE_URL) {
  throw new Error("MINTVAULT_DATABASE_URL is not set");
}

export default defineConfig({
  out: "./migrations-vq",
  schema: "./shared/vq-schema.ts",
  dialect: "postgresql",
  tablesFilter: ["vq_*"],
  dbCredentials: {
    url: process.env.MINTVAULT_DATABASE_URL,
  },
});
