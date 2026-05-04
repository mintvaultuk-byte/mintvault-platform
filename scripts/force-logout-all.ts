/**
 * scripts/force-logout-all.ts
 *
 * One-shot session-table truncate. Run ONCE manually after the PIN-auth
 * deploy lands so every existing 30-day cookie is invalidated and every
 * user must re-authenticate (and set a PIN if they haven't yet).
 *
 * ⚠️ DESTRUCTIVE.
 *   - Truncates the entire `session` table — every active customer / admin
 *     / account-holder session ends.
 *   - The admin running this script is also signed out. They will need to
 *     log back in via /api/admin/login (env-var password unchanged).
 *
 * ⚠️ Env guard: aborts unless ALLOW_PROD_SMOKE=1 is set when pointing at
 * a prod-shaped DB. Same convention as the other smoke/backfill scripts.
 *
 * Idempotent: TRUNCATE on an empty table is a no-op. Safe to re-run.
 *
 * The endpoint POST /api/auth/logout-everywhere is also wired into the
 * server (admin-only). This script exists as a defence-in-depth backup for
 * cases where the admin can't even log in to hit the endpoint.
 *
 * Usage:
 *   ALLOW_PROD_SMOKE=1 tsx --env-file=.env scripts/force-logout-all.ts
 *
 * Output:
 *   [force-logout] mode: COMMIT
 *   [force-logout] DB: ep-…
 *   [force-logout] sessions before: 41
 *   [force-logout] TRUNCATE session — destroyed=41
 *   [force-logout] audit_log row written
 *   [force-logout] DONE
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd = url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error("[force-logout] DB looks like prod — aborting. Set ALLOW_PROD_SMOKE=1 to override.");
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  const dbHost = process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`[force-logout] mode: COMMIT`);
  console.log(`[force-logout] DB: ${dbHost}\n`);

  // Pre-count
  const before = await db.execute(sql`SELECT COUNT(*)::int AS n FROM session`);
  const beforeCount = (before.rows[0] as any).n;
  console.log(`[force-logout] sessions before: ${beforeCount}`);

  if (beforeCount === 0) {
    console.log("[force-logout] session table already empty — nothing to do");
    process.exit(0);
  }

  await db.execute(sql`TRUNCATE session`);
  console.log(`[force-logout] TRUNCATE session — destroyed=${beforeCount}`);

  // Audit row — paired with the in-app endpoint's audit so the action is
  // attributable whether kicked from the endpoint or from this script.
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      VALUES ('session', 'all', 'logout_everywhere', 'system',
              ${JSON.stringify({
                destroyed: beforeCount,
                source: "scripts/force-logout-all.ts",
                reason: "PIN auth deploy: forced re-auth",
              })}::jsonb,
              NOW())
    `);
    console.log("[force-logout] audit_log row written");
  } catch (e: any) {
    console.warn("[force-logout] audit_log insert failed (non-fatal):", e?.message ?? e);
  }

  console.log("\n[force-logout] DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error("[force-logout] unhandled error:", err);
  process.exit(1);
});
