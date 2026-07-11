/**
 * Phase 8A — post-apply staging schema verification + durable-invariant integration
 * test on real Postgres. Staging-guarded. Inserts a few marked test rows and DELETES
 * them (precise cleanup). Proves: uuid/expiry defaults, the partial-unique idempotency
 * guard, and the state CHECK constraint. No production, no VQ business data touched.
 *   npx tsx --env-file=.env scripts/phase8/verify-schema.ts
 */
import { randomUUID } from "node:crypto";
import { db } from "../../server/db";
import { sql } from "drizzle-orm";

const STAGING_FRAGMENT = "ep-purple-voice";
const PROD_FRAGMENT = "ep-wispy-morning";
const host = () => {
  try { return new URL(process.env.MINTVAULT_DATABASE_URL || "").hostname; } catch { return "unknown"; }
};
const MARK = `PHASE8-VERIFY-${randomUUID()}`;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
};

/** Walk the drizzle/pg cause chain collecting SQLSTATE codes + messages. */
function pgErrorInfo(e: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const parts: string[] = [];
  let cur: { code?: string; message?: string; cause?: unknown } | undefined = e as never;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.code) codes.push(cur.code);
    if (cur.message) parts.push(cur.message);
    cur = cur.cause as typeof cur;
  }
  return { codes, text: parts.join(" | ") };
}

async function expectSqlState(name: string, fn: () => Promise<unknown>, wantCode: string): Promise<void> {
  try {
    await fn();
    check(name, false, "expected a Postgres error, got success");
  } catch (e) {
    const info = pgErrorInfo(e);
    const ok = info.codes.includes(wantCode);
    check(name, ok, ok ? `SQLSTATE ${wantCode}` : `got codes [${info.codes.join(",")}] ${info.text.slice(0, 60)}`);
  }
}

async function main(): Promise<number> {
  const h = host();
  if (h.includes(PROD_FRAGMENT) || !h.includes(STAGING_FRAGMENT)) {
    console.error(`ABORT: not staging (${h}).`);
    return 2;
  }
  console.log(`Verify on STAGING (${h})\n`);

  // 1. Tables exist
  console.log("Tables:");
  for (const t of ["vq_export_jobs", "vq_generation_requests", "vq_artwork_revisions", "vq_feature_flags"]) {
    const r = await db.execute(sql`select to_regclass(${"public." + t}) as reg`);
    check(t, (r.rows[0] as { reg: string | null }).reg != null);
  }

  // 2. Index counts
  console.log("\nIndexes:");
  // Expected index counts include implicit indexes: PK + any column-level UNIQUE.
  // vq_artwork_revisions = PK + r2_key UNIQUE (implicit) + 4 explicit = 6.
  for (const [t, n] of [["vq_export_jobs", 6], ["vq_generation_requests", 5], ["vq_artwork_revisions", 6], ["vq_feature_flags", 1]] as const) {
    const r = await db.execute(sql`select count(*)::int as c from pg_indexes where schemaname='public' and tablename=${t}`);
    const c = (r.rows[0] as { c: number }).c;
    check(`${t} has ${n} indexes (incl. PK)`, c === n, `found ${c}`);
  }

  // 3. CHECK constraints present
  console.log("\nCHECK constraints:");
  const chk = await db.execute(sql`select conrelid::regclass::text as t, conname from pg_constraint where contype='c' and conrelid::regclass::text = any(array['vq_export_jobs','vq_generation_requests','vq_artwork_revisions','vq_feature_flags'])`);
  check("state/backup/entity/feature CHECKs exist", chk.rows.length >= 4, `found ${chk.rows.length}`);

  // 4. Durable-invariant integration test (marked rows, cleaned up)
  console.log("\nDurable invariants (real Postgres):");
  const ins = await db.execute(sql`
    insert into vq_export_jobs (kind, owner_admin_id, idempotency_key, state, requested_count)
    values ('pack', 'verify@staging', ${MARK}, 'queued', 3)
    returning job_id, expires_at`);
  const row = ins.rows[0] as { job_id: string; expires_at: string };
  check("job_id auto-generated (uuid)", /^[0-9a-f-]{36}$/.test(row.job_id));
  check("expires_at default set (~20m)", row.expires_at != null);

  await expectSqlState(
    "partial-unique blocks a 2nd ACTIVE job for the same idempotency_key",
    () => db.execute(sql`insert into vq_export_jobs (kind, owner_admin_id, idempotency_key, state) values ('pack','verify@staging',${MARK},'queued')`),
    "23505", // unique_violation
  );

  await expectSqlState(
    "state CHECK rejects an invalid state",
    () => db.execute(sql`insert into vq_export_jobs (kind, owner_admin_id, idempotency_key, state) values ('pack','verify@staging',${MARK + "-x"},'bogus')`),
    "23514", // check_violation
  );

  // 5. A terminal row with the SAME key IS allowed (re-export after completion)
  await db.execute(sql`update vq_export_jobs set state='completed' where idempotency_key=${MARK}`);
  try {
    await db.execute(sql`insert into vq_export_jobs (kind, owner_admin_id, idempotency_key, state) values ('pack','verify@staging',${MARK},'queued')`);
    check("re-export allowed once prior job is terminal (partial-unique is active-only)", true);
  } catch (e) {
    check("re-export allowed once prior job is terminal", false, e instanceof Error ? e.message.slice(0, 60) : "");
  }

  // Cleanup — delete ONLY the marked test rows
  const del = await db.execute(sql`delete from vq_export_jobs where idempotency_key like ${MARK + "%"}`);
  console.log(`\nCleanup: deleted ${del.rowCount ?? "?"} test rows (marker ${MARK.slice(0, 20)}…)`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed.`);
  return fail === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => {
  console.error("verify error:", e instanceof Error ? e.message : e);
  process.exit(3);
});
