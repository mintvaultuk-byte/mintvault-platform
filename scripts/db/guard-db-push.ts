/**
 * Phase 0.5 — db:push host guard (CLI wrapper).
 *
 * Wraps `drizzle-kit push`. Refuses to run against any non-local host unless the explicit
 * dangerous override is set. This is the PRIMARY protection against the confirmed hazard
 * where a schema sync could drop unmanaged live tables on a real database.
 *
 * Usage (wired via package.json): npm run db:push  ->  tsx scripts/db/guard-db-push.ts [-- extra drizzle-kit args]
 */
import { spawnSync } from "node:child_process";
import { classifyDbHost, dangerousOverrideEnabled } from "./db-host-policy";

function main(): void {
  const url = process.env.MINTVAULT_DATABASE_URL;
  const verdict = classifyDbHost(url);

  if (!verdict.allowedForPush) {
    if (dangerousOverrideEnabled()) {
      console.warn(
        `⚠️  db:push against non-local host "${verdict.host}" ALLOWED by explicit ALLOW_DANGEROUS_DB_PUSH override. ` +
          `This can DROP live tables. Proceeding at operator's own risk.`,
      );
    } else {
      console.error(
        `\n🚫 db:push BLOCKED.\n` +
          `   Target host: ${verdict.host}\n` +
          `   ${verdict.reason}\n\n` +
          `   Schema changes to staging/production must go through the numbered migration\n` +
          `   workflow (npm run db:migrate), never drizzle-kit push. Direct push can drop\n` +
          `   unmanaged live tables (payments, credits, sessions, subscriptions).\n\n` +
          `   To push to a local/disposable database, point MINTVAULT_DATABASE_URL at\n` +
          `   127.0.0.1/localhost. The interactive override (local prototyping only) is\n` +
          `   ALLOW_DANGEROUS_DB_PUSH="i-understand-this-can-drop-live-tables".\n`,
      );
      process.exit(1);
    }
  } else {
    console.log(`✓ db:push permitted — local/disposable host "${verdict.host}".`);
  }

  // Forward any extra args after `--` to drizzle-kit.
  const passthrough = process.argv.slice(2);
  const result = spawnSync("npx", ["drizzle-kit", "push", ...passthrough], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

main();
