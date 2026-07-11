/**
 * Phase 8A — READ-ONLY migration preflight for VQ migrations 0008–0011.
 * Refuses to run against anything but the known staging branch. No mutation.
 *   npx tsx --env-file=.env scripts/phase8/preflight.ts
 * Exit: 0 all-green · 2 wrong/unknown DB identity · 3 runtime error.
 */
import { db } from "../../server/db";
import { sql } from "drizzle-orm";

function host(): string {
  try {
    return new URL(process.env.MINTVAULT_DATABASE_URL || "").hostname;
  } catch {
    return "unknown";
  }
}
const STAGING_FRAGMENT = "ep-purple-voice"; // staging branch (memory: project_db_branches)
const PROD_FRAGMENT = "ep-wispy-morning"; // prod branch — must never match here

async function main(): Promise<number> {
  const h = host();
  console.log("DB host:", h);
  if (h.includes(PROD_FRAGMENT)) {
    console.error("ABORT: host looks like PRODUCTION.");
    return 2;
  }
  if (!h.includes(STAGING_FRAGMENT)) {
    console.error("ABORT: host is NOT the known staging branch — refusing.");
    return 2;
  }
  console.log("STAGING IDENTITY CONFIRMED (ep-purple-voice).\n");

  const ver = await db.execute(sql`select version() as v`);
  console.log("version:", (ver.rows[0] as { v: string }).v);

  try {
    await db.execute(sql`select gen_random_uuid() as u`);
    console.log("gen_random_uuid(): OK");
  } catch (e) {
    console.log("gen_random_uuid(): MISSING —", e instanceof Error ? e.message : e);
  }

  const priv = await db.execute(sql`select has_schema_privilege(current_user, 'public', 'CREATE') as can_create, current_user as usr`);
  const p = priv.rows[0] as { can_create: boolean; usr: string };
  console.log("can CREATE in public:", p.can_create, "as", p.usr);

  const targets = ["vq_export_jobs", "vq_generation_requests", "vq_artwork_revisions", "vq_feature_flags"];
  for (const t of targets) {
    const r = await db.execute(sql`select to_regclass(${"public." + t}) as reg`);
    console.log(`table ${t}:`, (r.rows[0] as { reg: string | null }).reg ?? "DOES NOT EXIST (ok)");
  }

  const idxNames = [
    "vq_export_jobs_job_id_uq", "vq_export_jobs_idem_active_uq", "vq_export_jobs_state_expires_idx", "vq_export_jobs_state_lease_idx", "vq_export_jobs_owner_idx",
    "vq_gen_req_idem_uq", "vq_gen_req_spend_idx", "vq_gen_req_state_idx", "vq_gen_req_job_idx",
    "vq_artwork_revisions_entity_idx", "vq_artwork_revisions_active_uq", "vq_artwork_revisions_backup_idx", "vq_artwork_revisions_sha_idx",
  ];
  const allVqIdx = await db.execute(sql`select indexname from pg_indexes where schemaname='public' and indexname like 'vq\_%'`);
  const existing = new Set(allVqIdx.rows.map((r) => (r as { indexname: string }).indexname));
  const collisions = idxNames.filter((n) => existing.has(n));
  console.log("colliding index names:", collisions.length === 0 ? "NONE (ok)" : collisions.join(","));

  const inv = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' and table_name like 'vq\_%' order by table_name`);
  console.log(`\nexisting vq_ tables (${inv.rows.length}):`, inv.rows.map((r) => (r as { table_name: string }).table_name).join(", "));
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => {
  console.error("preflight error:", e instanceof Error ? e.message : e);
  process.exit(3);
});
