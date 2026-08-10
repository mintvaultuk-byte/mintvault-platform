/**
 * ROLLBACK + GUARD INTEGRITY — the suite that stops the next rollback shipping without a journal
 * delete, and the behavioural proof for the 0047-0056 security repairs.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================================
 * Two BLOCKERS motivated it, and both were invisible to every existing test:
 *
 *   1. rollback-0047 and rollback-0048 returned the database to the pre-repair, EXPOSED state
 *      while leaving their own row in schema_migrations. scripts/db/migrate.ts:planMigrations
 *      classifies a file as alreadyApplied on the PRESENCE of that row alone (migrate.ts:449-462 —
 *      it consults row.status and row.checksum and never looks at the database), so the runner
 *      reported the migration applied and REFUSED to re-apply it. A HIGH tenant-isolation hole,
 *      wide open, behind a green migration status.
 *
 *   2. rollback-0050 had no journal reference at all, so its row was IMMORTAL — and because
 *      rollback-0047/0048/0049 each refuse while any journal row numbered above their own exists,
 *      that one orphan row made all three PERMANENTLY unrunnable. Recovery required hand-editing
 *      schema_migrations, which is exactly what the journal exists to prevent.
 *
 * A test that checked only "the rollback reverted the schema" would have passed for both. So the
 * round-trip below asserts FOUR things per rollback, in order, and the journal step is the one
 * that was missing:
 *
 *      applied      -> the attack is REFUSED
 *      rollback     -> the attack SUCCEEDS  *and* the journal row count is 0
 *      runner runs  -> the migration is re-applied UNPROMPTED
 *      re-applied   -> the attack is REFUSED again
 *
 * ============================================================================================
 * THE ROLE MODEL IS LOAD-BEARING
 * ============================================================================================
 * Every attack runs as a genuinely restricted role, and assertRestricted() re-proves
 * rolsuper=false / rolbypassrls=false / is_superuser=off / row_security=on IMMEDIATELY BEFORE each
 * claim rather than once in beforeAll. That is not ceremony: the 0047 finding this suite covers is
 * precisely a migration that passed all of its own assertions while partner_runtime was BYPASSRLS,
 * so "the probe ran against a role that could not have failed" is the exact failure mode in scope.
 *
 * `SET ROLE` from the superuser connection is the established pattern in
 * tests/partner-rls-isolation.test.ts and is equivalent for this purpose: SET ROLE to a
 * non-superuser drops superuser status for every privilege check, is_superuser reports off, and
 * RLS is evaluated against current_user. The runtime roles are NOLOGIN by design (0001:16,
 * 0008:23-24), so connecting as them is not an option that exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  migratorUrlFrom,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  applyEveryMigrationRealistic,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, listMigrationFiles, planMigrations } from "../scripts/db/migrate";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const rbSql = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), "utf8");

let cluster: DisposablePostgres17;
let admin: Client;

/** Two throwaway tenants. Everything below is seeded for both so a leak is visible as a count. */
const A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const LOC_A = "aaaaaaaa-1111-1111-1111-aaaaaaaa0001";
const LOC_B = "bbbbbbbb-2222-2222-2222-bbbbbbbb0001";

const WALLET_A = "aaaaaaaa-1111-1111-1111-aaaaaaaa0003";
const FP = "a".repeat(64);

/**
 * THE pg_temp CLASS SWEEP — the same query 0055's post-flight runs, kept here so it executes on
 * EVERY CI pass rather than once at migration time. A migration assertion fires when the migration
 * is applied and never again; that is a checkpoint, not a ratchet, and the whole point of MEDIUM-5
 * is that 0048 fixed one instance of this class and nothing stopped it regrowing.
 *
 * Any plpgsql/sql function in `public` with NO pinned search_path (proconfig IS NULL) that reads a
 * relation UNQUALIFIED can be shadowed via pg_temp by anyone who can CREATE TEMP TABLE — a default
 * PUBLIC privilege on the database.
 *
 * `old` and `new` are excluded because `IS DISTINCT FROM OLD.x` matches a naive FROM regex without
 * being a relation reference at all. Four of the five hits in the first run of this sweep were
 * exactly that, and a sweep that cries wolf is one that gets an exclusion list bolted onto it.
 */
const UNPINNED_FUNCTION_SWEEP = `
  SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND l.lanname IN ('plpgsql', 'sql')
     AND p.proconfig IS NULL
     AND EXISTS (
       SELECT 1
         FROM regexp_matches(p.prosrc, '(?:from|join)\\s+([a-z_][a-z0-9_]*)', 'gi') AS m
        WHERE lower(m[1]) NOT IN ('old', 'new')
     )
   ORDER BY p.proname`;

// =============================================================================================
// Helpers
// =============================================================================================

/**
 * Run `fn` with current_user switched to `role` and app.tenant_id set to `tenant`, having first
 * PROVEN the role cannot pass the probe vacuously. Restores the session in a finally — this
 * connection is shared, and a leaked SET ROLE would silently weaken every later assertion.
 */
async function asRole(role: string, tenant: string | null, fn: () => Promise<void>): Promise<void> {
  await admin.query(`SET ROLE ${role}`);
  try {
    const { rows } = await admin.query<{
      who: string;
      bypass: boolean;
      su: boolean;
      is_su: string;
      rs: string;
    }>(
      `SELECT current_user AS who,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
              (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS su,
              current_setting('is_superuser') AS is_su,
              current_setting('row_security') AS rs`
    );
    // Guard the guard. A probe against a role that ignores privileges or policies proves nothing,
    // and that is the exact defect 0047's own post-flight had.
    expect(rows[0].who).toBe(role);
    expect(rows[0].bypass).toBe(false);
    expect(rows[0].su).toBe(false);
    expect(rows[0].is_su).toBe("off");
    expect(rows[0].rs).toBe("on");

    if (tenant === null) await admin.query("RESET app.tenant_id");
    else await admin.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);

    await fn();
  } finally {
    await admin.query("RESET ROLE").catch(() => {});
    await admin.query("RESET app.tenant_id").catch(() => {});
  }
}

/** Run a statement and report whether it was permitted, without letting it persist. */
async function attempt(sql: string, params: unknown[] = []): Promise<{ ok: boolean; rows: number; error?: string }> {
  await admin.query("BEGIN");
  try {
    const r = await admin.query(sql, params);
    await admin.query("ROLLBACK");
    return { ok: true, rows: r.rowCount ?? 0 };
  } catch (e) {
    await admin.query("ROLLBACK").catch(() => {});
    return { ok: false, rows: 0, error: (e as Error).message };
  }
}

async function journalRows(filename: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int n FROM schema_migrations WHERE filename = $1",
    [filename]
  );
  return rows[0].n;
}

/**
 * Execute a rollback file the way an operator does. Every one of these files carries its own
 * BEGIN/COMMIT, so a RAISE inside leaves this shared connection sitting in an ABORTED transaction —
 * which then makes every later assertion fail with a misleading "current transaction is aborted"
 * instead of the real refusal message. Clear it before rethrowing.
 */
async function runRollback(file: string): Promise<void> {
  try {
    await admin.query(rbSql(file));
  } catch (e) {
    await admin.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Re-run the real runner, exactly as a deploy would — no arguments naming what to re-apply. */
async function runRunnerUnprompted(): Promise<void> {
  const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
  await migrator.connect();
  try {
    await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    try {
      await applyMigrations(migrator, listMigrationFiles(), { allowDestructive: true });
    } finally {
      await migrator.query("REVOKE partner_credit_lifecycle_definer FROM pn_migrator").catch(() => {});
    }
  } finally {
    await migrator.end();
  }
}

/** What the real runner would do next, with no side effects. */
async function pendingPerRunner(): Promise<string[]> {
  const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
  await migrator.connect();
  try {
    return (await planMigrations(migrator, listMigrationFiles())).pending;
  } finally {
    await migrator.end();
  }
}

// =============================================================================================
// The round-trip table
// =============================================================================================

/**
 * One entry per numbered rollback in this release series.
 *
 * `probe()` returns a short STATE STRING rather than a boolean, so a failure names what it saw
 * instead of just "expected true, got false" — and so the same function proves both directions.
 * `whenApplied` is the safe state; `whenRolledBack` is the reopened hole. Asserting BOTH is what
 * stops a probe that always returns the safe answer from passing vacuously.
 */
interface RoundTrip {
  number: number;
  migration: string;
  rollback: string;
  /**
   * Whether this rollback can be run ON ITS OWN against a fully-migrated database.
   *
   * FALSE means the file carries a `left(filename,4)::integer > N` refusal because something later
   * genuinely depends on it — rollback-0047/0048/0049 (0049 DROPs a table) and rollback-0052 (0056
   * redefines the policies it restores). Those are covered ONLY by the descending sequence, which
   * is the supported recovery order for them. Marking them standalone would not test more, it would
   * test the refusal firing and call it a failure.
   */
  standalone: boolean;
  /** The hole, in one line, for the failure message. */
  hole: string;
  probe: () => Promise<string>;
  whenApplied: string;
  whenRolledBack: string;
}

const ROUND_TRIPS: RoundTrip[] = [
  {
    number: 47,
    standalone: false,
    migration: "0047_partner_owner_invariant_tenants_rls.sql",
    rollback: "rollback-0047-partner-owner-invariant-tenants-rls.sql",
    hole: "A8-F1 — partner_owner_invariant_tenants enumerates every tenant UUID on the network",
    whenApplied: "isolated:1",
    whenRolledBack: "leak:2",
    probe: async () => {
      let out = "";
      await asRole("partner_runtime", A, async () => {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int n FROM partner_owner_invariant_tenants"
        );
        out = rows[0].n > 1 ? `leak:${rows[0].n}` : `isolated:${rows[0].n}`;
      });
      return out;
    },
  },
  {
    number: 48,
    standalone: false,
    migration: "0048_partner_location_snapshot_search_path.sql",
    rollback: "rollback-0048-partner-location-snapshot-search-path.sql",
    hole: "A8-F2 — the location-snapshot trigger resolves partner_locations from pg_temp",
    whenApplied: "pinned",
    whenRolledBack: "shadowable",
    probe: async () => {
      const { rows } = await admin.query<{ cfg: string[] | null; src: string }>(
        `SELECT p.proconfig AS cfg, p.prosrc AS src
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='partner_submissions_capture_location_snapshot'`
      );
      const pinned = rows[0].cfg !== null && rows[0].cfg.some((c) => c.startsWith("search_path="));
      const qualified = /from\s+public\.partner_locations/i.test(rows[0].src);
      return pinned && qualified ? "pinned" : "shadowable";
    },
  },
  {
    number: 49,
    standalone: false,
    migration: "0049_partner_grading_work_items.sql",
    rollback: "rollback-0049-partner-grading-work-items.sql",
    hole: "the per-card grading provenance bridge is absent, so partner cards cannot be traced to certificates",
    whenApplied: "bridge_present",
    whenRolledBack: "bridge_absent",
    probe: async () => {
      const { rows } = await admin.query<{ r: string | null }>(
        "SELECT to_regclass('public.partner_grading_work_items')::text AS r"
      );
      return rows[0].r === null ? "bridge_absent" : "bridge_present";
    },
  },
  {
    number: 50,
    standalone: true,
    migration: "0050_partner_connector_profile_read.sql",
    rollback: "rollback-0050-partner-connector-profile-read.sql",
    hole: "the connector cannot read the approved trading name, so every partner import aborts 42501",
    whenApplied: "import_works",
    whenRolledBack: "import_42501",
    probe: async () => {
      let out = "";
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt("SELECT trading_name FROM partner_profiles WHERE tenant_id = $1", [A]);
        out = r.ok ? "import_works" : "import_42501";
      });
      return out;
    },
  },
  {
    number: 51,
    standalone: true,
    migration: "0051_partner_runtime_flag_control_least_privilege.sql",
    rollback: "rollback-0051-partner-runtime-flag-control-least-privilege.sql",
    hole: "partner_runtime can DELETE the platform-global feature-flag kill switches",
    whenApplied: "killswitch_safe",
    whenRolledBack: "killswitch_deletable",
    probe: async () => {
      let out = "";
      await asRole("partner_runtime", A, async () => {
        const r = await attempt(
          "DELETE FROM partner_feature_flags WHERE flag = 'partner_emergency_stop' AND tenant_id IS NULL"
        );
        out = r.ok && r.rows > 0 ? "killswitch_deletable" : "killswitch_safe";
      });
      return out;
    },
  },
  {
    number: 52,
    standalone: false,
    migration: "0052_partner_internal_evidence_rls.sql",
    rollback: "rollback-0052-partner-internal-evidence-rls.sql",
    hole: "partner_connector_runtime reads every tenant's HQ internal notes with no row filter",
    whenApplied: "notes_unreachable",
    whenRolledBack: "notes_all_tenants",
    probe: async () => {
      let out = "";
      await asRole("partner_connector_runtime", A, async () => {
        // No tenant GUC would be the harsher probe; A is set, so a tenant-scoped result would be 1.
        // Seeing BOTH tenants is the finding: no RLS at all.
        await admin.query("BEGIN");
        try {
          const r = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_internal_notes");
          out = r.rows[0].n >= 2 ? "notes_all_tenants" : `notes_scoped:${r.rows[0].n}`;
        } catch {
          out = "notes_unreachable";
        } finally {
          await admin.query("ROLLBACK").catch(() => {});
        }
      });
      return out;
    },
  },
  {
    // 0053 was absent from this list, and its absence was not cosmetic: the descending sequence
    // rolled 0056 -> 0055 -> 0054 and then hit rollback-0052, which correctly REFUSED because
    // 0053's journal row was still there ("1 later migration journal row(s) exist"). That bricked
    // the descent, and because the descent runs before the 0054/0055 attack blocks, every one of
    // those then ran against a database whose guards had already been rolled back — which is why
    // the allocator and pg_temp attacks read as "permitted". One missing entry, eight red tests.
    //
    // 0053 adds two additive columns to partner_users, so its observable hole is the columns
    // themselves rather than a privilege: the MFA lockout has nowhere to record state without them.
    number: 53,
    // Not standalone: 0054/0055/0056 sit above it and rollback-0053 refuses while any later
    // journal row exists. Descending order is its supported recovery path, same as 0047-0049/0052.
    standalone: false,
    migration: "0053_partner_mfa_failure_lockout.sql",
    rollback: "rollback-0053-partner-mfa-failure-lockout.sql",
    hole: "the MFA brute-force lockout has no columns to count failures or hold a lock in",
    whenApplied: "lockout_columns_present",
    whenRolledBack: "lockout_columns_absent",
    probe: async () => {
      const r = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'partner_users'
            AND column_name IN ('failed_mfa_count', 'mfa_locked_until')`
      );
      return r.rows[0].n === 2 ? "lockout_columns_present" : "lockout_columns_absent";
    },
  },
  {
    number: 54,
    standalone: true,
    migration: "0054_cert_counter_monotonic_allocator.sql",
    rollback: "rollback-0054-cert-counter-monotonic-allocator.sql",
    hole: "A8-F5 — the platform-wide certificate-number allocator can be re-seeded to 0",
    whenApplied: "allocator_monotonic",
    whenRolledBack: "allocator_reseedable",
    probe: async () => {
      let out = "";
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt("UPDATE cert_counter SET last_issued = 0, updated_at = NOW() WHERE id = 1");
        out = r.ok && r.rows > 0 ? "allocator_reseedable" : "allocator_monotonic";
      });
      return out;
    },
  },
  {
    number: 55,
    standalone: true,
    migration: "0055_partner_ledger_preserve_search_path.sql",
    rollback: "rollback-0055-partner-ledger-preserve-search-path.sql",
    hole: "the credit-ledger underfunding guard resolves its three reads from pg_temp",
    whenApplied: "pinned",
    whenRolledBack: "shadowable",
    probe: async () => {
      const { rows } = await admin.query<{ cfg: string[] | null; src: string }>(
        `SELECT p.proconfig AS cfg, p.prosrc AS src
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='partner_credit_ledger_preserve_active_reservations'`
      );
      const pinned = rows[0].cfg !== null && rows[0].cfg.some((c) => c.startsWith("search_path="));
      const qualified = !/from\s+partner_(wallets|credit_ledger|credit_reservations)/i.test(rows[0].src);
      return pinned && qualified ? "pinned" : "shadowable";
    },
  },
  {
    number: 56,
    standalone: true,
    migration: "0056_partner_hq_control_tables_write_deny.sql",
    rollback: "rollback-0056-partner-hq-control-tables-write-deny.sql",
    hole: "a tenant-equality policy on cmd=ALL admits HQ evidence rows into DELETE's USING clause",
    whenApplied: "write_denied",
    whenRolledBack: "write_admitted",
    probe: async () => {
      // Policy-level probe: does ANY non-SELECT policy on the three tables admit a row?
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_policies
          WHERE schemaname='public'
            AND tablename IN ('partner_emergency_controls','partner_internal_notes','partner_management_audit')
            AND cmd <> 'SELECT' AND (qual IS NULL OR qual <> 'false')`
      );
      return rows[0].n === 0 ? "write_denied" : "write_admitted";
    },
  },
  {
    number: 57,
    standalone: true,
    migration: "0057_partner_credits_purchase_permission.sql",
    rollback: "rollback-0057-partner-credits-purchase-permission.sql",
    hole: "without the permission row, no role can be granted spending authority at all",
    whenApplied: "purchase_seeded",
    whenRolledBack: "purchase_absent",
    // MUST be listed here, not merely de-journalled elsewhere: this suite applies the FULL
    // migration set, and every rollback from 0052 downward refuses while ANY higher-numbered
    // journal row survives. A newest migration missing from this table does not just skip its own
    // round trip — it bricks the entire descending sequence beneath it, which is exactly the
    // BLOCKER-2 shape the sequence test exists to catch.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM partner_permissions WHERE code = 'partner.credits.purchase'`
      );
      return rows[0].n === 1 ? "purchase_seeded" : "purchase_absent";
    },
  },
  {
    number: 58,
    // Not standalone: 0059 and 0060 sit above it and add columns to partner_public_listings, so
    // rollback-0058 now refuses while either is journalled. Its DROP TABLE would otherwise take
    // their columns with it while they stayed journalled as applied — a half-rolled-back estate
    // reporting green.
    standalone: false,
    migration: "0058_partner_public_network.sql",
    rollback: "rollback-0058-partner-public-network.sql",
    hole: "without the public listing tables there is no shop finder, no public shop profile and nowhere to persist a quality rating",
    whenApplied: "public_network_present",
    whenRolledBack: "public_network_absent",
    // Same reasoning as 0057 above: 0058 is now the newest migration, so the descending sequence
    // starts here. Its rollback runs on an estate with no listings (the suite never seeds one), so
    // the data-loss opt-in guard in rollback-0058 stays dormant and the file proceeds unprompted —
    // which is what this round trip requires.
    //
    // The probe deliberately checks the TRIGGER FUNCTION as well as the table. DROP TABLE removes
    // a trigger but leaves its function behind, and a stranded plpgsql function in `public` is
    // exactly what the unpinned-function class sweep in this file goes red on. Probing the table
    // alone would report a clean rollback while leaving that residue.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM pg_class
             WHERE relnamespace='public'::regnamespace
               AND relname IN ('partner_public_listings','partner_public_rating_snapshots','partner_public_rating_overrides'))
           + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='partner_public_listing_transition_guard')
         )::int n`
      );
      return rows[0].n === 0 ? "public_network_absent" : "public_network_present";
    },
  },
  {
    number: 59,
    // Not standalone: 0060 sits above it and rollback-0059 refuses while it is journalled.
    standalone: false,
    migration: "0059_partner_public_eligibility_propagation.sql",
    rollback: "rollback-0059-partner-public-eligibility-propagation.sql",
    hole: "a suspended or revoked organisation stays publicly advertised on the shop finder, because listing_status is the only public gate",
    whenApplied: "eligibility_propagation_present",
    whenRolledBack: "eligibility_propagation_absent",
    // 0059 is now the newest migration, so the descending sequence starts here rather than at 0058.
    //
    // The probe counts COLUMNS ONLY, deliberately. An earlier revision also counted the three
    // propagation functions — but a function survives DROP TABLE, so when rollback-0058 removed
    // partner_public_listings underneath this migration the probe still reported "present" and the
    // round trip passed with the columns gone. Counting anything that outlives the table it
    // belongs to is how a probe lies.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name='partner_public_listings'
               AND column_name IN ('org_status','location_status'))
         )::int n`
      );
      return rows[0].n === 0 ? "eligibility_propagation_absent" : "eligibility_propagation_present";
    },
  },
  {
    number: 60,
    // Not standalone: 0061 sits above it and rollback-0060 would otherwise run underneath it.
    standalone: false,
    migration: "0060_partner_public_rating_override_expiry.sql",
    rollback: "rollback-0060-partner-public-rating-override-expiry.sql",
    hole: "an expired rating override keeps being published indefinitely, because expires_at is only read during a manual recalculation",
    whenApplied: "override_expiry_present",
    whenRolledBack: "override_expiry_absent",
    // 0060 is now the newest migration, so the descending sequence starts here.
    //
    // The probe checks the COLUMNS and the partial index. It deliberately also asserts the override
    // TABLE survives: this rollback must never touch partner_public_rating_overrides, because the
    // reason/actor/expiry history is the audit trail for every exception a Super Admin ever granted.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name='partner_public_listings'
               AND column_name IN ('current_override_expires_at','current_computed_public_rating',
                                   'current_computed_rating_label','current_computed_rating_available',
                                   'current_computed_rating_version'))
           + (SELECT count(*) FROM pg_indexes
               WHERE schemaname='public' AND indexname='idx_partner_public_listings_override_expiry')
         )::int n`
      );
      return rows[0].n === 0 ? "override_expiry_absent" : "override_expiry_present";
    },
  },
  {
    number: 61,
    // Not standalone: 0062 sits above it.
    standalone: false,
    migration: "0061_partner_public_reader.sql",
    rollback: "rollback-0061-partner-public-reader.sql",
    hole: "anonymous shop finder and public profile traffic runs on the BYPASSRLS admin pool, which also falls back to the full MintVault connection",
    whenApplied: "public_reader_present",
    whenRolledBack: "public_reader_absent",
    // 0061 is now the newest migration, so the descending sequence starts here.
    //
    // The probe counts the VIEWS only. The ROLE deliberately survives a rollback — it is
    // cluster-wide, so dropping it would reach outside this database — and rollback-0061 renders it
    // inert by revoking instead. Counting the role here would therefore report "still applied"
    // forever and the round trip could never go green.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM pg_class
               WHERE relnamespace='public'::regnamespace AND relkind='v'
                 AND relname IN ('partner_public_shop_projection','partner_public_card_projection'))
         )::int n`
      );
      return rows[0].n === 0 ? "public_reader_absent" : "public_reader_present";
    },
  },
  {
    number: 63,
    standalone: false,
    migration: "0063_certificate_review_lifecycle_clock.sql",
    rollback: "rollback-0063-certificate-review-lifecycle-clock.sql",
    hole: "the 180-day rating window dates an abandoned unit from its CONNECTOR IMPORT, so a shop can import a batch, grade it badly months later and have the bad evidence already outside the window",
    whenApplied: "review_clock_present",
    whenRolledBack: "review_clock_absent",
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='certificates'
                    AND column_name IN ('review_entered_at','status_updated_at'))::int n`
      );
      return rows[0].n === 0 ? "review_clock_absent" : "review_clock_present";
    },
  },
  {
    number: 64,
    standalone: false,
    migration: "0064_public_slab_image_projection.sql",
    rollback: "rollback-0064-public-slab-image-projection.sql",
    hole: "the anonymous slab-image proxy resolves certificates on the owner, BYPASSRLS, unbounded main pool",
    whenApplied: "slab_projection_present",
    whenRolledBack: "slab_projection_absent",
    // Counts the view AND the reader's grant on it: dropping the view while leaving a grant, or
    // leaving the view while revoking the grant, are both half-states the route cannot survive.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM pg_class
             WHERE relnamespace='public'::regnamespace AND relkind='v'
               AND relname = 'public_slab_image_projection')
           + (SELECT count(*) FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='public_slab_image_projection'
                 AND grantee='partner_public_reader' AND privilege_type='SELECT')
         )::int n`
      );
      return rows[0].n === 0 ? "slab_projection_absent" : "slab_projection_present";
    },
  },
  {
    number: 65,
    standalone: false,
    migration: "0065_certificates_reviewed_unit_index.sql",
    rollback: "rollback-0065-certificates-reviewed-unit-index.sql",
    hole: "the rating measurement seq-scans certificates, because 0058's partial index excludes exactly the abandoned units V2 added",
    whenApplied: "reviewed_index_present",
    whenRolledBack: "reviewed_index_absent",
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_certificates_origin_location_reviewed')::int n`
      );
      return rows[0].n === 0 ? "reviewed_index_absent" : "reviewed_index_present";
    },
  },
  {
    number: 66,
    standalone: false,
    migration: "0066_partner_rating_lifecycle_hardening.sql",
    rollback: "rollback-0066-partner-rating-lifecycle-hardening.sql",
    hole: "mark-clean erases a quality event that lands mid-calculation, two reconcilers claim the same listing, a poisoned row starves every healthy one, a new shop is born clean, and a clock-only window change never refreshes",
    whenApplied: "rating_lifecycle_hardening_present",
    whenRolledBack: "rating_lifecycle_hardening_absent",
    // Columns AND the born-dirty trigger AND the generations CHECK AND both indexes. Each is a
    // separate defect: dropping the columns but leaving the trigger would break every INSERT.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name='partner_public_listings'
               AND column_name IN ('rating_dirty_generation','rating_clean_generation',
                                   'rating_next_attempt_at','rating_next_recalc_at',
                                   'rating_claimed_until','rating_claimed_by'))
           + (SELECT count(*) FROM pg_trigger
               WHERE tgrelid='public.partner_public_listings'::regclass
                 AND tgname='trg_partner_public_listings_born_dirty')
           + (SELECT count(*) FROM pg_constraint
               WHERE conname='chk_partner_public_listings_rating_generations')
           + (SELECT count(*) FROM pg_indexes
               WHERE schemaname='public'
                 AND indexname IN ('idx_partner_public_listings_rating_due',
                                   'idx_partner_public_listings_rating_retry'))
         )::int n`
      );
      return rows[0].n === 0 ? "rating_lifecycle_hardening_absent" : "rating_lifecycle_hardening_present";
    },
  },
  {
    number: 67,
    standalone: false,
    migration: "0067_certificate_immutable_evidence_ledger.sql",
    rollback: "rollback-0067-certificate-immutable-evidence-ledger.sql",
    hole: "scanner TIFF masters and their browser/crop lineage are missing or mutable",
    whenApplied: "immutable_evidence_ledger_present",
    whenRolledBack: "immutable_evidence_ledger_absent",
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_class
          WHERE relnamespace='public'::regnamespace AND relkind='r'
            AND relname IN ('certificate_image_masters','certificate_image_workings','certificate_image_crops')`
      );
      return rows[0].n === 0 ? "immutable_evidence_ledger_absent" : "immutable_evidence_ledger_present";
    },
  },
  {
    number: 68,
    // 0069 is now above this migration, so 0068's own later-migration guard must refuse an
    // isolated rollback. The supported descending sequence below proves its reversible path.
    standalone: false,
    migration: "0068_certificate_scan_status.sql",
    rollback: "rollback-0068-certificate-scan-status.sql",
    hole: "the scanner recovery reconciler queries a certificate scan status column that a fresh migration never created",
    whenApplied: "certificate_scan_status_present",
    whenRolledBack: "certificate_scan_status_absent",
    probe: async () => {
      const { rows } = await admin.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='certificates' AND column_name='scan_status'
         ) AS present`
      );
      return rows[0].present ? "certificate_scan_status_present" : "certificate_scan_status_absent";
    },
  },
  {
    number: 69,
    // 0070 owns the operational stock table and depends on 0069's catalogue, so 0069 may now
    // only be reversed by the tested descending sequence.
    standalone: false,
    migration: "0069_partner_supply_orders.sql",
    rollback: "rollback-0069-partner-supply-orders.sql",
    hole: "Partner supplies can be paid, fulfilled or refunded without an immutable tenant-isolated order/payment snapshot",
    whenApplied: "supply_order_ledger_present",
    whenRolledBack: "supply_order_ledger_absent",
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_class
          WHERE relnamespace='public'::regnamespace AND relkind='r'
            AND relname IN ('partner_supply_products','partner_supply_tax_settings','partner_supply_orders',
                            'partner_supply_order_items','partner_supply_payments','partner_supply_refunds',
                            'partner_supply_order_events')`
      );
      return rows[0].n === 7 ? "supply_order_ledger_present" : "supply_order_ledger_absent";
    },
  },
  {
    number: 70,
    // 0071 binds review decisions to certificate revision columns, so 0070 must now be reversed
    // only in the tested descending sequence.
    standalone: false,
    migration: "0070_partner_supply_stock_indicators.sql",
    rollback: "rollback-0070-partner-supply-stock-indicators.sql",
    hole: "shop stock counts and order/card indicators have no tenant- and location-isolated source of truth",
    whenApplied: "supply_stock_indicators_present",
    whenRolledBack: "supply_stock_indicators_absent",
    probe: async () => {
      const { rows } = await admin.query<{ present: boolean }>(
        "SELECT to_regclass('public.partner_supply_stock_counts') IS NOT NULL AS present"
      );
      return rows[0].present ? "supply_stock_indicators_present" : "supply_stock_indicators_absent";
    },
  },
  {
    number: 71,
    standalone: true,
    migration: "0071_certificate_review_revision_binding.sql",
    rollback: "rollback-0071-certificate-review-revision-binding.sql",
    hole: "a review can publish a grade against scanner evidence or draft data that changed after the review snapshot",
    whenApplied: "review_revision_binding_present",
    whenRolledBack: "review_revision_binding_absent",
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='certificates'
            AND column_name IN ('grading_revision','evidence_revision','review_grading_revision',
                                'review_evidence_revision','approved_grading_revision','approved_evidence_revision')`
      );
      return rows[0].n === 6 ? "review_revision_binding_present" : "review_revision_binding_absent";
    },
  },
  {
    number: 62,
    standalone: false,
    migration: "0062_partner_rating_dirty_state.sql",
    rollback: "rollback-0062-partner-rating-dirty-state.sql",
    hole: "nothing marks a shop rating stale, so a published rating is only ever as fresh as the last time a human pressed Recalculate",
    whenApplied: "rating_dirty_state_present",
    whenRolledBack: "rating_dirty_state_absent",
    // 0062 is no longer the newest — 0063-0066 sit above it and the descending sequence now
    // starts at 0066. The refusal this used to be exempt from is exactly what the sequence proves.
    //
    // The probe counts COLUMNS AND the partial candidate index. Dropping the columns while leaving
    // the index behind would leave a stranded index on a table whose predicate no longer resolves.
    probe: async () => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name='partner_public_listings'
               AND column_name IN ('rating_dirty','rating_dirty_since','rating_last_attempted_at',
                                   'rating_last_success_at','rating_failure_count','rating_last_error_code'))
           + (SELECT count(*) FROM pg_indexes
               WHERE schemaname='public' AND indexname='idx_partner_public_listings_rating_dirty')
         )::int n`
      );
      return rows[0].n === 0 ? "rating_dirty_state_absent" : "rating_dirty_state_present";
    },
  },
];

// =============================================================================================

describe("Rollback + guard integrity (dedicated disposable PostgreSQL 17 cluster)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-rollback-integrity");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();

    await provisionRealisticRoles(admin);
    await createMintvaultCertificatesTable(admin);
    await admin.query("CREATE TABLE IF NOT EXISTS users (id varchar primary key, email varchar unique)");
    await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text unique, deleted_at timestamptz,
      grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
      scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz,
      completed_at timestamptz, return_tracking text, return_carrier text, return_service text,
      status_history jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
    );
    await createMintvaultLabelPrintsTable(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now())`);
    for (const t of ["users", "submissions", "submission_items", "label_prints", "audit_log", "certificates"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }

    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await applyEveryMigrationRealistic(migrator);
    } finally {
      await migrator.end();
    }

    await seedFixture();
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  /**
   * Two tenants, populated on every table the probes read. Seeded as the superuser so RLS does not
   * shape the fixture — the fixture must contain the rows a leak WOULD expose, or "0 rows" and
   * "nothing was ever written" become indistinguishable.
   */
  async function seedFixture(): Promise<void> {
    for (const [t, tag, loc] of [
      [A, "A", LOC_A],
      [B, "B", LOC_B],
    ] as const) {
      await admin.query(
        `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
           VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (id) DO NOTHING`,
        [t, `ref${tag}`, `${tag} Ltd`]
      );
      await admin.query(
        `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name)
           VALUES ($1,$2,$3,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [loc, `loc${tag}`, t, `Shop ${tag}`]
      );
      await admin.query(
        `INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)
           ON CONFLICT (tenant_id) DO NOTHING`,
        [t, `${tag} Trading`]
      );
      // 0047's asset: one row per tenant. A leak is visible as count > 1.
      await admin.query(`INSERT INTO partner_owner_invariant_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
        t,
      ]);
      // 0052 / 0056's assets.
      await admin.query(
        `INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email)
           VALUES ($1,$2,gen_random_uuid(),'hq@mintvault.test')`,
        [t, `HQ note about ${tag}`]
      );
      await admin.query(
        `INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result)
           VALUES ($1,'status_changed',gen_random_uuid(),'hq@mintvault.test',$2,'succeeded')`,
        [t, `req-${tag}`]
      );
      await admin.query(`INSERT INTO partner_emergency_controls (tenant_id, scope, frozen) VALUES ($1,'tenant',true)`, [
        t,
      ]);
    }
    // 0051's asset: the PLATFORM-GLOBAL kill switch row.
    await admin.query(
      `INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_emergency_stop',true)
         ON CONFLICT DO NOTHING`
    );
    // 0055's assets: a funded wallet with an active reservation against it.
    //
    // No partner_users row is seeded, deliberately. 0032's partner_enforce_final_owner_invariant()
    // rejects an ACTIVE user in a tenant that already carries an owner-invariant row but no
    // PARTNER_OWNER assignment ("partner_final_owner_required"), and nothing below needs a user:
    // the wallet, ledger and reservation are keyed on tenant_id and wallet_id only.
    await admin.query(`INSERT INTO partner_wallets (id, tenant_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [
      WALLET_A,
      A,
    ]);
    await admin.query(
      `INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key,
                                          source, reason, actor_type, request_fingerprint)
         VALUES ($1,$2,10,'opening_balance','seed-open','migration','fixture','system',$3)`,
      [WALLET_A, A, FP]
    );
    await admin.query(
      `INSERT INTO partner_credit_reservations (wallet_id, tenant_id, card_reference, status,
              idempotency_key, request_fingerprint, source, reason, actor_type, expires_at)
         VALUES ($1,$2,'card-1','active','seed-res',$3,'portal','fixture','system', now() + interval '1 day')`,
      [WALLET_A, A, FP]
    );
    // 0054's asset: the allocator, advanced past zero so a re-seed is observably a rewind.
    // 0054 seeds the row itself, so this must find exactly one row — a silent 0-row UPDATE here
    // would make every allocator probe below pass for the wrong reason.
    const seeded = await admin.query("UPDATE cert_counter SET last_issued = 205, updated_at = NOW() WHERE id = 1");
    if (seeded.rowCount !== 1) {
      throw new Error(`cert_counter allocator row missing (UPDATE affected ${seeded.rowCount} rows)`);
    }
  }

  // ===========================================================================================
  // 1. THE STATIC SWEEP — the ratchet that stops the next rollback shipping without a de-journal.
  // ===========================================================================================

  /**
   * Numbered rollbacks that do NOT delete their own journal row, and are OUT OF SCOPE for this
   * repair. Asserted in BOTH directions, exactly like RLS_EXEMPT_TENANT_TABLES in
   * tests/partner-rls-isolation.test.ts: a NEW offender fails closed because it is not listed, and
   * FIXING a listed one also fails, which forces its entry to be deleted rather than left behind as
   * a stale amnesty.
   *
   * These eight are PRE-EXISTING and predate this work. They are registered rather than fixed
   * because six of them also lack the BEGIN/COMMIT wrapper that makes a journal DELETE atomic with
   * the reversal it accompanies — adding the DELETE without the wrapper would create a NEW failure
   * mode (a de-journalled migration whose reversal half-failed) in files spanning catalogue,
   * project-control and partner user-management, none of which is in this repair's blast radius.
   * Each needs its own reversal proof. They are reported as findings, not silently carried.
   */
  const ROLLBACKS_WITHOUT_DEJOURNAL: Record<string, string> = {
    "rollback-0019-catalogue-manager.sql":
      "pre-existing; catalogue-manager scope, no BEGIN/COMMIT wrapper, needs its own reversal proof",
    "rollback-0026-catalogue-abbreviation-unique.sql":
      "pre-existing; catalogue scope, 6-line file with no transaction wrapper",
    "rollback-0030-project-control.sql":
      "pre-existing; project-control scope, no transaction wrapper, unrelated subsystem",
    "rollback-0031-partner-user-management.sql":
      "pre-existing; partner user management, no transaction wrapper, needs its own reversal proof",
    "rollback-0032-partner-final-owner-invariant.sql":
      "pre-existing; 10-line file, no transaction wrapper; 0047 depends on the table it reverts",
    "rollback-0033-partner-audit-action-precision.sql":
      "pre-existing; has BEGIN/COMMIT but no journal delete; audit-action enum precision only",
    "rollback-0034-partner-rbac-seed.sql":
      "pre-existing; has BEGIN/COMMIT but no journal delete; RBAC reference catalogue only",
    "rollback-0044-partner-submission-lifecycle-and-location-snapshot.sql":
      "pre-existing; 0044 is APPLIED on staging and its checksum ratchet must not move; no transaction wrapper",
  };

  it("EVERY numbered rollback deletes its own journal row, or is a registered exception", () => {
    const rollbacks = readdirSync(MIGRATIONS_DIR).filter((f) => /^rollback-\d{4}-.+\.sql$/.test(f));
    // Floor: if the glob ever stops matching, this whole sweep would pass vacuously.
    expect(rollbacks.length).toBeGreaterThanOrEqual(18);

    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4,}_.+\.sql$/.test(f));
    const offenders: string[] = [];
    const mismatched: string[] = [];

    for (const rb of rollbacks) {
      const number = rb.match(/^rollback-(\d{4})-/)![1];
      const sql = readFileSync(join(MIGRATIONS_DIR, rb), "utf8");
      const target = migrations.find((m) => m.startsWith(`${number}_`));
      if (target === undefined) continue; // a rollback for a migration not on this branch

      // The DELETE must name THIS rollback's own migration file — a copied-and-not-renumbered
      // filename would de-journal somebody else's migration, which is worse than not de-journalling
      // at all. That is the same hazard rollback-0049's D6 records for its threshold integer.
      const deletesSomething = /DELETE\s+FROM\s+schema_migrations/i.test(sql);
      const deletesOwn = new RegExp(
        `DELETE\\s+FROM\\s+schema_migrations[\\s\\S]{0,200}?filename\\s*=\\s*'${target.replace(/\./g, "\\.")}'`,
        "i"
      ).test(sql);

      if (!deletesSomething) offenders.push(rb);
      else if (!deletesOwn) mismatched.push(`${rb} -> does not name ${target}`);
    }

    // A rollback that de-journals the WRONG migration is never acceptable, registered or not.
    expect(mismatched).toEqual([]);
    // Both directions: a new offender is not in the register; a fixed one must lose its entry.
    expect(offenders.sort()).toEqual(Object.keys(ROLLBACKS_WITHOUT_DEJOURNAL).sort());
  });

  it("every register entry carries a written justification (an exception without a reason is an amnesty)", () => {
    for (const [file, why] of Object.entries(ROLLBACKS_WITHOUT_DEJOURNAL)) {
      expect(why.length, `${file} has no justification`).toBeGreaterThan(40);
    }
  });

  it("MUTATION: the sweep goes RED when a rollback's journal delete is removed", () => {
    // Prove the assertion above can fail. Without this, "offenders === register" would also hold if
    // the regex silently matched nothing — the precise class of vacuous pass this suite exists for.
    const file = join(MIGRATIONS_DIR, "rollback-0047-partner-owner-invariant-tenants-rls.sql");
    const original = readFileSync(file, "utf8");
    const mutated = original.replace(
      /DELETE FROM schema_migrations\s*\n\s*WHERE filename = '0047_partner_owner_invariant_tenants_rls\.sql'/,
      "SELECT 1"
    );
    expect(mutated, "the mutation did not apply — the guard would be tested against unmodified source").not.toBe(
      original
    );
    expect(/DELETE\s+FROM\s+schema_migrations/i.test(mutated)).toBe(false);
  });

  // ===========================================================================================
  // 2. THE ROUND TRIP — per rollback, in isolation.
  // ===========================================================================================

  it.each(ROUND_TRIPS.filter((t) => t.standalone).map((t) => [t.number, t.migration, t] as const))(
    "%s round-trip: applied refuses, rollback reopens AND de-journals, runner re-applies unprompted",
    async (_n, _m, entry) => {
      // (a) APPLIED — the hole is closed and the journal knows it.
      expect(await entry.probe(), `${entry.migration}: not in the applied state before the test`).toBe(
        entry.whenApplied
      );
      expect(await journalRows(entry.migration)).toBe(1);

      // (b) ROLLBACK — run the file exactly as an operator would.
      await runRollback(entry.rollback);

      // The hole is reopened…
      expect(await entry.probe(), `${entry.rollback} did not reopen: ${entry.hole}`).toBe(entry.whenRolledBack);
      // …AND the journal no longer claims the migration is applied. THIS is the blocker assertion.
      expect(
        await journalRows(entry.migration),
        `${entry.rollback} left its journal row behind: the runner will classify ${entry.migration} as ` +
          `alreadyApplied and SKIP it, so this hole stays open behind a green migration status — ${entry.hole}`
      ).toBe(0);
      // The runner must now VOLUNTEER it as pending, with nobody naming it.
      expect(await pendingPerRunner()).toContain(entry.migration);

      // (c) RE-APPLY, unprompted.
      await runRunnerUnprompted();
      expect(await journalRows(entry.migration)).toBe(1);
      expect(await entry.probe(), `${entry.migration} did not re-close on re-apply`).toBe(entry.whenApplied);
      expect(await pendingPerRunner()).not.toContain(entry.migration);
    },
    120_000
  );

  it.each(ROUND_TRIPS.filter((t) => !t.standalone).map((t) => [t.number, t.rollback, t] as const))(
    "%s REFUSES to run underneath a later journalled migration, and changes nothing when it does",
    async (_n, _rb, entry) => {
      // The refusal is the other half of BLOCKER 2. It is only SAFE — rather than a permanent
      // brick — because every rollback above now de-journals itself, so the descending order below
      // is always reachable. Proving the refusal fires, AND that a refused run is a no-op, is what
      // makes the descending test's success meaningful rather than accidental.
      const before = await entry.probe();
      await expect(runRollback(entry.rollback)).rejects.toThrow(/refused: \d+ later migration journal row/);
      expect(await entry.probe(), `${entry.rollback} changed state despite refusing`).toBe(before);
      expect(await journalRows(entry.migration)).toBe(1);
    },
    60_000
  );

  // ===========================================================================================
  // 3. THE FULL DESCENDING SEQUENCE — the one that was permanently bricked.
  // ===========================================================================================

  /**
   * DE-JOURNAL WITHOUT ROLLBACK, THEN RE-APPLY.
   *
   * This is what several migration suites do to restore state — they DELETE journal rows above a
   * target and re-run the runner, without executing the intervening rollback files. So the objects
   * still exist while the journal says they do not, and every migration above the target is
   * re-applied onto a database that already has its effects.
   *
   * That path was broken by a guard I added to 0063: it raised if
   * `idx_certificates_origin_location_reviewed` existed, intending to stop someone building an
   * index inside a file that holds ACCESS EXCLUSIVE. The assertion was UNSOUND — it conflates
   * "this file created it" with "it exists anywhere", and 0065 legitimately creates it. Seven
   * migration suites went red in CI run 31360382645 with
   * "0063: the reviewed-unit index was built inside this file".
   *
   * Every migration must be re-appliable onto its own effects. This pins that for 0063-0066.
   */
  it("0063-0066 re-apply cleanly after a de-journal that did NOT run their rollbacks", async () => {
    const before = await admin.query<{ idx: boolean }>(
      "SELECT to_regclass('public.idx_certificates_origin_location_reviewed') IS NOT NULL AS idx"
    );
    expect(before.rows[0].idx, "precondition: 0065's index is present").toBe(true);

    // The journal forgets them; the objects remain. Exactly the state the restore helpers create.
    await admin.query("DELETE FROM schema_migrations WHERE filename ~ '^006[3-6]_'");
    expect(await journalRows("0063_certificate_review_lifecycle_clock.sql")).toBe(0);

    // The runner must volunteer all four and re-apply them onto their own effects.
    const pending = await pendingPerRunner();
    for (const f of [
      "0063_certificate_review_lifecycle_clock.sql",
      "0064_public_slab_image_projection.sql",
      "0065_certificates_reviewed_unit_index.sql",
      "0066_partner_rating_lifecycle_hardening.sql",
    ]) {
      expect(pending, `${f} was not offered as pending after de-journalling`).toContain(f);
    }
    await runRunnerUnprompted();

    for (const f of [
      "0063_certificate_review_lifecycle_clock.sql",
      "0064_public_slab_image_projection.sql",
      "0065_certificates_reviewed_unit_index.sql",
      "0066_partner_rating_lifecycle_hardening.sql",
    ]) {
      expect(await journalRows(f), `${f} did not re-apply`).toBe(1);
    }
    // And the estate is intact, not merely journalled.
    const after = await admin.query<{ idx: boolean; col: boolean; view: boolean }>(
      `SELECT to_regclass('public.idx_certificates_origin_location_reviewed') IS NOT NULL AS idx,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='public' AND table_name='certificates'
                         AND column_name='review_entered_at') AS col,
              to_regclass('public.public_slab_image_projection') IS NOT NULL AS view`
    );
    expect(after.rows[0]).toEqual({ idx: true, col: true, view: true });
  }, 120_000);

  it("the whole 0071 -> 0047 descending rollback completes, and the runner restores every one", async () => {
    const descending = [...ROUND_TRIPS].sort((a, b) => b.number - a.number);

    for (const entry of descending) {
      try {
        await runRollback(entry.rollback);
      } catch (e) {
        throw new Error(
          `descending sequence bricked at ${entry.rollback}: ${(e as Error).message}. ` +
            `This is the BLOCKER-2 shape: a rollback below cannot run because a higher journal row ` +
            `survives its own rollback.`
        );
      }
      expect(
        await journalRows(entry.migration),
        `${entry.rollback} left its journal row behind mid-sequence — every LOWER rollback is now ` +
          `permanently refused, because each refuses while any higher-numbered journal row exists`
      ).toBe(0);
      // Assert the reopened state HERE, immediately after this file runs, not after the whole
      // descent. Later rollbacks legitimately move the ground under earlier probes — rollback-0049
      // revokes the connector's cert_counter privileges outright, so by the bottom of the sequence
      // 0054's probe reports "permission denied" rather than "re-seedable". Probing at the moment
      // of reversal is the only reading that means what it says.
      expect(await entry.probe(), `${entry.rollback} did not reopen: ${entry.hole}`).toBe(entry.whenRolledBack);
    }

    // Nothing from 0047 upward is journalled any more…
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int n FROM schema_migrations
        WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer >= 47`
    );
    expect(rows[0].n).toBe(0);

    // Forward-only recovery, unprompted.
    await runRunnerUnprompted();
    for (const entry of ROUND_TRIPS) {
      expect(await journalRows(entry.migration)).toBe(1);
      expect(await entry.probe(), `${entry.migration} did not re-close after full recovery`).toBe(entry.whenApplied);
    }
  }, 180_000);

  // ===========================================================================================
  // 4. cert_counter — the HIGH that 0052's column narrowing does NOT close.
  // ===========================================================================================

  describe("0054 — the allocator advances or nothing happens", () => {
    /**
     * Every case below runs as partner_connector_runtime: NOT a superuser, NOT BYPASSRLS, holding
     * exactly the column grants 0052/0054 leave it — INCLUDING UPDATE(last_issued), which it must
     * have, because that is the increment. That is the whole difficulty: the privilege the
     * connector legitimately needs is the same privilege the attack uses, so no grant can separate
     * them and the constraint has to be expressed as a relationship between OLD and NEW.
     */
    it("re-seed to 0 is REFUSED", async () => {
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt("UPDATE cert_counter SET last_issued = 0, updated_at = NOW() WHERE id = 1");
        expect(r.ok, "re-seeding the platform-wide allocator to 0 was permitted").toBe(false);
        expect(r.error).toMatch(/strictly monotonic/);
      });
    });

    it("a rewind (decrement) is REFUSED", async () => {
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt(
          "UPDATE cert_counter SET last_issued = last_issued - 100, updated_at = NOW() WHERE id = 1"
        );
        expect(r.ok, "rewinding the allocator was permitted").toBe(false);
        expect(r.error).toMatch(/strictly monotonic/);
      });
    });

    it("a no-op (same value) is REFUSED — 'may only advance' means strictly", async () => {
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt("UPDATE cert_counter SET last_issued = last_issued, updated_at = NOW() WHERE id = 1");
        expect(r.ok).toBe(false);
      });
    });

    it("INSERT ... ON CONFLICT (id) DO UPDATE SET last_issued = 0 is REFUSED", async () => {
      // The upsert route reaches the SAME row without the statement ever containing the word
      // UPDATE, which is why the column-grant fix looked complete until someone tried it.
      // ON CONFLICT DO UPDATE fires the BEFORE UPDATE trigger, which is what catches it.
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt(
          "INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET last_issued = 0"
        );
        expect(r.ok, "the upsert re-seed route was permitted").toBe(false);
        expect(r.error).toMatch(/strictly monotonic/);
      });
    });

    it("DELETE of the allocator row is REFUSED (delete-then-insert is re-seeding by another name)", async () => {
      const r = await attempt("DELETE FROM cert_counter WHERE id = 1");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/must not be deleted/);
    });

    it("re-pointing the row (UPDATE id) is REFUSED", async () => {
      await asRole("partner_connector_runtime", A, async () => {
        const r = await attempt("UPDATE cert_counter SET id = 2 WHERE id = 1");
        expect(r.ok).toBe(false);
      });
    });

    it("THE REAL INCREMENT STILL WORKS — storage.ts:1377-1379 and connector-import-service.ts:57-61", async () => {
      /**
       * A guard that breaks issuance is worse than the hole it closes. These are the two allocator
       * call sites verbatim: the HQ grading path on the application pool, then the partner
       * connector path on the RESTRICTED role, which is the harder case.
       */
      const before = Number(
        (await admin.query<{ n: number }>("SELECT last_issued AS n FROM cert_counter WHERE id = 1")).rows[0].n
      );

      await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
      const hq = await admin.query<{ last_issued: number }>(
        "UPDATE cert_counter SET last_issued = last_issued + 1, updated_at = NOW() WHERE id = 1 RETURNING last_issued"
      );
      expect(hq.rowCount, "storage.ts:1382 raises FATAL when this returns no rows").toBe(1);
      expect(Number(hq.rows[0].last_issued)).toBe(before + 1);

      await asRole("partner_connector_runtime", A, async () => {
        await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
        const c = await admin.query<{ last_issued: number }>(
          "UPDATE cert_counter SET last_issued = last_issued + 1, updated_at = NOW() WHERE id = 1 RETURNING last_issued"
        );
        expect(c.rowCount, "connector-import-service.ts:62 throws FATAL on an invalid number").toBe(1);
        expect(Number(c.rows[0].last_issued)).toBe(before + 2);
      });
    });

    it("MUTATION: every refusal above becomes a SUCCESS once the guard trigger is disabled", async () => {
      // RED-without-it, on the real object rather than a copy. If this ever stops showing the
      // attacks succeeding, the assertions above are passing for some other reason and have stopped
      // being evidence for the guard.
      await admin.query("ALTER TABLE cert_counter DISABLE TRIGGER trg_cert_counter_monotonic");
      try {
        await asRole("partner_connector_runtime", A, async () => {
          const reseed = await attempt("UPDATE cert_counter SET last_issued = 0, updated_at = NOW() WHERE id = 1");
          expect(reseed.ok, "re-seed should succeed without the guard").toBe(true);
          expect(reseed.rows).toBe(1);

          const upsert = await attempt(
            "INSERT INTO cert_counter (id, last_issued) VALUES (1,0) ON CONFLICT (id) DO UPDATE SET last_issued = 0"
          );
          expect(upsert.ok, "upsert re-seed should succeed without the guard").toBe(true);
        });
      } finally {
        // ALWAYS restore, and back to ENABLE ALWAYS rather than the default ENABLE ORIGIN —
        // cert_counter is shared by every later test in this file.
        await admin.query("ALTER TABLE cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_monotonic");
      }
      await asRole("partner_connector_runtime", A, async () => {
        expect((await attempt("UPDATE cert_counter SET last_issued = 0 WHERE id = 1")).ok).toBe(false);
      });
    });
  });

  // ===========================================================================================
  // 5. 0047 / 0048 pre-flight — a migration must not journal `applied` while delivering nothing.
  // ===========================================================================================

  describe("0047 / 0048 refuse to certify isolation against a BYPASSRLS role", () => {
    /**
     * pg_roles is CLUSTER-GLOBAL. This suite owns a dedicated disposable cluster (startPostgres17
     * creates one per suite), but the attribute is restored in a finally on every path AND the
     * restoration is itself asserted — a leaked BYPASSRLS would make every RLS assertion in this
     * file pass vacuously, which is precisely the defect under test.
     */
    async function withBypassRls(role: string, fn: () => Promise<void>): Promise<void> {
      await admin.query(`ALTER ROLE ${role} BYPASSRLS`);
      try {
        const { rows } = await admin.query<{ b: boolean }>(
          "SELECT rolbypassrls AS b FROM pg_roles WHERE rolname = $1",
          [role]
        );
        expect(rows[0].b, "the mutation did not take — the assertion below would prove nothing").toBe(true);
        await fn();
      } finally {
        await admin.query(`ALTER ROLE ${role} NOBYPASSRLS`);
        const { rows } = await admin.query<{ b: boolean }>(
          "SELECT rolbypassrls AS b FROM pg_roles WHERE rolname = $1",
          [role]
        );
        expect(rows[0].b, `FAILED TO RESTORE ${role} NOBYPASSRLS — every later assertion is void`).toBe(false);
      }
    }

    it("0047 RAISES instead of journalling when partner_runtime is BYPASSRLS", async () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, "0047_partner_owner_invariant_tenants_rls.sql"), "utf8");
      await withBypassRls("partner_runtime", async () => {
        await admin.query("BEGIN");
        try {
          await expect(admin.query(sql)).rejects.toThrow(/0047: partner_runtime is BYPASSRLS/);
        } finally {
          await admin.query("ROLLBACK").catch(() => {});
        }
      });
    });

    it("0048 RAISES instead of journalling when partner_runtime is BYPASSRLS", async () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, "0048_partner_location_snapshot_search_path.sql"), "utf8");
      await withBypassRls("partner_runtime", async () => {
        await admin.query("BEGIN");
        try {
          await expect(admin.query(sql)).rejects.toThrow(/0048: partner_runtime is SUPERUSER or BYPASSRLS/);
        } finally {
          await admin.query("ROLLBACK").catch(() => {});
        }
      });
    });

    it("MUTATION: without the pre-flight, 0047 passes ALL of its own assertions while the leak is intact", async () => {
      /**
       * THE FINDING, REPRODUCED. Strip the pre-flight and 0047 runs GREEN against a BYPASSRLS
       * partner_runtime — relrowsecurity true, relforcerowsecurity true, exactly one policy: every
       * claim the file makes about itself is satisfied — while partner_owner_invariant_tenants
       * still returns every tenant on the network. It would be journalled `applied`, consuming the
       * migration number and closing the finding on paper.
       */
      const sql = readFileSync(join(MIGRATIONS_DIR, "0047_partner_owner_invariant_tenants_rls.sql"), "utf8");
      const marker = "DO $$\nBEGIN\n  ALTER TABLE partner_owner_invariant_tenants";
      expect(sql).toContain(marker);
      const withoutPreflight = sql.slice(sql.indexOf(marker));
      expect(
        withoutPreflight,
        "the pre-flight excision failed; the mutation would not be testing what it claims"
      ).not.toContain("is BYPASSRLS");

      await withBypassRls("partner_runtime", async () => {
        // The un-guarded migration completes without error…
        await admin.query(withoutPreflight);
        // …and the hole it claims to close is WIDE OPEN, because no policy binds a role that
        // bypasses RLS. This deliberately does NOT use asRole(): asRole asserts rolbypassrls=false,
        // which is exactly the condition being violated here.
        await admin.query("SET ROLE partner_runtime");
        try {
          await admin.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
          const { rows } = await admin.query<{ n: number }>(
            "SELECT count(*)::int n FROM partner_owner_invariant_tenants"
          );
          expect(rows[0].n, "expected the A8-F1 leak to be intact under BYPASSRLS").toBe(2);
        } finally {
          await admin.query("RESET ROLE").catch(() => {});
          await admin.query("RESET app.tenant_id").catch(() => {});
        }
      });

      // Role restored — and the real, guarded migration is still correct.
      expect(await ROUND_TRIPS.find((t) => t.number === 47)!.probe()).toBe("isolated:1");
    });
  });

  // ===========================================================================================
  // 6. The pg_temp class — control / attack pair, and the sweep that stops it regrowing.
  // ===========================================================================================

  describe("0055 — pg_temp shadowing of the credit-ledger underfunding guard", () => {
    /**
     * These run on the ADMIN pool, and that is the honest scope rather than a shortcut: neither
     * restricted runtime role holds INSERT on partner_credit_ledger (0052's catalogue sweep
     * confirms it), so the admin pool is the only place this trigger fires today. That is exactly
     * why the finding is MEDIUM rather than HIGH — and exactly why it is still worth closing, since
     * the primitive is one blanket GRANT away from mattering.
     *
     * The fixture is a wallet with 10 credits and ONE active reservation, so a -10 debit leaves a
     * balance of 0 against 1 reserved credit and the guard must refuse it.
     */
    const DEBIT = `INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type,
                     idempotency_key, source, reason, actor_type, request_fingerprint)
                   VALUES ($1, $2, -10, 'admin_adjustment', $3, 'admin', 'attack', 'admin', $4)`;

    const debitAttempt = (key: string) => attempt(DEBIT, [WALLET_A, A, key, FP]);

    it("CONTROL: the guard refuses an underfunding debit with no shadowing in play", async () => {
      const r = await debitAttempt("control-1");
      expect(r.ok, "the guard did not fire at all — the attack below would prove nothing").toBe(false);
      expect(r.error).toMatch(/underfund active reservations/);
    });

    it("ATTACK: a pg_temp shadow does NOT defeat the pinned function", async () => {
      await admin.query(
        `CREATE TEMP TABLE partner_credit_reservations
           (wallet_id uuid, tenant_id uuid, reserved_credits bigint, status text)`
      );
      try {
        // Prove the shadow really is ahead of public in THIS session, or a negative result would be
        // indistinguishable from "the temp table was never in the way".
        const { rows } = await admin.query<{ ns: string }>(
          `SELECT n.nspname AS ns FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.oid = 'partner_credit_reservations'::regclass`
        );
        expect(rows[0].ns).toMatch(/^pg_temp/);

        const r = await debitAttempt("attack-1");
        expect(
          r.ok,
          "the shadowed table was consulted: the wallet was driven to 0 while an active reservation existed"
        ).toBe(false);
        expect(r.error).toMatch(/underfund active reservations/);
      } finally {
        await admin.query("DROP TABLE IF EXISTS pg_temp.partner_credit_reservations");
      }
    });

    it("MUTATION: the same shadow DOES defeat the un-pinned 0017 body", async () => {
      // RED-without-it. rollback-0055 restores 0017's body verbatim and the identical attack then
      // succeeds. rollback-0056 goes first because it is journalled above 0055 — the descending
      // discipline this whole file exists to make possible.
      await runRollback("rollback-0056-partner-hq-control-tables-write-deny.sql");
      await runRollback("rollback-0055-partner-ledger-preserve-search-path.sql");
      try {
        await admin.query(
          `CREATE TEMP TABLE partner_credit_reservations
             (wallet_id uuid, tenant_id uuid, reserved_credits bigint, status text)`
        );
        try {
          const r = await debitAttempt("mutation-1");
          expect(
            r.ok,
            "expected the un-pinned body to be defeated by the shadow — if this is false, the " +
              "control/attack pair above proves nothing about the pin"
          ).toBe(true);
        } finally {
          await admin.query("DROP TABLE IF EXISTS pg_temp.partner_credit_reservations");
        }
      } finally {
        await runRunnerUnprompted();
      }
      expect(await ROUND_TRIPS.find((t) => t.number === 55)!.probe()).toBe("pinned");
      expect(await ROUND_TRIPS.find((t) => t.number === 56)!.probe()).toBe("write_denied");
    });

    it("the CLASS is swept: no unpinned function in public reads a relation unqualified", async () => {
      // The sweep from 0055's post-flight, re-run on every CI pass against the whole chain. A
      // migration assertion fires once, and once is not a ratchet. 0048 fixed one instance and did
      // not sweep, which is how the same primitive sat in 0017 — guarding money — the whole time.
      const { rows } = await admin.query<{ proname: string }>(UNPINNED_FUNCTION_SWEEP);
      expect(rows.map((r) => r.proname)).toEqual([]);
    });

    it("MUTATION: the class sweep goes RED on a planted unqualified function", async () => {
      await admin.query(
        `CREATE FUNCTION planted_unqualified_reader() RETURNS bigint LANGUAGE plpgsql AS $f$
           DECLARE n bigint;
           BEGIN SELECT count(*) INTO n FROM partner_wallets; RETURN n; END $f$`
      );
      try {
        const { rows } = await admin.query<{ proname: string }>(UNPINNED_FUNCTION_SWEEP);
        expect(rows.map((r) => r.proname)).toContain("planted_unqualified_reader");
      } finally {
        await admin.query("DROP FUNCTION IF EXISTS planted_unqualified_reader()");
      }
      // Clean again, so the mutation cannot leave the guard permanently red.
      const { rows } = await admin.query<{ proname: string }>(UNPINNED_FUNCTION_SWEEP);
      expect(rows.map((r) => r.proname)).toEqual([]);
    });

    it("MUTATION: the sweep does NOT false-alarm on `IS DISTINCT FROM OLD.x`", async () => {
      // Four of the five functions the first draft of this sweep flagged were immutability triggers
      // matching `FROM OLD`. A sweep that cries wolf gets an exclusion list bolted on, and an
      // exclusion list is how A8-F1 survived every green run. Prove the exclusion is deliberate.
      await admin.query(
        `CREATE FUNCTION planted_old_reference() RETURNS trigger LANGUAGE plpgsql AS $f$
           BEGIN IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'no'; END IF; RETURN NEW; END $f$`
      );
      try {
        const { rows } = await admin.query<{ proname: string }>(UNPINNED_FUNCTION_SWEEP);
        expect(rows.map((r) => r.proname)).not.toContain("planted_old_reference");
      } finally {
        await admin.query("DROP FUNCTION IF EXISTS planted_old_reference()");
      }
    });
  });

  // ===========================================================================================
  // 7. The HQ control / evidence tables — attacked with the blanket GRANT restored.
  // ===========================================================================================

  describe("0056 — a restored blanket GRANT still reaches nothing", () => {
    /**
     * The entire claim of a defence-in-depth layer is that it holds WHEN STEP ONE IS UNDONE. So the
     * battery below restores the exact grant 0001's DO loop hands out and then attacks. If the
     * policies are right every write is DELETE 0 and every evidence read is 0 rows — refused by the
     * POLICY, with the privilege demonstrably present.
     */
    const TABLES = ["partner_emergency_controls", "partner_internal_notes", "partner_management_audit"] as const;

    async function withBlanketGrant(fn: () => Promise<void>): Promise<void> {
      for (const t of TABLES) {
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO partner_runtime`);
      }
      try {
        await fn();
      } finally {
        // Restore the exact pre-test privilege shape: 0051 revoked writes on emergency controls and
        // deliberately left SELECT; partner_runtime never held anything on the two evidence tables,
        // which 0052's post-flight (c) asserts.
        await admin.query("REVOKE INSERT, UPDATE, DELETE ON partner_emergency_controls FROM partner_runtime");
        await admin.query("REVOKE ALL ON partner_internal_notes   FROM partner_runtime");
        await admin.query("REVOKE ALL ON partner_management_audit FROM partner_runtime");
      }
    }

    it("with DELETE handed back: the HQ freeze cannot be self-lifted and HQ evidence cannot be destroyed", async () => {
      await withBlanketGrant(async () => {
        await asRole("partner_runtime", A, async () => {
          // Guard the guard: the privilege really is present, so a refusal below is the POLICY
          // doing the work and not a leftover revoke.
          const { rows: priv } = await admin.query<{ d: boolean }>(
            "SELECT has_table_privilege('partner_runtime','public.partner_emergency_controls','DELETE') AS d"
          );
          expect(priv[0].d, "the grant was not actually restored — this test would pass vacuously").toBe(true);

          const freeze = await attempt("DELETE FROM partner_emergency_controls WHERE tenant_id = $1", [A]);
          expect(freeze.ok && freeze.rows, "an HQ-imposed emergency freeze was SELF-LIFTED").toBe(0);

          const audit = await attempt("DELETE FROM partner_management_audit WHERE tenant_id = $1", [A]);
          expect(audit.ok && audit.rows, "HQ's admin-action audit evidence was DESTROYED").toBe(0);

          const notes = await attempt("DELETE FROM partner_internal_notes WHERE tenant_id = $1", [A]);
          expect(notes.ok && notes.rows, "HQ internal notes were DELETED").toBe(0);
        });
      });
    });

    it("with SELECT handed back: HQ internal notes and the audit ledger read 0 rows", async () => {
      await withBlanketGrant(async () => {
        await asRole("partner_runtime", A, async () => {
          for (const t of ["partner_internal_notes", "partner_management_audit"] as const) {
            const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int n FROM ${t}`);
            expect(rows[0].n, `${t} is readable by a tenant-scoped role`).toBe(0);
          }
          // The emergency-control READ is deliberately RETAINED and must still work, or every
          // portal gate fails closed. Over-tightening has to fail here rather than in production.
          const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_emergency_controls");
          expect(rows[0].n, "readEmergencyState() would stop seeing this tenant's freeze").toBe(1);
        });
      });
    });

    it("MUTATION: with 0056 rolled back, the identical battery succeeds on all three tables", async () => {
      // RED-without-it. 0052's tenant-equality policy on cmd=ALL admits the tenant's OWN rows into
      // DELETE's USING clause — and on these tables the tenant's own rows ARE the asset.
      await runRollback("rollback-0056-partner-hq-control-tables-write-deny.sql");
      try {
        await withBlanketGrant(async () => {
          await asRole("partner_runtime", A, async () => {
            const freeze = await attempt("DELETE FROM partner_emergency_controls WHERE tenant_id = $1", [A]);
            expect(freeze.ok && freeze.rows, "expected the freeze to be self-liftable without 0056").toBe(1);

            const audit = await attempt("DELETE FROM partner_management_audit WHERE tenant_id = $1", [A]);
            expect(audit.ok && audit.rows, "expected HQ evidence to be destructible without 0056").toBe(1);

            const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_internal_notes");
            expect(rows[0].n, "expected HQ notes to be readable without 0056").toBe(1);
          });
        });
      } finally {
        await runRunnerUnprompted();
      }
      expect(await ROUND_TRIPS.find((t) => t.number === 56)!.probe()).toBe("write_denied");
    });
  });
});
