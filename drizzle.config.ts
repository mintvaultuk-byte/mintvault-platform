import { defineConfig } from "drizzle-kit";

if (!process.env.MINTVAULT_DATABASE_URL) {
  throw new Error("MINTVAULT_DATABASE_URL is not set");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.MINTVAULT_DATABASE_URL,
  },
});
