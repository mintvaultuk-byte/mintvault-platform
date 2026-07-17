import { defineConfig } from "drizzle-kit";

/**
 * Partner Network schema config (Phase 1+). Parallels drizzle-vq.config.ts.
 *
 * `tablesFilter: ["partner_*"]` scopes drizzle-kit to ONLY the partner_* family, so partner
 * schema introspection/diffing can never touch grading, Vault Quest, or any other MintVault
 * table. Partner tables are applied via the Phase 0.5 numbered-migration runner
 * (npm run db:migrate), NEVER via `drizzle-kit push` against a real DB — the host guard blocks
 * that. This config exists for local, disposable-DB introspection/diff assistance only.
 *
 * The MintVault-internal `field_welders` registry (non-tenant, ADR-018) is intentionally NOT in
 * this filter — it is not a tenant-scoped partner table and is managed by the same numbered
 * migrations, not partner schema tooling.
 */
if (!process.env.MINTVAULT_DATABASE_URL) {
  throw new Error("MINTVAULT_DATABASE_URL is not set");
}

export default defineConfig({
  out: "./migrations-partner",
  schema: "./shared/partner-schema.ts",
  dialect: "postgresql",
  tablesFilter: ["partner_*"],
  dbCredentials: {
    url: process.env.MINTVAULT_DATABASE_URL,
  },
});
