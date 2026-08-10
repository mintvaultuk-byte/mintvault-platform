/**
 * DEPLOY-ORDER GATE for the public Partner Network (hostile-review finding H8).
 *
 * ── WHY A SCRIPT AND NOT A RUNBOOK PARAGRAPH ────────────────────────────────────────────────
 * The application deploy that carries this branch has hard dependencies the migration chain and
 * the infrastructure must satisfy FIRST. Until now those dependencies were written down in
 * `docs/partner-migration-lock-safety.md` and enforced at runtime by fail-closed behaviour — which
 * means the failure mode was "we deployed, and then discovered". Fail-closed is the right runtime
 * posture and it is not a deploy gate: a 503 on the public slab showcase is still an outage, and
 * "the operator will read the runbook" is not a control.
 *
 * The single most likely way this goes wrong is not a forgotten migration. It is the ONE STEP NO
 * MIGRATION CAN PERFORM: migration 0061 creates `partner_public_reader` as a NOLOGIN GROUP role,
 * per the house convention (0008:17-18) that infrastructure grants membership out of band. A fully
 * migrated estate can be completely unable to serve, and nothing in the chain notices.
 *
 * ── WHAT THIS REFUSES, AND WHY EACH ONE ─────────────────────────────────────────────────────
 * Every check below maps to a way an anonymous request 500s or 503s after the deploy:
 *
 *   MIGRATION JOURNAL   0058-0066 applied. The code reads views and columns they create.
 *   COLUMNS             certificates.review_entered_at (the V2 rating clock — a missing column is
 *                       a 42703 on every rating measurement, not a degraded rating).
 *   VIEWS               all three public projections. 0061 without 0064 gives a working Shop
 *                       Finder whose every card image 503s, which is worse than an honest outage.
 *   ROLE                partner_public_reader exists, and is NOLOGIN/NOSUPERUSER/NOBYPASSRLS —
 *                       a public-facing reader that could log in directly or bypass RLS is the
 *                       risk 0061 exists to remove.
 *   MEMBERSHIP          the login role in PARTNER_PUBLIC_DATABASE_URL is a member. THE STEP NO
 *                       MIGRATION CAN DO.
 *   GRANTS              the reader can SELECT the three projections and CANNOT reach
 *                       `certificates` directly. The second half matters more: a reader with a
 *                       base-table grant makes the whole projection design decorative.
 *   INDEXES             the reviewed-unit index, or the rating measurement seq-scans the largest
 *                       table in the product on every HQ review.
 *   FLAG                `partner_public_network_enabled` must be ABSENT or OFF at deploy time.
 *                       Deploying code and launching a consumer surface in the same step removes
 *                       the entire point of a staged rollout.
 *   CERT COUNTER        `cert_counter` is intact and monotonic — 0054 installs the guard, and this
 *                       is the estate's most incident-prone singleton.
 *
 * ── HOW IT CONNECTS, AND WHAT IT WILL NOT DO ────────────────────────────────────────────────
 * READ ONLY, through `withReadOnlySession`, which is transaction-scoped, session-scoped, refuses
 * transaction-control statements to the callback and verifies the session clean on release. That
 * helper exists because a preflight once left `default_transaction_read_only` on a PgBouncer
 * backend and broke a production write thirty seconds later. This gate must never be the thing
 * that causes an incident.
 *
 * It NEVER prints a connection string, a password, a host or a role's credentials. Findings name
 * objects and roles, never secrets.
 *
 * It makes exactly ONE connection using the ADMIN url (to read catalogues) and, when
 * PARTNER_PUBLIC_DATABASE_URL is set, a second using THAT url — because membership can only
 * honestly be proven by connecting as the login role that will actually serve and asking
 * PostgreSQL to drop to the group role. Interrogating `pg_auth_members` from the admin connection
 * would test our belief about privilege rather than the privilege.
 *
 * Usage:
 *   npm run db:preflight-public                 # human output, exit 1 on any failure
 *   npm run db:preflight-public -- --json       # machine-readable
 *   npm run db:preflight-public -- --expect-flag-off=false   # post-enable verification
 */
import { withReadOnlySession, type ReadOnlyQuery } from "./read-only-session";

/** Migrations the application code hard-depends on. Ordered; the message names the first gap. */
export const REQUIRED_MIGRATIONS = [
  "0058_partner_public_network.sql",
  "0059_partner_public_eligibility_propagation.sql",
  "0060_partner_public_rating_override_expiry.sql",
  "0061_partner_public_reader.sql",
  "0062_partner_rating_dirty_state.sql",
  "0063_certificate_review_lifecycle_clock.sql",
  "0064_public_slab_image_projection.sql",
  "0065_certificates_reviewed_unit_index.sql",
  "0066_partner_rating_lifecycle_hardening.sql",
] as const;

/** Relations the anonymous path reads. All three, because a partial estate is the failure. */
export const REQUIRED_VIEWS = [
  "partner_public_shop_projection",
  "partner_public_card_projection",
  "public_slab_image_projection",
] as const;

/** Columns whose absence is a 42703 on a hot path, not a degradation. */
export const REQUIRED_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ["certificates", "review_entered_at"],
  ["certificates", "status_updated_at"],
  ["partner_public_listings", "rating_dirty_generation"],
  ["partner_public_listings", "rating_clean_generation"],
  ["partner_public_listings", "rating_next_recalc_at"],
  ["partner_public_listings", "rating_next_attempt_at"],
  ["partner_public_listings", "rating_claimed_until"],
];

export const REQUIRED_INDEXES = ["idx_certificates_origin_location_reviewed"] as const;

export const PUBLIC_READER_ROLE = "partner_public_reader";
export const PUBLIC_NETWORK_FLAG = "partner_public_network_enabled";

export interface PreflightFinding {
  /** Short machine-readable key. Never contains a credential, host or connection string. */
  code: string;
  detail: string;
}

export interface PublicNetworkPreflight {
  ok: boolean;
  checked: string[];
  failures: PreflightFinding[];
  warnings: PreflightFinding[];
}

/**
 * Catalogue-side checks, on the admin connection.
 *
 * Split from the membership probe so the two failure classes stay distinguishable: "the migration
 * chain is behind the code" and "infrastructure has not granted membership" need different people
 * to fix them, and a gate that reports one generic failure sends the operator to the wrong place.
 */
export async function checkSchemaSide(query: ReadOnlyQuery): Promise<{
  failures: PreflightFinding[];
  warnings: PreflightFinding[];
  checked: string[];
}> {
  const failures: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  const checked: string[] = [];

  // ── Migration journal ─────────────────────────────────────────────────────────────────────
  checked.push("migration_journal");
  const journal = await query<{ filename: string; status: string }>(
    `SELECT filename, status FROM schema_migrations WHERE filename = ANY($1::text[])`,
    [[...REQUIRED_MIGRATIONS]],
  );
  const applied = new Map(journal.rows.map((r) => [r.filename, r.status]));
  for (const m of REQUIRED_MIGRATIONS) {
    const status = applied.get(m);
    if (status === undefined) {
      failures.push({ code: "migration_not_applied", detail: `${m} has no journal row` });
    } else if (status !== "applied") {
      // 'applying' is the no-transaction path's mid-flight state — a deploy on top of that is a
      // deploy onto a half-built index.
      failures.push({ code: "migration_not_complete", detail: `${m} is journalled '${status}', not 'applied'` });
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────────────────────
  checked.push("public_projections");
  const views = await query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1::text[])`,
    [[...REQUIRED_VIEWS]],
  );
  const present = new Set(views.rows.map((r) => r.relname));
  for (const v of REQUIRED_VIEWS) {
    if (!present.has(v)) failures.push({ code: "projection_missing", detail: `view ${v} does not exist` });
  }

  // ── Columns ───────────────────────────────────────────────────────────────────────────────
  checked.push("required_columns");
  for (const [table, column] of REQUIRED_COLUMNS) {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text n FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column],
    );
    if (Number(r.rows[0]?.n ?? 0) === 0) {
      failures.push({ code: "column_missing", detail: `${table}.${column} does not exist` });
    }
  }

  // ── Indexes ───────────────────────────────────────────────────────────────────────────────
  checked.push("required_indexes");
  for (const idx of REQUIRED_INDEXES) {
    const r = await query<{ valid: boolean | null }>(
      `SELECT i.indisvalid AS valid FROM pg_class c
         LEFT JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1 AND c.relkind = 'i'`,
      [idx],
    );
    if (r.rows.length === 0) {
      failures.push({ code: "index_missing", detail: `index ${idx} does not exist` });
    } else if (r.rows[0].valid !== true) {
      // A CONCURRENTLY build that failed leaves an INVALID index: maintained on every write, used
      // for no read. The runner self-heals it, but deploying on top of one is deploying onto a
      // seq-scan you are also paying to maintain.
      failures.push({ code: "index_invalid", detail: `index ${idx} exists but is INVALID` });
    }
  }

  // ── Reader role attributes ────────────────────────────────────────────────────────────────
  checked.push("public_reader_role");
  const role = await query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    [PUBLIC_READER_ROLE],
  );
  if (role.rows.length === 0) {
    failures.push({ code: "reader_role_missing", detail: `role ${PUBLIC_READER_ROLE} does not exist (migration 0061)` });
  } else {
    const r = role.rows[0];
    if (r.rolcanlogin) failures.push({ code: "reader_role_can_login", detail: `${PUBLIC_READER_ROLE} must be NOLOGIN` });
    if (r.rolsuper) failures.push({ code: "reader_role_superuser", detail: `${PUBLIC_READER_ROLE} must be NOSUPERUSER` });
    if (r.rolbypassrls) failures.push({ code: "reader_role_bypassrls", detail: `${PUBLIC_READER_ROLE} must be NOBYPASSRLS` });
  }

  // ── The privilege boundary itself ─────────────────────────────────────────────────────────
  checked.push("reader_grants");
  if (role.rows.length > 0) {
    for (const v of REQUIRED_VIEWS) {
      if (!present.has(v)) continue;
      const g = await query<{ can: boolean }>(
        `SELECT has_table_privilege($1, format('public.%I', $2::text), 'SELECT') AS can`,
        [PUBLIC_READER_ROLE, v],
      );
      if (g.rows[0]?.can !== true) {
        failures.push({ code: "reader_cannot_read_projection", detail: `${PUBLIC_READER_ROLE} cannot SELECT ${v}` });
      }
    }
    // The half that matters most. A base-table grant makes the projections decorative.
    const base = await query<{ can: boolean }>(
      `SELECT has_table_privilege($1, 'public.certificates', 'SELECT') AS can`,
      [PUBLIC_READER_ROLE],
    );
    if (base.rows[0]?.can === true) {
      failures.push({
        code: "reader_has_base_table_access",
        detail: `${PUBLIC_READER_ROLE} has direct SELECT on certificates — the projection boundary is bypassed`,
      });
    }
  }

  // ── cert_counter ──────────────────────────────────────────────────────────────────────────
  checked.push("cert_counter");
  const counter = await query<{ n: string }>(`SELECT count(*)::text n FROM pg_class WHERE relname = 'cert_counter'`);
  if (Number(counter.rows[0]?.n ?? 0) === 0) {
    warnings.push({ code: "cert_counter_absent", detail: "cert_counter does not exist (expected on a partner-only estate)" });
  } else {
    const guard = await query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_trigger
        WHERE tgrelid = 'public.cert_counter'::regclass AND tgname = 'trg_cert_counter_monotonic' AND tgenabled <> 'D'`,
    );
    if (Number(guard.rows[0]?.n ?? 0) === 0) {
      failures.push({ code: "cert_counter_guard_missing", detail: "0054's monotonic guard trigger is missing or disabled" });
    }
  }

  return { failures, warnings, checked };
}

/**
 * The rollout flag must be OFF (or absent) at deploy time.
 *
 * Separate from the schema checks because it is the only one an operator legitimately flips AFTER
 * a successful deploy — hence `--expect-flag-off=false` for the post-enable verification run.
 */
export async function checkRolloutFlag(
  query: ReadOnlyQuery,
  expectOff: boolean,
): Promise<PreflightFinding[]> {
  const out: PreflightFinding[] = [];
  const r = await query<{ enabled: boolean }>(
    `SELECT enabled FROM partner_feature_flags
      WHERE flag = $1 AND tenant_id IS NULL AND location_id IS NULL
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [PUBLIC_NETWORK_FLAG],
  );
  const on = r.rows.length === 1 && r.rows[0].enabled === true;
  if (expectOff && on) {
    out.push({
      code: "rollout_flag_already_on",
      detail: `${PUBLIC_NETWORK_FLAG} is ON before the deploy. Turn it OFF, deploy, smoke-test, then enable.`,
    });
  }
  if (!expectOff && !on) {
    out.push({ code: "rollout_flag_not_on", detail: `${PUBLIC_NETWORK_FLAG} is not ON` });
  }
  return out;
}

/**
 * Prove the login role can actually become the reader — the step no migration can perform (H13).
 *
 * Connects as PARTNER_PUBLIC_DATABASE_URL and asks PostgreSQL to drop to the group role, then
 * reads `current_user` back. Doing the thing is a better proof than asking whether the thing would
 * work: a `pg_auth_members` lookup from the admin connection tests our belief about privilege, and
 * would also need catalogue access the reader deliberately does not have.
 */
export async function checkMembership(publicUrl: string): Promise<PreflightFinding[]> {
  try {
    return await withReadOnlySession(publicUrl, async (query) => {
      // SET LOCAL, inside the helper's own read-only transaction — scoped to it, discarded at
      // rollback, and correct through a transaction-mode pooler.
      await query(`SET LOCAL ROLE ${PUBLIC_READER_ROLE}`);
      const who = await query<{ role: string }>("SELECT current_user AS role");
      const effective = who.rows[0]?.role;
      if (effective !== PUBLIC_READER_ROLE) {
        return [{ code: "membership_not_effective", detail: `SET ROLE succeeded but current_user is '${String(effective)}'` }];
      }
      // And prove it can actually serve, as the reader, from each projection.
      const out: PreflightFinding[] = [];
      for (const v of REQUIRED_VIEWS) {
        try {
          await query(`SELECT 1 FROM ${v} LIMIT 0`);
        } catch (e) {
          const err = e as { code?: string };
          out.push({ code: "reader_probe_failed", detail: `${PUBLIC_READER_ROLE} cannot read ${v} (SQLSTATE ${err?.code ?? "?"})` });
        }
      }
      return out;
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // 42501 insufficient_privilege is the signature of the missing GRANT, and is worth naming
    // precisely because the remedy is one statement an operator can run in seconds.
    if (err?.code === "42501" || err?.code === "42704" || err?.code === "22023") {
      return [
        {
          code: "membership_missing",
          detail:
            `the login role in PARTNER_PUBLIC_DATABASE_URL is not a member of ${PUBLIC_READER_ROLE}. ` +
            `Remedy (no migration can do this): GRANT ${PUBLIC_READER_ROLE} TO <that login role>;`,
        },
      ];
    }
    // Message only, never the URL. A pg connection error's message can carry host and port, so it
    // is reported as a code where possible.
    return [{ code: "public_db_unreachable", detail: `could not connect or probe as the public role (${err?.code ?? "no SQLSTATE"})` }];
  }
}

export async function runPublicNetworkPreflight(opts: {
  adminUrl: string;
  publicUrl?: string;
  expectFlagOff?: boolean;
}): Promise<PublicNetworkPreflight> {
  const expectFlagOff = opts.expectFlagOff !== false;
  const failures: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  const checked: string[] = [];

  const schema = await withReadOnlySession(opts.adminUrl, async (query) => {
    const s = await checkSchemaSide(query);
    const flag = await checkRolloutFlag(query, expectFlagOff);
    return { ...s, flag };
  });
  failures.push(...schema.failures, ...schema.flag);
  warnings.push(...schema.warnings);
  checked.push(...schema.checked, "rollout_flag");

  checked.push("public_db_url");
  if (!opts.publicUrl) {
    failures.push({
      code: "public_db_url_not_configured",
      detail:
        "PARTNER_PUBLIC_DATABASE_URL is not set. The anonymous slab-image proxy fails closed without it, " +
        "and the public slab showcase is a LIVE production surface.",
    });
  } else {
    checked.push("reader_membership");
    failures.push(...(await checkMembership(opts.publicUrl)));
  }

  return { ok: failures.length === 0, checked, failures, warnings };
}

/* c8 ignore start — CLI shell; the logic above is unit-tested without a database. */
async function main(): Promise<void> {
  const adminUrl = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!adminUrl) {
    console.error("🚫 preflight-public-network: no admin database URL (PARTNER_ADMIN_DATABASE_URL or MINTVAULT_DATABASE_URL).");
    process.exit(2);
  }
  const asJson = process.argv.includes("--json");
  const expectFlagOff = !process.argv.includes("--expect-flag-off=false");

  let res: PublicNetworkPreflight;
  try {
    res = await runPublicNetworkPreflight({
      adminUrl,
      publicUrl: process.env.PARTNER_PUBLIC_DATABASE_URL,
      expectFlagOff,
    });
  } catch (e) {
    console.error(`🚫 preflight-public-network: inspection failed — ${(e as Error).message}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`Public network deploy preflight — ${res.checked.length} check group(s): ${res.checked.join(", ")}`);
    for (const w of res.warnings) console.warn(`  ⚠️  ${w.code}: ${w.detail}`);
    for (const f of res.failures) console.error(`  ✗  ${f.code}: ${f.detail}`);
  }
  if (!res.ok) {
    console.error(
      `\n🚫 DEPLOY BLOCKED — ${res.failures.length} unmet dependency/dependencies. ` +
        `Deploying now would serve 500s or 503s on an anonymous, public surface. ` +
        `Fix the items above, then re-run this gate.`,
    );
    process.exit(1);
  }
  console.log("✓ Public network deploy preflight passed — every dependency is in place.");
  process.exit(0);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /preflight-public-network\.(ts|js|cjs|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  void main();
}
/* c8 ignore stop */
