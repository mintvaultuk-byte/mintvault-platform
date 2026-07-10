/**
 * Shared helpers for the Vault Quest data-separation migration scripts (Phase 2).
 *
 * SAFETY MODEL
 *  - SOURCE  (read-only): the CURRENT shared database / grading R2 bucket.
 *  - DEST    (write):     the NEW dedicated Vault Quest database / bucket.
 *  - Every write script is DRY-RUN by default; pass --commit to persist.
 *  - Scripts NEVER write to SOURCE and refuse to run if SOURCE === DEST.
 *  - Scripts refuse the grading PRODUCTION Neon host as a DEST (belt-and-suspenders).
 */
import pg from "pg";
import { createHash } from "node:crypto";

/** All 12 vq_ tables, parents first (there are no FKs, so order is cosmetic). */
export const VQ_TABLES = [
  "vq_sets",
  "vq_elements",
  "vq_families",
  "vq_game_config",
  "vq_releases",
  "vq_cards",
  "vq_card_revisions",
  "vq_ai_generations",
  "vq_characters",
  "vq_character_revisions",
  "vq_artwork_candidates",
  "vq_family_rules",
];

/** Known grading production host — never a valid Vault Quest DEST. */
const GRADING_PROD_HOSTS = ["ep-wispy-morning"];

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable)";
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`[vq-migrate] ${name} is not set`);
  return v;
}

/** Refuse the grading production host as a write target. */
export function assertNotGradingProd(url, role) {
  const host = hostOf(url);
  if (GRADING_PROD_HOSTS.some((h) => host.includes(h))) {
    throw new Error(`[vq-migrate] Refusing grading PRODUCTION host as ${role}: ${host}. This tooling targets Vault Quest staging only.`);
  }
  return host;
}

/** Refuse to copy a database onto itself. */
export function assertDistinct(sourceUrl, destUrl) {
  if (sourceUrl === destUrl) {
    throw new Error("[vq-migrate] SOURCE and DEST database URLs are identical — refusing (would copy onto itself).");
  }
}

export async function connect(url, { readOnly = false } = {}) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Neon pooler has an empty search_path; qualify everything with public AND set it.
  await c.query("SET search_path = public");
  if (readOnly) await c.query("SET default_transaction_read_only = on");
  return c;
}

export const md5 = (buf) => createHash("md5").update(buf).digest("hex");

/** Per-table row count + order-independent content checksum (no PK knowledge needed). */
export async function tableFingerprint(client, table) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            coalesce(md5(string_agg(t::text, '' ORDER BY t::text)), 'empty') AS h
       FROM public."${table}" t`,
  );
  return { n: rows[0].n, h: rows[0].h };
}

export const isCommit = () => process.argv.includes("--commit");
export const hasFlag = (f) => process.argv.includes(f);
