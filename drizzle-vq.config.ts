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
 * Push:     npx drizzle-kit push --config drizzle-vq.config.ts     (staging first)
 * Generate: npx drizzle-kit generate --config drizzle-vq.config.ts (SQL only, no DB)
 */
if (!process.env.VAULT_QUEST_DATABASE_URL) {
  throw new Error(
    "VAULT_QUEST_DATABASE_URL is not set — Vault Quest migrations target the dedicated Vault Quest database only.",
  );
}

export default defineConfig({
  out: "./migrations-vq",
  schema: "./shared/vq-schema.ts",
  dialect: "postgresql",
  // Retained as defence-in-depth: even against a mistargeted URL, drizzle-kit can
  // only ever introspect/diff vq_-prefixed tables.
  tablesFilter: ["vq_*"],
  dbCredentials: {
    url: process.env.VAULT_QUEST_DATABASE_URL,
  },
});
