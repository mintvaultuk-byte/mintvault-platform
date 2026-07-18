/**
 * Phase 0.5 — db:push host guard (CLI wrapper).
 *
 * Wraps `drizzle-kit push`. Permits it ONLY against a local/disposable host and BLOCKS it
 * against any non-local (staging/production) host with no override. This is the primary
 * protection against the confirmed hazard where a schema sync could drop unmanaged live
 * tables. Production/staging schema change goes exclusively through db:migrate.
 *
 * Usage (wired via package.json): npm run db:push  ->  tsx scripts/db/guard-db-push.ts [extra drizzle-kit args]
 */
import { spawnSync } from "node:child_process";
import { classifyDbHost } from "./db-host-policy";

function main(): void {
  const url = process.env.MINTVAULT_DATABASE_URL;
  const verdict = classifyDbHost(url);

  if (!verdict.allowedForPush) {
    console.error(
      `\n🚫 db:push BLOCKED.\n` +
        `   Target host: ${verdict.host}\n` +
        `   ${verdict.reason}\n\n` +
        `   Direct schema push to staging/production is prohibited outright — it can drop\n` +
        `   unmanaged live tables (payments, credits, sessions, subscriptions). There is no\n` +
        `   override. Use the numbered migration workflow instead:\n` +
        `     npm run db:preflight   # verify no unknown objects\n` +
        `     npm run db:migrate     # dry-run plan\n` +
        `     npm run db:migrate -- --apply   # apply, with owner approval\n\n` +
        `   db:push is for a local/disposable database only (host 127.0.0.1 / localhost).\n`,
    );
    process.exit(1);
  }

  console.log(`✓ db:push permitted — local/disposable host "${verdict.host}".`);
  const passthrough = process.argv.slice(2);
  const result = spawnSync("npx", ["drizzle-kit", "push", ...passthrough], { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

main();
