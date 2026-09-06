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
 * managed exclusively by immutable numbered SQL and the canonical migration runner:
 *     npm run db:migrate -- --estate vault-quest               (read-only plan)
 *     npm run db:migrate -- --estate vault-quest --apply        (owner-approved apply)
 * The runner uses its separate migration credential and drizzle.vq_schema_migrations;
 * the ORM journal is not execution authority. Never apply files individually with psql.
 * Unjournalled historical estates require the separately reviewed historical-baseline-v1
 * admission procedure, never replaying old SQL. See docs/runbooks/db-migration-safety.md.
 * This config is only for scoped introspection/diff, not an application path or a
 * guarantee that an accidental push is safe. Shared/staging/production execution
 * always needs explicit target-specific owner approval.
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
