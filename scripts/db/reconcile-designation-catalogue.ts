/**
 * reconcile-designation-catalogue.ts — one-shot, idempotent reconciliation of the
 * DB-backed designation catalogue to the canonical application contract.
 *
 * WHY THIS EXISTS
 * PR #259 switches the Card Details designation picker from the hard-coded
 * `DESIGNATION_OPTIONS` array to the DB-backed catalogue. The live catalogue was
 * seeded with lowercase internal values and no abbreviations, so the DB-backed
 * picker would present the wrong option set and persist codes that
 * `DESIGNATION_LABELS` (server/routes.ts) cannot resolve.
 *
 * SAFE TO RUN BEFORE THE DEPLOY. Pre-#259 `buildSnapshotFromRows` emits no
 * `designations` key and there is no `mapDesignationRow`, so the running
 * application does not read these rows at all. The change is INERT until #259
 * is deployed.
 *
 * SCOPE — writes `catalogue_items` ONLY. Never reads or writes certificates
 * (beyond a read-only safety count), grading, MVGS, Pristine/P10, centering,
 * labels, cert_counter, the schema, or the migration journal.
 *
 * USAGE
 *   # dry run (default — writes nothing)
 *   npx tsx scripts/db/reconcile-designation-catalogue.ts --environment production
 *
 *   # apply to production
 *   npx tsx scripts/db/reconcile-designation-catalogue.ts \
 *     --environment production --apply --confirm-production \
 *     --expected-app-sha e6c7c1394b2cedee9033be76df3b2a93d788b2b3 \
 *     --expected-db-host ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech
 *
 * MINTVAULT_DATABASE_URL supplies the connection. Its hostname must EXACTLY
 * equal the host configured for the selected environment. Credentials are never
 * printed and never appear in an error message.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { catalogueConflict } from "../../shared/catalogue-validate";
import {
  ENVIRONMENTS,
  GuardError,
  parseArgs,
  parseDbHostname,
  assertEnvironmentBinding,
  sslFor,
  normaliseSha,
  compareSha,
  CANONICAL_DESIGNATIONS,
  LEGACY_TO_ARCHIVE,
  RECONCILE_ACTOR,
  buildPlan,
  validatePostState,
  inventoryFingerprint,
  type CatalogueRow,
} from "./designation-catalogue-contract";

export * from "./designation-catalogue-contract";

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

/**
 * When a FULL 40-character SHA is supplied, confirm it end-to-end against git:
 * `/api/version` only publishes a short SHA, so HTTP alone cannot verify the
 * remainder. Returns null when git cannot be consulted (reported honestly).
 */
function verifyFullShaAgainstGit(fullSha: string, shortLen: number): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", `--short=${shortLen}`, `${fullSha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // ESM package — `__dirname` does not exist at runtime.
      cwd: dirname(fileURLToPath(import.meta.url)),
    }).trim();
    return out.toLowerCase();
  } catch {
    return null;
  }
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

  log(`── designation catalogue reconciliation ──`);
  log(`   environment : ${env.key}`);
  log(`   mode        : ${args.apply ? "APPLY" : "DRY RUN (no writes)"}`);
  log(`   db host     : ${host} (exact match for ${env.key})`);

  if (args.expectedAppSha) {
    if (!env.appBaseUrl) throw new GuardError(`--expected-app-sha is not valid for --environment ${env.key}`);
    const expected = normaliseSha(args.expectedAppSha);
    const live = await liveAppSha(env.appBaseUrl);
    const verdict = compareSha(expected, live);
    if (!verdict.ok) throw new GuardError(`${env.key}: ${verdict.message} — refusing`);
    if (!verdict.fullyVerified) {
      const short = verifyFullShaAgainstGit(expected, live.trim().length);
      if (short === null) {
        log(`   app commit  : ${live} — WARNING: only ${verdict.verifiedChars} of ${expected.length} chars verified (git unavailable)`);
      } else if (short !== live.trim().toLowerCase()) {
        throw new GuardError(`--expected-app-sha resolves to ${short} in git but ${env.key} is running ${live} — refusing`);
      } else {
        log(`   app commit  : ${live} (full SHA confirmed against git)`);
      }
    } else {
      log(`   app commit  : ${live} (${verdict.message})`);
    }
  }

  const client = new pg.Client({ connectionString: process.env.MINTVAULT_DATABASE_URL, ssl: sslFor(host) });
  await client.connect();

  try {
    const reg = await client.query(`SELECT to_regclass('public.catalogue_items')::text t`);
    if (!reg.rows[0].t) throw new GuardError("catalogue_items does not exist — apply migration 0019 first");

    const certSql = `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0`;
    const withDes = await client.query(certSql);
    const certTotal = await client.query(`SELECT count(*)::int n FROM certificates`);
    log(`   certificates: ${certTotal.rows[0].n} total, ${withDes.rows[0].n} with designations`);
    if (withDes.rows[0].n !== 0) {
      throw new GuardError(
        `${withDes.rows[0].n} certificate(s) already store a designation — this package is only approved for an empty-designation estate. STOP and re-review.`,
      );
    }

    const preflight = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows;
    const preflightPrint = inventoryFingerprint(preflight);

    log("");
    log("BEFORE — live designation rows:");
    for (const r of preflight.filter((x) => x.category === "designation" && x.active && !x.archived)) {
      log(`   ${r.value.padEnd(18)} abbr=${String(r.abbreviation)}  label=${JSON.stringify(r.label)}`);
    }

    const plan = buildPlan(preflight);
    if (plan.state === "unknown") throw new GuardError(plan.reason ?? "unknown catalogue state");
    if (plan.state === "reconciled") {
      log("");
      log("✔ already reconciled — nothing to do (idempotent no-op).");
      return;
    }

    const problems = validatePostState(preflight, catalogueConflict);
    if (problems.length) throw new GuardError(`post-state validation failed:\n   - ${problems.join("\n   - ")}`);

    log("");
    log(`PLAN (${plan.actions.length} actions):`);
    for (const a of plan.actions) {
      log(`   [${a.kind.toUpperCase().padEnd(7)}] ${a.detail}`);
      for (const d of a.drift ?? []) log(`             ${d.field}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
    }

    if (!args.apply) {
      log("");
      log("DRY RUN — nothing was written. Re-run with --apply (plus the required flags) to execute.");
      return;
    }

    // ── Apply: ONE SERIALIZABLE transaction ───────────────────────────────
    const auditRow = (action: string, value: string, details: unknown) =>
      client.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('catalogue_item', $1, $2, $3, $4::jsonb)`,
        [`designation:${value}`, action, RECONCILE_ACTOR, JSON.stringify(details)],
      );

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      // Lock every existing designation row for the duration of the write.
      // Rows that do not exist yet cannot be locked; SERIALIZABLE plus the
      // (category,value) unique index is what prevents a phantom insert.
      await client.query(`SELECT id FROM catalogue_items WHERE category = 'designation' FOR UPDATE`);

      // Re-assert EVERY critical precondition inside the transaction.
      const certIn = await client.query(certSql);
      if (certIn.rows[0].n !== 0) {
        throw new Error(`certificate designations appeared during the run (${certIn.rows[0].n}) — aborting`);
      }
      const locked = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows;
      if (inventoryFingerprint(locked) !== preflightPrint) {
        throw new Error("catalogue changed between preflight and transaction — aborting (no partial write)");
      }
      const lockedPlan = buildPlan(locked);
      if (lockedPlan.state !== "baseline" || lockedPlan.actions.length !== plan.actions.length) {
        throw new Error("plan diverged inside the transaction — aborting");
      }

      for (const a of lockedPlan.actions) {
        const spec = CANONICAL_DESIGNATIONS.find((d) => d.value === a.value);
        const before = locked.find((r) => r.category === "designation" && r.value === a.value) ?? null;

        if (a.kind === "update" && spec) {
          const upd = await client.query(
            `UPDATE catalogue_items
                SET abbreviation = $1, label = $2, description = $3, aliases = $4::jsonb,
                    allow_cross_category = $5, active = TRUE, archived = FALSE,
                    updated_by = $6, updated_at = now()
              WHERE category = 'designation' AND value = $7
              RETURNING *`,
            [spec.code, spec.label, spec.description, JSON.stringify(spec.aliases), spec.allowCrossCategory, RECONCILE_ACTOR, a.value],
          );
          if (upd.rowCount !== 1) throw new Error(`update ${a.value} affected ${upd.rowCount} rows`);
          await auditRow("catalogue_item_update", a.value, {
            oldValue: before, newValue: upd.rows[0], drift: a.drift,
            reason: "PR#259 canonical designation reconciliation", actor: RECONCILE_ACTOR,
          });
        } else if (a.kind === "create" && spec) {
          const ins = await client.query(
            `INSERT INTO catalogue_items
               (category, value, label, abbreviation, aliases, description, metadata,
                sort_order, active, archived, allow_cross_category, created_by, updated_by)
             VALUES ('designation', $1, $2, $3, $4::jsonb, $5, '{}'::jsonb,
                     (SELECT COALESCE(MAX(sort_order),-1)+1 FROM catalogue_items WHERE category='designation'),
                     TRUE, FALSE, $6, $7, $7)
             RETURNING *`,
            [spec.value, spec.label, spec.code, JSON.stringify(spec.aliases), spec.description, spec.allowCrossCategory, RECONCILE_ACTOR],
          );
          if (ins.rowCount !== 1) throw new Error(`create ${a.value} affected ${ins.rowCount} rows`);
          await auditRow("catalogue_item_create", a.value, {
            oldValue: null, newValue: ins.rows[0],
            reason: "PR#259 canonical designation reconciliation", actor: RECONCILE_ACTOR,
          });
        } else if (a.kind === "archive") {
          const arc = await client.query(
            `UPDATE catalogue_items SET archived = TRUE, updated_by = $1, updated_at = now()
              WHERE category = 'designation' AND value = $2 RETURNING *`,
            [RECONCILE_ACTOR, a.value],
          );
          if (arc.rowCount !== 1) throw new Error(`archive ${a.value} affected ${arc.rowCount} rows`);
          await auditRow("catalogue_item_update", a.value, {
            oldValue: before, newValue: arc.rows[0],
            reason: "archived — superseded by ERROR_MISCUT / test-only", actor: RECONCILE_ACTOR,
          });
        }
      }

      // ── Final in-transaction assertions before COMMIT ────────────────────
      const dupes = await client.query(
        `SELECT lower(coalesce(nullif(btrim(abbreviation),''),btrim(value))) code, count(*) n
           FROM catalogue_items
          WHERE active = TRUE AND archived = FALSE
            AND category IN ('designation','attribute')
            AND btrim(coalesce(nullif(btrim(abbreviation),''),btrim(value))) <> ''
          GROUP BY 1 HAVING count(*) > 1`,
      );
      if (dupes.rowCount !== 0) throw new Error(`duplicate live effective codes: ${JSON.stringify(dupes.rows)}`);

      const after = (await client.query<CatalogueRow>(`${SELECT_ROWS} ORDER BY category, sort_order, id`)).rows;
      const finalState = buildPlan(after);
      if (finalState.state !== "reconciled") {
        throw new Error(`post-write state is not "reconciled" (${finalState.state}: ${finalState.reason ?? ""})`);
      }
      const liveCount = after.filter((r) => r.category === "designation" && r.active && !r.archived).length;
      if (liveCount !== CANONICAL_DESIGNATIONS.length) {
        throw new Error(`expected ${CANONICAL_DESIGNATIONS.length} live designations, found ${liveCount}`);
      }
      const archivedCount = after.filter((r) => r.category === "designation" && r.archived).length;
      if (archivedCount !== LEGACY_TO_ARCHIVE.length) {
        throw new Error(`expected ${LEGACY_TO_ARCHIVE.length} archived legacy rows, found ${archivedCount}`);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const after = await client.query(
      `SELECT value, abbreviation, label FROM catalogue_items
        WHERE category='designation' AND active AND NOT archived ORDER BY sort_order, id`,
    );
    log("");
    log("AFTER — live designation rows:");
    for (const r of after.rows) log(`   ${String(r.value).padEnd(18)} abbr=${r.abbreviation}  label=${JSON.stringify(r.label)}`);
    log("");
    log(`✔ committed ${plan.actions.length} actions in one SERIALIZABLE transaction.`);
    log(`   next: rerun the migration 0026 duplicate-detection query, then apply 0026 with scripts/db/migrate.ts --apply`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /reconcile-designation-catalogue/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof GuardError ? `\n🚫 REFUSED: ${msg}` : `\n❌ FAILED: ${msg}`);
    process.exit(1);
  });
}

export { main };
