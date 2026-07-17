import { defineConfig } from "drizzle-kit";
import { managedTables } from "./scripts/db/schema-registry";

if (!process.env.MINTVAULT_DATABASE_URL) {
  throw new Error("MINTVAULT_DATABASE_URL is not set");
}

// SAFETY (Phase 0.5 — fail-closed allowlist). Previously this used a denylist
// (`["!vq_*"]`), which meant every live table absent from shared/schema.ts — payments,
// credits, sessions, subscriptions, and ~24 others created by runtime migrate*() or
// hand-applied SQL — was a DROP candidate for a whole-DB diff. We now scope drizzle to
// an explicit ALLOWLIST derived live from shared/schema.ts: drizzle only ever sees the
// tables it actually manages. Any unmanaged live table (vq_* and the 30 classified
// unmanaged tables) is out of scope and can never be dropped by a push. New schema.ts
// tables are auto-included; unknown tables are auto-ignored here and separately surfaced
// (fail-closed) by scripts/db/preflight-schema.ts. Proven on a disposable DB against
// drizzle-kit 0.31.10 before landing. Vault Quest is still managed only via
// drizzle-vq.config.ts.
export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  tablesFilter: managedTables(),
  dbCredentials: {
    url: process.env.MINTVAULT_DATABASE_URL,
  },
});
