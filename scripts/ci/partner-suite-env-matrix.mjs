/**
 * PER-SUITE PARTNER CI ENVIRONMENT MATRIX (durable, non-secret).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Partner suites do NOT share one database topology, and pinning one
 * `MINTVAULT_DATABASE_URL` globally is actively wrong. `assertPartnerAccountingDatabaseTopology()`
 * (server/partner/db.ts) requires that MINTVAULT_DATABASE_URL, PARTNER_ADMIN_DATABASE_URL,
 * PARTNER_DATABASE_URL and PARTNER_CONNECTOR_DATABASE_URL all resolve to the SAME database
 * identity. A global pin therefore collides with every suite that provisions its own database:
 * the suite points its accounting URLs at its own DB, the global pin points MINTVAULT elsewhere,
 * the topology assertion throws, and the suite reports an ENVIRONMENT ABORT that looks exactly
 * like a source defect. That is what produced the "RBAC failures" — a topology collision, not a
 * code fault.
 *
 * A second, subtler collision: vitest shares `process.env` between test files executed by the same
 * worker. Several Partner suites assign MINTVAULT_/PARTNER_*_DATABASE_URL in their own `beforeAll`.
 * Two such suites in one worker race each other. Every suite marked `isolate: true` below must
 * therefore be launched as its OWN vitest invocation, not merely as its own file.
 *
 * NON-SECRET BY CONSTRUCTION
 * --------------------------
 * Every credential here is the well-known throwaway superuser of a LOOPBACK-ONLY disposable
 * container (`postgres:postgres@127.0.0.1`). These clusters hold no real data, are never reachable
 * off-host, and are recreated from scratch. Nothing in this file is a secret and nothing in this
 * file may ever be pointed at staging or production — see `assertDisposable()`.
 *
 * CONSUMED BY: scripts/ci/run-partner-suite.mjs
 */

/** Disposable loopback clusters. Ports are fixed by the CI container provisioning step. */
export const CLUSTERS = {
  /** PostgreSQL 16 + pgvector — the MintVault-compatible shared cluster. */
  pg16: { host: "127.0.0.1", port: 55432, user: "postgres", password: "postgres" },
  /** PostgreSQL 17.10 — Partner accounting, RBAC, connector and migration suites. */
  pg17: { host: "127.0.0.1", port: 55433, user: "postgres", password: "postgres" },
};

/** Build a connection URL for a database on a named cluster. */
export function urlFor(cluster, database) {
  const c = CLUSTERS[cluster];
  if (!c) throw new Error(`unknown cluster '${cluster}'`);
  return `postgresql://${c.user}:${c.password}@${c.host}:${c.port}/${database}`;
}

/**
 * Refuse to run against anything that is not a disposable loopback cluster. This is the hard
 * stop that keeps the matrix from ever being aimed at staging or production.
 */
export function assertDisposable(url, label) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`${label} must be a disposable loopback database; refusing host '${host}'.`);
  }
}

/**
 * TOPOLOGY CLASSES — the five shapes a Partner suite can need.
 *
 *  self_provisioned      the suite starts its OWN disposable PostgreSQL 17 via
 *                        tests/helpers/postgres17-cluster.ts. It needs NO database URL at all;
 *                        it needs only a PostgreSQL 17.10 binary or a working docker.
 *  admin_only            the suite needs exactly one privileged URL in its own `*_ADMIN` var and
 *                        assigns any accounting URLs itself. No global pin.
 *  accounting_pinned     MINTVAULT_DATABASE_URL *and* all three PARTNER_*_DATABASE_URL vars must be
 *                        pinned TOGETHER to this suite's own database, or the topology assertion
 *                        aborts the suite.
 *  runtime_restricted    as accounting_pinned, plus PARTNER_DATABASE_URL must be the RESTRICTED
 *                        partner_runtime login (never the privileged one) so RLS is actually in force.
 *  management            the internal Super-Admin management database.
 */
export const TOPOLOGY = {
  SELF: "self_provisioned",
  ADMIN: "admin_only",
  ACCOUNTING: "accounting_pinned",
  RUNTIME: "runtime_restricted",
  MANAGEMENT: "management",
};

/**
 * The Partner suites this repair pass treats as CRITICAL. `critical: true` means: a skip or an
 * environment abort is a BUILD FAILURE, not an acceptable local convenience.
 *
 * `adminVars`  — vars that receive this suite's privileged URL.
 * `pinAccounting` — also pin MINTVAULT_DATABASE_URL + the three PARTNER_*_DATABASE_URL vars to the
 *                   SAME database (required whenever the suite reaches credit-settlement code).
 * `runtimeRole` — when set, PARTNER_DATABASE_URL is built for this restricted login instead of the
 *                 privileged superuser, so RLS is genuinely enforced rather than bypassed.
 * `isolate`    — must be its own vitest invocation (it mutates shared process.env).
 */
export const SUITES = [
  // ---------------------------------------------------------------- self-provisioning
  {
    file: "tests/partner-per-card-credit-lifecycle.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "starts its own PostgreSQL 17 cluster; needs POSTGRES17_BIN or docker, no URL.",
  },
  {
    file: "tests/partner-0042-state-semantics.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "Defect 1 behavioural proof at 1, 2 and 20 cards; own disposable cluster.",
  },
  {
    file: "tests/partner-recovery-cardinality.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "Defect 4 N-card recovery proof; own disposable cluster.",
  },
  {
    file: "tests/partner-definer-transitive-reachability.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "Defect 2 transitive role-graph proof; own cluster, must NOT run as superuser.",
  },
  {
    file: "tests/partner-wallet-provisioning.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "ensureWallet had no caller in server/, so no ACTIVE org ever got a wallet and every credit path 404'd; own cluster.",
  },
  {
    file: "tests/partner-completion-cascade.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note:
      "the only suite that runs the partner completion cascade — applies 0045 so the " +
      "to_regclass guard opens, then calls the real markCompleted; own disposable cluster.",
  },
  {
    file: "tests/partner-submission-lifecycle-migration.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "0044 widens the submission status domain past handover and pins the immutable location snapshot; own cluster.",
  },

  // ---------------------------------------------------------------- admin-only (migration proofs)
  {
    file: "tests/partner-rbac-migration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_rbac_mig",
    adminVars: ["PARTNER_RBAC_MIG_ADMIN"],
    critical: true,
    isolate: true,
    note: "assigns MINTVAULT_/PARTNER_ADMIN_/PARTNER_DATABASE_URL itself from its own ADMIN var.",
  },
  {
    file: "tests/partner-rbac-bootstrap.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_rbac_rt",
    adminVars: ["PARTNER_RBAC_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "same self-assignment pattern; a global MINTVAULT pin is what previously collided here.",
  },
  {
    file: "tests/partner-definer-ownership.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_definer",
    adminVars: ["PARTNER_DEFINER_ADMIN"],
    critical: true,
    isolate: true,
  },
  {
    file: "tests/partner-rollback.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note:
      "MUST own its whole cluster — it DROPs cluster-global roles, so any sibling database holding " +
      "objects owned by those roles makes DROP ROLE fail. Starts its own disposable PostgreSQL 17.",
  },

  // ---------------------------------------------------------------- restricted runtime + RLS
  {
    file: "tests/partner-rls-isolation.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_rls",
    adminVars: ["PARTNER_RLS_DB"],
    critical: true,
    isolate: true,
    note:
      "Defect 3. PARTNER_RLS_DB provisions ONLY. The proof itself drops to partner_runtime via " +
      "SET ROLE and asserts NOSUPERUSER + NOBYPASSRLS + FORCE RLS + tenant GUC before making any " +
      "isolation claim, so the privileged provisioning connection cannot make the proof vacuous. " +
      "Accounting URLs are deliberately NOT pinned: this suite never enters settlement code.",
  },

  // ---------------------------------------------------------------- accounting-pinned
  {
    file: "tests/partner-db-topology.test.ts",
    topology: TOPOLOGY.ACCOUNTING,
    cluster: "pg17",
    database: "mintvault_partner_runtime",
    adminVars: [],
    pinAccounting: true,
    critical: true,
    isolate: true,
    note: "the suite that exists to prove the topology rule; all four URLs pinned together.",
  },
  /**
   * These three START THEIR OWN disposable PostgreSQL 17 cluster and then assign
   * MINTVAULT_DATABASE_URL themselves while DELETING PARTNER_ADMIN_DATABASE_URL /
   * PARTNER_DATABASE_URL. Supplying accounting URLs to them is not merely unnecessary, it is
   * actively wrong: the inherited values fight the ones the suite sets in beforeAll.
   */
  {
    file: "tests/partner-credit-admin-service.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
  },
  {
    file: "tests/partner-credit-reservation-service.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
  },
  {
    file: "tests/partner-wallet-service.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
  },

  // ---------------------------------------------------------------- management
  {
    file: "tests/partner-management-migration.test.ts",
    topology: TOPOLOGY.MANAGEMENT,
    cluster: "pg17",
    database: "mintvault_partner_mgmt_mig",
    adminVars: ["PARTNER_MANAGEMENT_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
  },
  {
    // Registered after it caught a regression the matrix could not: activation began provisioning
    // a wallet, this suite's migration list had no partner_wallets, and every activation 500'd.
    // `run-partner-suite.mjs --all` was green throughout, because only the *migration* sibling was
    // listed here — the HTTP suite that actually drives changeStatus was not. A matrix that omits
    // the suite exercising a behaviour cannot prove that behaviour.
    file: "tests/partner-management-integration.test.ts",
    topology: TOPOLOGY.MANAGEMENT,
    cluster: "pg17",
    database: "mintvault_partner_mgmt_rt",
    adminVars: ["PARTNER_MANAGEMENT_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "real HTTP against the main-app composition; shares its database with the dashboard suite, so both reset the schema.",
  },
  {
    file: "tests/partner-dashboard-integration.test.ts",
    topology: TOPOLOGY.MANAGEMENT,
    cluster: "pg17",
    database: "mintvault_partner_mgmt_rt",
    adminVars: ["PARTNER_MANAGEMENT_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "Super Admin /credits/adjust over real HTTP — the route the pilot funds credits through.",
  },
  {
    file: "tests/partner-user-management-migration.test.ts",
    topology: TOPOLOGY.MANAGEMENT,
    cluster: "pg17",
    database: "mintvault_partner_user_mgmt",
    adminVars: ["PARTNER_USER_MGMT_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
  },
];

/**
 * Resolve the exact environment for one suite. Returns ONLY the vars that suite needs — it never
 * sets a variable globally, which is the whole point of the matrix.
 */
export function envForSuite(suite) {
  const env = {};
  if (suite.topology === TOPOLOGY.SELF) return env;

  const url = urlFor(suite.cluster, suite.database);
  assertDisposable(url, suite.file);

  for (const v of suite.adminVars ?? []) env[v] = url;

  if (suite.pinAccounting || suite.topology === TOPOLOGY.RUNTIME) {
    // All four must agree or assertPartnerAccountingDatabaseTopology() aborts the suite.
    env.MINTVAULT_DATABASE_URL = url;
    env.PARTNER_ADMIN_DATABASE_URL = url;
    env.PARTNER_CONNECTOR_DATABASE_URL = url;
    env.PARTNER_DATABASE_URL = suite.runtimeRole
      ? url.replace("postgres:postgres@", `${suite.runtimeRole}:${suite.runtimeRole}@`)
      : url;
  }
  return env;
}

export function findSuite(file) {
  return SUITES.find((s) => s.file === file);
}

export const CRITICAL_SUITES = SUITES.filter((s) => s.critical);
