import { defineConfig } from "drizzle-kit";

if (!process.env.MINTVAULT_DATABASE_URL) {
  throw new Error("MINTVAULT_DATABASE_URL is not set");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  // SAFETY (Phase 10A): grading/VQ share one physical DB. shared/schema.ts holds NO
  // vq_ tables, so a whole-DB diff here would propose DROPPING every vq_* table
  // (incl. the durable-export/idempotency/revision/flag/config tables). Exclude vq_*
  // so the grading schema-management surface can never touch them. Vault Quest tables
  // are managed ONLY via drizzle-vq.config.ts (tablesFilter: ["vq_*"]).
  tablesFilter: ["!vq_*"],
  dbCredentials: {
    url: process.env.MINTVAULT_DATABASE_URL,
  },
});
