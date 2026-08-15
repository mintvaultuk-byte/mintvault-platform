/**
 * rollback-designation-catalogue.ts — exact inverse of
 * scripts/db/reconcile-designation-catalogue.ts.
 *
 * Restores the approved pre-reconciliation baseline:
 *   • the three pre-existing rows have their `abbreviation` set back to NULL;
 *   • the seven rows the reconciliation CREATED are deleted — and ONLY if every
 *     one of them still carries `created_by = 'ops:reconcile-designation-catalogue'`;
 *   • error / misprint / test_print are un-archived back to live.
 *
 * HOSTILE-REVIEW HIGH FIX — ownership protection. The previous version deleted
 * by (category, value) alone, so a human-created row that happened to share a
 * canonical value (e.g. someone had already added a `promo` designation) would
 * be destroyed. Every target is now inspected BEFORE any write, and a single
 * unowned row aborts the entire rollback with nothing written.
 *
 * Unrelated catalogue rows are never touched. Certificates are never written.
 *
 * USAGE
 *   npx tsx scripts/db/rollback-designation-catalogue.ts --environment production
 *   npx tsx scripts/db/rollback-designation-catalogue.ts \
 *     --environment production --apply --confirm-production \
 *     --expected-app-sha <sha> \
 *     --expected-db-host ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech
 */
import pg from "pg";
import {
  ENVIRONMENTS,
  GuardError,
  parseArgs,
  parseDbHostname,
  assertEnvironmentBinding,
  sslFor,
  normaliseSha,
  compareSha,
  APPROVED_BASELINE_VALUES,
  LEGACY_TO_ARCHIVE,
  CREATED_BY_RECONCILIATION,
  PRE_EXISTING_CANONICAL,
  RECONCILE_ACTOR,
  ROLLBACK_ACTOR,
  inventoryFingerprint,
  type CatalogueRow,
} from "./designation-catalogue-contract";

const SELECT_ROWS = `
  SELECT id, category, value, label, abbreviation, aliases, description,
         sort_order, active, archived, allow_cross_category, created_by
    FROM catalogue_items`;

async function liveAppSha(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new GuardError(`could not read ${baseUrl}/api/version (HTTP ${res.status})`);
  const body = (await res.json()) as { commit?: string };
  if (!body.commit) throw new GuardError(`${baseUrl}/api/version returned no commit`);
  return body.commit;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string) => console.log(s);

  if (!args.environment) throw new GuardError(`--environment is required (${Object.keys(ENVIRONMENTS).join(", ")})`);

  const host = parseDbHostname(process.env.MINTVAULT_DATABASE_URL);
  const env = assertEnvironmentBinding(args.environment, host, args.expectedDbHost);

  if (args.apply && env.requiresProductionConfirmation && !args.confirmProduction) {
    throw new GuardError("--confirm-production is required to apply to production");
  }
  if (args.apply && !args.expectedDbHost) throw new GuardError("--expected-db-host is required with --apply");
  if (args.apply && env.appBaseUrl && !args.expectedAppSha) {
    throw new GuardError("--expected-app-sha is required with --apply");
  }

  log(`── designation catalogue ROLLBACK ──`);
  log(`   environment : ${env.key}`);
  log(`   mode        : ${args.apply ? "APPLY" : "DRY RUN (no writes)"}`);
  log(`   db host     : ${host} (exact match for ${env.key})`);

  if (args.expectedAppSha) {
    if (!env.appBaseUrl) throw new GuardError(`--expected-app-sha is not valid for --environment ${env.key}`);
    const expected = normaliseSha(args.expectedAppSha);
    const live = await liveAppSha(env.appBaseUrl);
    const verdict = compareSha(expected, live);
    if (!verdict.ok) throw new GuardError(`${env.key}: ${verdict.message} — refusing`);
    log(`   app commit  : ${live} (${verdict.message})`);
  }

  const client = new pg.Client({ connectionString: process.env.MINTVAULT_DATABASE_URL, ssl: sslFor(host) });
  await client.connect();
  try {
    const certSql = `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0`;
    const withDes = await client.query(certSql);
    if (withDes.rows[0].n !== 0) {
      throw new GuardError(
        `${withDes.rows[0].n} certificate(s) now store designations — rollback could orphan a stored code. STOP and re-review.`,
      );
    }

    const preflight = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows;
    const preflightPrint = inventoryFingerprint(preflight);
    const desig = preflight.filter((r) => r.category === "designation");

    const live = desig.filter((r) => r.active && !r.archived).map((r) => r.value).sort();
    const baseline = [...APPROVED_BASELINE_VALUES].sort();
    if (live.length === baseline.length && live.every((v, i) => v === baseline[i]) &&
        desig.every((r) => (r.abbreviation ?? "") === "" && !r.archived)) {
      log("");
      log("✔ already at the pre-reconciliation baseline — nothing to roll back (idempotent no-op).");
      return;
    }

    // ── OWNERSHIP GATE: inspect every delete target BEFORE any write ───────
    const unowned: string[] = [];
    const toDelete: CatalogueRow[] = [];
    for (const v of CREATED_BY_RECONCILIATION) {
      const row = desig.find((r) => r.value === v);
      if (!row) continue;
      if (row.created_by !== RECONCILE_ACTOR) {
        unowned.push(`${v} (id ${row.id}, created_by=${JSON.stringify(row.created_by)})`);
      } else {
        toDelete.push(row);
      }
    }
    if (unowned.length > 0) {
      throw new GuardError(
        `refusing to roll back — designation row(s) exist that this package did not create:\n` +
          unowned.map((u) => `   • ${u}`).join("\n") +
          `\n   Only rows with created_by="${RECONCILE_ACTOR}" may be deleted. Nothing was written.`,
      );
    }

    const actions: string[] = [];
    for (const v of PRE_EXISTING_CANONICAL) {
      const r = desig.find((x) => x.value === v);
      if (r && (r.abbreviation ?? "") !== "") actions.push(`NULL abbreviation on "${v}" (was ${r.abbreviation})`);
    }
    for (const r of toDelete) actions.push(`DELETE created row "${r.value}" (id ${r.id}, created_by=${r.created_by})`);
    for (const v of LEGACY_TO_ARCHIVE) {
      const r = desig.find((x) => x.value === v);
      if (r && r.archived) actions.push(`UN-ARCHIVE legacy row "${v}" (id ${r.id})`);
    }

    log("");
    log(`PLAN (${actions.length} actions):`);
    for (const a of actions) log(`   ${a}`);
    if (!actions.length) { log("   (nothing to do)"); return; }
    if (!args.apply) { log(""); log("DRY RUN — nothing was written."); return; }

    const auditRow = (action: string, value: string, details: unknown) =>
      client.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('catalogue_item', $1, $2, $3, $4::jsonb)`,
        [`designation:${value}`, action, ROLLBACK_ACTOR, JSON.stringify(details)],
      );

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await client.query(`SELECT id FROM catalogue_items WHERE category = 'designation' FOR UPDATE`);

      const certIn = await client.query(certSql);
      if (certIn.rows[0].n !== 0) throw new Error(`certificate designations appeared during the run — aborting`);

      const locked = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows;
      if (inventoryFingerprint(locked) !== preflightPrint) {
        throw new Error("catalogue changed between preflight and transaction — aborting (no partial write)");
      }
      // Re-assert ownership under lock.
      for (const v of CREATED_BY_RECONCILIATION) {
        const row = locked.find((r) => r.category === "designation" && r.value === v);
        if (row && row.created_by !== RECONCILE_ACTOR) {
          throw new Error(`row "${v}" is not owned by this package (created_by=${row.created_by}) — aborting`);
        }
      }

      for (const v of PRE_EXISTING_CANONICAL) {
        const before = locked.find((r) => r.category === "designation" && r.value === v);
        if (!before || (before.abbreviation ?? "") === "") continue;
        const upd = await client.query(
          `UPDATE catalogue_items SET abbreviation = NULL, updated_by = $1, updated_at = now()
            WHERE category='designation' AND value = $2 RETURNING *`,
          [ROLLBACK_ACTOR, v],
        );
        if (upd.rowCount !== 1) throw new Error(`abbreviation reset on ${v} affected ${upd.rowCount} rows`);
        await auditRow("catalogue_item_update", v, {
          oldValue: before, newValue: upd.rows[0],
          reason: "rollback — restore pre-reconciliation abbreviation", actor: ROLLBACK_ACTOR,
        });
      }

      for (const v of CREATED_BY_RECONCILIATION) {
        const before = locked.find((r) => r.category === "designation" && r.value === v);
        if (!before) continue;
        const del = await client.query(
          `DELETE FROM catalogue_items
            WHERE category='designation' AND value = $1 AND created_by = $2 RETURNING *`,
          [v, RECONCILE_ACTOR],
        );
        if (del.rowCount !== 1) throw new Error(`delete ${v} affected ${del.rowCount} rows (ownership guard)`);
        await auditRow("catalogue_item_delete", v, {
          oldValue: before, newValue: null,
          reason: "rollback — removing row created by the reconciliation", actor: ROLLBACK_ACTOR,
        });
      }

      for (const v of LEGACY_TO_ARCHIVE) {
        const before = locked.find((r) => r.category === "designation" && r.value === v);
        if (!before || !before.archived) continue;
        const upd = await client.query(
          `UPDATE catalogue_items SET archived = FALSE, updated_by = $1, updated_at = now()
            WHERE category='designation' AND value = $2 RETURNING *`,
          [ROLLBACK_ACTOR, v],
        );
        if (upd.rowCount !== 1) throw new Error(`un-archive ${v} affected ${upd.rowCount} rows`);
        await auditRow("catalogue_item_update", v, {
          oldValue: before, newValue: upd.rows[0],
          reason: "rollback — restoring legacy row to live", actor: ROLLBACK_ACTOR,
        });
      }

      const after = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows
        .filter((r) => r.category === "designation");
      const finalLive = after.filter((r) => r.active && !r.archived).map((r) => r.value).sort();
      if (finalLive.length !== baseline.length || !finalLive.every((v, i) => v === baseline[i])) {
        throw new Error(`post-rollback inventory is [${finalLive.join(", ")}], expected [${baseline.join(", ")}]`);
      }
      if (after.some((r) => (r.abbreviation ?? "") !== "")) {
        throw new Error("post-rollback rows still carry an abbreviation — aborting");
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    log("");
    log(`✔ rolled back ${actions.length} actions in one SERIALIZABLE transaction — baseline restored.`);
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

export { main };
