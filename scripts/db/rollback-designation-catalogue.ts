/**
 * rollback-designation-catalogue.ts — exact inverse of
 * scripts/db/reconcile-designation-catalogue.ts.
 *
 * Restores the approved pre-reconciliation baseline:
 *   • the three pre-existing rows (unlimited / first_edition / shadowless) have
 *     their `abbreviation` set back to NULL;
 *   • the seven rows created by the reconciliation are DELETED — but only when
 *     they still look exactly as the reconciliation created them AND no
 *     certificate references them (checked, not assumed);
 *   • error / misprint / test_print are un-archived back to live.
 *
 * Unrelated catalogue rows (rarity, finish, promo, subset, language, era,
 * attribute) are never touched. Certificates are never touched.
 *
 * Same guard surface and default-dry-run behaviour as the forward script.
 *
 * USAGE
 *   npx tsx scripts/db/rollback-designation-catalogue.ts --environment production
 *   npx tsx scripts/db/rollback-designation-catalogue.ts \
 *     --environment production --apply --confirm-production \
 *     --expected-app-sha <sha> --expected-db-host ep-wispy-morning
 */
import pg from "pg";
import {
  sslFor,
  CANONICAL_DESIGNATIONS,
  LEGACY_TO_ARCHIVE,
  APPROVED_BASELINE_VALUES,
  parseArgs,
  type CatalogueRow,
} from "./reconcile-designation-catalogue";

/** The three rows that existed BEFORE the reconciliation and must survive it. */
const PRE_EXISTING = ["unlimited", "first_edition", "shadowless"] as const;
/** The seven rows the reconciliation created — the only rows rollback may delete. */
const CREATED_BY_RECONCILIATION = CANONICAL_DESIGNATIONS.map((d) => d.value).filter(
  (v) => !(PRE_EXISTING as readonly string[]).includes(v)
);

const ENV_HOSTS: Record<string, string> = {
  staging: "https://mintvault-v2.fly.dev",
  production: "https://mintvault.fly.dev",
};

class GuardError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string) => console.log(s);

  if (!args.environment || !(args.environment in ENV_HOSTS)) {
    throw new GuardError(`--environment must be one of: ${Object.keys(ENV_HOSTS).join(", ")}`);
  }
  if (args.apply && args.environment === "production" && !args.confirmProduction) {
    throw new GuardError("--confirm-production is required to apply to production");
  }
  if (args.apply && !args.expectedAppSha) throw new GuardError("--expected-app-sha is required with --apply");
  if (args.apply && !args.expectedDbHost) throw new GuardError("--expected-db-host is required with --apply");

  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new GuardError("MINTVAULT_DATABASE_URL is not set");
  const host = new URL(url).hostname;

  log(`── designation catalogue ROLLBACK ──`);
  log(`   environment : ${args.environment}`);
  log(`   mode        : ${args.apply ? "APPLY" : "DRY RUN (no writes)"}`);
  log(`   db host     : ${host}`);

  if (args.expectedDbHost && !host.includes(args.expectedDbHost)) {
    throw new GuardError(`db host "${host}" does not contain expected "${args.expectedDbHost}" — refusing`);
  }
  if (args.expectedAppSha) {
    const res = await fetch(`${ENV_HOSTS[args.environment]}/api/version`, { signal: AbortSignal.timeout(20_000) });
    const body = (await res.json()) as { commit?: string };
    const live = body.commit ?? "";
    if (live !== args.expectedAppSha.slice(0, live.length)) {
      throw new GuardError(`${args.environment} is running ${live}, expected ${args.expectedAppSha} — refusing`);
    }
    log(`   app commit  : ${live} (matches)`);
  }

  const client = new pg.Client({ connectionString: url, ssl: sslFor(host) });
  await client.connect();
  try {
    // Certificates must still carry no designations — otherwise deleting a row
    // could orphan a stored code.
    const withDes = await client.query(
      `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0`
    );
    if (withDes.rows[0].n !== 0) {
      throw new GuardError(
        `${withDes.rows[0].n} certificate(s) now store designations — rollback could orphan a stored code. STOP and re-review.`
      );
    }

    const rows = (
      await client.query<CatalogueRow>(
        `SELECT id, category, value, label, abbreviation, aliases, description,
                sort_order, active, archived, allow_cross_category
           FROM catalogue_items WHERE category='designation' ORDER BY sort_order, id`
      )
    ).rows;

    const live = rows.filter((r) => r.active && !r.archived).map((r) => r.value).sort();
    const baseline = [...APPROVED_BASELINE_VALUES].sort();
    if (live.length === baseline.length && live.every((v, i) => v === baseline[i])) {
      log("");
      log("✔ already at the pre-reconciliation baseline — nothing to roll back (idempotent no-op).");
      return;
    }

    const actions: string[] = [];
    for (const v of PRE_EXISTING) {
      const r = rows.find((x) => x.value === v);
      if (r && (r.abbreviation ?? "") !== "") actions.push(`NULL abbreviation on "${v}" (was ${r.abbreviation})`);
    }
    for (const v of CREATED_BY_RECONCILIATION) {
      const r = rows.find((x) => x.value === v);
      if (r) actions.push(`DELETE created row "${v}" (id ${r.id})`);
    }
    for (const v of LEGACY_TO_ARCHIVE) {
      const r = rows.find((x) => x.value === v);
      if (r && r.archived) actions.push(`UN-ARCHIVE legacy row "${v}" (id ${r.id})`);
    }

    log("");
    log(`PLAN (${actions.length} actions):`);
    for (const a of actions) log(`   ${a}`);
    if (!actions.length) {
      log("   (nothing to do)");
      return;
    }
    if (!args.apply) {
      log("");
      log("DRY RUN — nothing was written.");
      return;
    }

    const actor = "ops:rollback-designation-catalogue";
    await client.query("BEGIN");
    try {
      for (const v of PRE_EXISTING) {
        await client.query(
          `UPDATE catalogue_items SET abbreviation = NULL, updated_by = $1, updated_at = now()
            WHERE category='designation' AND value = $2`,
          [actor, v]
        );
      }
      for (const v of CREATED_BY_RECONCILIATION) {
        const del = await client.query(
          `DELETE FROM catalogue_items WHERE category='designation' AND value = $1 RETURNING id`,
          [v]
        );
        if (del.rowCount > 1) throw new Error(`delete ${v} affected ${del.rowCount} rows`);
      }
      for (const v of LEGACY_TO_ARCHIVE) {
        await client.query(
          `UPDATE catalogue_items SET archived = FALSE, updated_by = $1, updated_at = now()
            WHERE category='designation' AND value = $2`,
          [actor, v]
        );
      }
      await client.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('catalogue_item','designation:*','catalogue_reconciliation_rollback',$1,$2::jsonb)`,
        [actor, JSON.stringify({ actions })]
      );

      const after = (
        await client.query(
          `SELECT value FROM catalogue_items WHERE category='designation' AND active AND NOT archived ORDER BY sort_order,id`
        )
      ).rows.map((r) => r.value).sort();
      if (after.length !== baseline.length || !after.every((v, i) => v === baseline[i])) {
        throw new Error(`post-rollback inventory is [${after.join(", ")}], expected [${baseline.join(", ")}]`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    log("");
    log(`✔ rolled back ${actions.length} actions in one transaction — baseline restored.`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /rollback-designation-catalogue/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof GuardError ? `\n🚫 REFUSED: ${msg}` : `\n❌ FAILED: ${msg}`);
    process.exit(1);
  });
}

export { main, GuardError, CREATED_BY_RECONCILIATION, PRE_EXISTING };
