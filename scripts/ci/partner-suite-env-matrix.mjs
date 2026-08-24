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

/**
 * Disposable loopback clusters. CI keeps the conventional ports; local release
 * verification may opt into distinct loopback ports so concurrent candidates
 * never share or interrupt a disposable database.
 */
function localTestPort(variable, fallback) {
  const value = String(process.env[variable] || fallback);
  if (!/^\d{2,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${variable} must be an unprivileged local TCP port, got '${value}'.`);
  }
  return Number(value);
}

export const CLUSTERS = {
  /** PostgreSQL 16 + pgvector — the MintVault-compatible shared cluster. */
  pg16: { host: "127.0.0.1", port: localTestPort("MINTVAULT_TEST_PG16_PORT", "55432"), user: "postgres", password: "postgres" },
  /** PostgreSQL 17.10 — Partner accounting, RBAC, connector and migration suites. */
  pg17: { host: "127.0.0.1", port: localTestPort("MINTVAULT_TEST_PG17_PORT", "55433"), user: "postgres", password: "postgres" },
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
    file: "tests/partner-submission-lifecycle-migration.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "0044 widens the submission status domain past handover and pins the immutable location snapshot; own cluster.",
  },

  // ------------------------------------------------- P3–P9 pilot authority (self-provisioning)
  //
  // WHY THESE WERE ADDED (2026-08-13). Every suite below was written during P3–P9 and proven at
  // the time by running it on its own. None was ever entered into this matrix, so the "critical
  // Partner runner" — the gate every phase closes on — did not execute a single one of them. The
  // Card Job authority, the credit settlement edge, Scanner NEW, Scanner FIX, the grading edit
  // lease, multi-location, SCANNER_OPERATOR and both step-up ladders were all outside the gate.
  //
  // That is not a theoretical gap. Running these ten files in ONE bare `vitest run` reproduces the
  // exact silent-green this matrix exists to kill: tests/partner-station-new-card.test.ts drops 19
  // of its 27 assertions — the last-credit race, the replay proofs, the cross-tenant refusal, the
  // MV uniqueness proof — and the run still exits 0. The suites self-provision a PostgreSQL 17
  // container each and assign MINTVAULT_/PARTNER_*_DATABASE_URL in their own beforeAll, so sharing
  // a worker is precisely the process.env race documented at the top of this file.
  //
  // `isolate: true` is therefore load-bearing on every one of them, and `critical: true` means the
  // runner's existing "ANY skip reddens the run" rule now actually covers the pilot authority.
  {
    file: "tests/partner-card-job-authority.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P3 canonical Card Job: atomic credit reservation + creation, certificate/MV binding; own cluster.",
  },
  {
    file: "tests/partner-credit-purchase.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P5 Stripe purchase/grant/refund into the Grading Credit authority; own cluster.",
  },
  {
    file: "tests/partner-station-new-card.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P6 Scanner NEW: last-credit race, replay, MV uniqueness, cross-tenant refusal; own cluster. Loses 19 assertions if it shares a worker.",
  },
  {
    file: "tests/partner-scanner-fix.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P7 Scanner FIX: zero-credit replacement on the same Card Job/MV/certificate lineage; own cluster.",
  },
  {
    file: "tests/partner-multi-location.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "AG-1 multi-location: location-scoped FIX queue and start authority; own cluster.",
  },
  {
    file: "tests/partner-scanner-operator-role.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "AG-2 SCANNER_OPERATOR least privilege, read back from the seeded catalogue; own cluster.",
  },
  {
    file: "tests/partner-step-up-auth.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "AG-3 Partner step-up on credits checkout, invites, role/status change, session revocation; own cluster.",
  },
  {
    file: "tests/partner-admin-step-up.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "AG-3b Super Admin step-up on destructive admin actions; own cluster.",
  },
  {
    file: "tests/partner-dashboard-operations.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P8 operational console: one tenant-scoped service, server-derived buckets and readiness; own cluster.",
  },
  {
    file: "tests/partner-grading-lease.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P9 grading edit lease: one-winner race, expiry, takeover, stale-revision refusal, I19 restart; own cluster.",
  },
  {
    /*
     * THE CARD JOB → CANONICAL GRADING BRIDGE (AT-B1..AT-B23).
     *
     * The gap this closes was not a missing test — it was a missing PATH. Partner grading resolved
     * ownership entirely through partner_connector_imports, which a Scanner-created Card Job matches
     * zero rows in, and nothing in the repository drove partner_card_jobs.status beyond FIX_REQUIRED.
     * So a card a shop had already paid a Grading Credit for could be captured and then never graded,
     * never submitted, never reviewed and never printed.
     *
     * Every case runs against real PostgreSQL because every guarantee is a database one: the connector
     * JOIN chain that must NOT match, the Card Job EXISTS arm that must, 0080's ENABLE ALWAYS
     * transition trigger, RLS tenant isolation, FOR UPDATE serialisation and the credit engine's
     * idempotency uniqueness. The two properties that matter most — no double submit and no double
     * settlement on retry — are exactly the ones a mocked database would pass with the protection
     * deleted, so the concurrent cases run genuinely in parallel on separate pool connections.
     *
     * `isolate: true` for the same reason as every suite above it: this one self-provisions a
     * PostgreSQL 17 container and assigns MINTVAULT_DATABASE_URL in its own beforeAll, so sharing a
     * vitest worker is the documented process.env race.
     */
    file: "tests/partner-card-job-grading-bridge.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "Card Job → grading bridge: Scanner NEW reaches Ready to Grade, lease-as-assignment, write guard, submit→QA, exactly-once credit settlement, RETURN/APPROVE, lineage-split print eligibility; own cluster.",
  },
  {
    /*
     * AT-21 — WEBHOOK GRANT UNDER CONCURRENT NEW. The grant boundary itself.
     *
     * Two halves of AT-21 were already proven and neither was the thing AT-21 asks about:
     * partner-credit-purchase proves grant idempotency with nothing else happening, and L1 proves the
     * last-credit race with capacity static throughout. AT-21 is the MOMENT BETWEEN — capacity zero,
     * stations hammering NEW, and a verified webhook granting ten credits mid-flight.
     *
     * FOUND A REAL DEFECT ON FIRST RUN. The money was always right (the ledger's (source,
     * idempotency_key) uniqueness refuses the second row under four-way concurrent delivery), but
     * `fulfilPartnerCreditPurchase` discarded `alreadyApplied` and every delivery reported
     * `granted: true`. The webhook handler LOGS that value, so an ordinary Stripe redelivery storm
     * wrote repeated "granted" lines for one purchase — poisoning the one signal an operator would
     * use to spot a genuine double-grant. Fixed, not assertion-weakened.
     *
     * The overlap is produced by NEW workers retrying across the boundary, never by a sleep, and the
     * race is repeated over independent iterations because one lucky ordering proves nothing.
     */
    file: "tests/partner-at21-grant-boundary.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "AT-21 grant boundary: concurrent webhook grant + NEW, exactly-once grant, exactly 10 jobs then refusal, live-derived capacity, op-key and webhook replay idempotency, two stations, tenant isolation, cold-start authority; own cluster.",
  },
  {
    /*
     * P13 — LOAD AND CONCURRENCY. Correctness outranks throughput.
     *
     * Every invariant that can only break under contention, driven GENUINELY in parallel through
     * Promise.all on separate pool connections. Run sequentially every case here would pass with the
     * locking removed entirely, which is worse than having no test.
     *
     * What it measures is whether the contention points serialise: the wallet row lock (12 NEW
     * presses against 5 credits), the cert_counter row lock (no duplicate MV), the lease's partial
     * unique index (8 graders, one editor), the Card Job FOR UPDATE plus the credit engine's
     * idempotency key (10 concurrent submits, one settlement), and RLS/tenant predicates under
     * simultaneous two-tenant load. A global invariant sweep runs after EVERY case, so a violation
     * introduced by one is not first detected six cases later.
     *
     * Deliberately NOT a throughput benchmark: a latency figure from one laptop against a container
     * transfers nothing to a shop floor, and tuning to it would be optimising a fiction.
     */
    file: "tests/partner-pilot-concurrency.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P13 concurrency: last-credit race, double-click idempotency, lease contention, concurrent submit settlement, cross-tenant/cross-location isolation, concurrent redrive, no premature output, sustained mixed workload; own cluster.",
  },
  {
    /*
     * P12 — THE ONE DOCUMENTED MEDIUM, PROVEN REPAIRABLE.
     *
     * QA approval publishes the certificate on the HQ pool and transitions the Card Job on the
     * partner-admin pool; those cannot be one transaction without restructuring protected HQ grading
     * infrastructure. A crash between them leaves an approved grade whose Card Job never left
     * QA_REVIEW — fail-closed (output is refused), but stuck for ever with nobody told.
     *
     * This suite simulates the failure at exactly that seam and proves the whole loop: output stays
     * blocked, reconciliation detects by the documented predicate, redrive repairs through the
     * canonical transition authority, a SECOND redrive performs nothing, the wallet never moves, no
     * certificate or MV is minted, and the repair is audited AS a repair. It also proves the refusal
     * path: an item whose premise no longer holds is left fail-closed rather than advanced.
     *
     * Critical because the release bar requires this MEDIUM to have executable proof before RC.
     */
    file: "tests/partner-card-job-reconciliation.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P12 QA/Card Job split-transaction drift: simulated mid-approval failure, fail-closed output, detection, idempotent redrive, zero wallet movement, audited repair, refusal path; own cluster.",
  },
  {
    /*
     * P11 — OUTPUT: CERTIFICATE / LABEL / PRINT / NFC (AT-P1..AT-P15).
     *
     * Proves a Scanner-created Card Job travels the EXISTING MintVault output systems to a finished
     * physical product carrying ONE identity: same Card Job, same MV, same certificate, before and
     * after. It drives the REAL `approveGraderCert` (publish gates and CAS included), the REAL
     * `requestReprint` / `markCompleted`, the REAL `getPartnerPrintEligibilityBlocks` and the REAL
     * `certificateOrigin` — no second output system was built and none is under test.
     *
     * Two release-critical properties here are constraints, not code, and would be vacuous without a
     * real database: 0035's ENABLE ALWAYS origin-immutability trigger (a partner rename must not
     * rewrite historical provenance) and 0088's partial unique index on lower(nfc_uid) (one physical
     * chip must not bind to two graded cards — previously guarded only by a racy read-then-write).
     */
    file: "tests/partner-card-job-output.test.ts",
    topology: TOPOLOGY.SELF,
    critical: true,
    isolate: true,
    note: "P11 output: APPROVED→PRINTABLE→COMPLETED, pre-approval refusal, immutable provenance, approved==rendered grade, zero-credit reprint, NFC approval guard + 0088 uniqueness, correction does not fork identity; own cluster.",
  },

  // ------------------------------------------------- env-gated suites nothing was setting up
  //
  // Both of these gate themselves on an env var and SKIP when it is absent, and no runner ever
  // supplied one. `npx vitest run` reports "1 skipped" and exits 0, so 33 real-database proofs —
  // including the AG-1 location-suspend behaviour and the profile version/audit proofs — had never
  // run in this programme. A suite that fails closed to "skipped" is only honest if something is
  // actually expected to open it.
  {
    file: "tests/partner-management-ux-runtime.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_ux_rt",
    adminVars: ["PARTNER_UX_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "Gated on PARTNER_UX_RT_ADMIN; proves each write bumps partner_profiles.version by exactly 1 and every audit action passes the CHECK constraint.",
  },
  {
    file: "tests/partner-admin-control-shell-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_admin_shell",
    adminVars: ["PARTNER_ADMIN_TEST"],
    // The app under test must run on the RESTRICTED login or its cross-tenant refusals prove
    // nothing. The suite CREATES this role itself (LOGIN PASSWORD 'synthetic', GRANT
    // partner_runtime), and the partner runtime refuses a BYPASSRLS credential outright — which is
    // why the admin URL cannot simply be reused. Values match .github/workflows/ci.yml exactly.
    runtimeVars: ["PARTNER_ADMIN_TEST_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_shell", password: "synthetic" },
    /*
     * CRITICAL. Supplying the env this suite always wanted made it run for the first time in this
     * programme, and it failed 5 of 11 — partner suspend, location suspend, user suspend, session
     * revocation and emergency stop, all release-critical controls. Verified pre-existing: the
     * identical five failed at the clean checkpoint 3f775f13. Three separate pieces of fixture rot
     * had accumulated behind the skip, each from a real hardening the fixture never caught up with:
     * 0077's password_set_at credential-provenance rule, P2's mandatory MFA, and AG-3b's step-up.
     * All three are repaired in the suite; it is now 11/11 and gates the rest of the work.
     */
    critical: true,
    isolate: true,
    note: "Gated on PARTNER_ADMIN_TEST + PARTNER_ADMIN_TEST_RUNTIME; real requireAdmin over the real app. Partner/location/user suspension, session revocation, emergency stop and MFA reset.",
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
    seedCoreStubs: true,
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

  // -------------------------------------------------- RC-F10: the suites that caught RC-F9
  //
  // WHY THESE WERE ADDED (2026-08-15). All three run in CI's bare `vitest run` and all three were
  // OUTSIDE this matrix, so the "critical Partner runner" — the gate every phase closes on —
  // reported 36 suites / 691 passed / 0 failed while none of them executed. That is exactly the
  // silent-green this file exists to kill, and it was not theoretical: these three, and only these
  // three, caught RC-F9 (partner step-up enforced server-side with no client flow, which blocked
  // the credit-purchase revenue path). The local gate was green through the entire pass.
  //
  // Every value below matches .github/workflows/ci.yml exactly, so the runner and CI provision the
  // same databases and the same restricted logins. Each suite CREATES its own role in beforeAll and
  // drops it in afterAll; roles are cluster-scoped and survive the runner's DROP/CREATE DATABASE,
  // which is why that provisioning is written to be idempotent.
  {
    file: "tests/partner-runtime-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_runtime",
    adminVars: ["PARTNER_RT_ADMIN"],
    // The app under test must run on the RESTRICTED login or its tenant-isolation refusals prove
    // nothing. Accounting URLs are assigned by the suite itself, so this is ADMIN, not RUNTIME.
    runtimeVars: ["PARTNER_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_rt", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "Partner Portal over real HTTP: auth, RBAC, tenant isolation, team management and the AG-3 step-up challenge/prove/retry cycle. Shares its database name with partner-db-topology; the runner recreates it per suite and runs serially.",
  },
  {
    file: "tests/partner-onboarding-matrix.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_mount",
    adminVars: ["PARTNER_MOUNT_RT_ADMIN"],
    runtimeVars: ["PARTNER_MOUNT_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_mount", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "invitation onboarding end to end, including the zero-Resend-traffic proof that no real email transport is reached.",
  },
  {
    file: "tests/partner-admin-capability.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_capability",
    adminVars: ["PARTNER_CAPABILITY_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "readiness passes on the dedicated BYPASSRLS admin role while the runtime stays non-BYPASSRLS — the property that keeps RLS in force in production.",
  },

  // ---------- RC-F10: the remaining DB-gated Partner suites, previously outside the gate ----------
  //
  // Every suite below is guarded by an env check (describe.skipIf(!URL), or the
  // `const suite = URL ? describe : describe.skip` idiom). Outside this matrix they SILENTLY SKIP
  // locally, so the pinned gate reported green while none of them ran — the same silent-green that
  // let RC-F9 reach a pushed RC. CI already provisions each database and restricted login, so every
  // value here is copied from .github/workflows/ci.yml rather than invented, and `critical: true`
  // means the runner's "any skip or abort reddens the run" rule now actually covers them.
  //
  // Domains this closes: AUTH (lockout decay/recovery, login rate limiting, MFA enrolment and factor
  // hardening, reset delivery), RBAC (final-owner invariant), DASHBOARD, CERT/PRINT (partner origin),
  // the whole external-partner CONNECTOR intake path, portal mount, and the submission/workflow APIs.
  {
    file: "tests/partner-certificate-origin.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_cert_origin",
    adminVars: ["PARTNER_CERT_ORIGIN_ADMIN"],
    critical: true,
    isolate: true,
    note: "immutable Partner origin snapshot rendered on the certificate — CERT/PRINT domain.",
  },
  {
    file: "tests/partner-connector-admin-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_ops",
    adminVars: ["PARTNER_CONNECTOR_ADMIN_TEST"],
    runtimeVars: ["PARTNER_CONNECTOR_ADMIN_TEST_RUNTIME"],
    runtimeLogin: { user: "partner_connector_ops_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector admin surface over real HTTP.",
  },
  {
    file: "tests/partner-connector-admin-migration.test.ts",
    seedCoreStubs: true,
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_admin_mig",
    adminVars: ["PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
    note: "connector admin migration lineage.",
  },
  {
    file: "tests/partner-connector-fault-injection.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_fault",
    adminVars: ["PARTNER_CONNECTOR_FAULT_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_FAULT_RT_URL"],
    runtimeLogin: { user: "partner_connector_fault_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector behaviour under injected provider faults.",
  },
  {
    file: "tests/partner-connector-g3f-blockers.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_blocker",
    adminVars: ["PARTNER_CONNECTOR_BLOCKER_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_BLOCKER_RT_URL"],
    runtimeLogin: { user: "partner_connector_blocker_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "G3F connector blockers, proven against the restricted login.",
  },
  {
    file: "tests/partner-connector-import-migration.test.ts",
    seedCoreStubs: true,
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_import_mig",
    adminVars: ["PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
    note: "connector import migration lineage.",
  },
  {
    file: "tests/partner-connector-import-service.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_import",
    adminVars: ["PARTNER_CONNECTOR_IMPORT_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_IMPORT_RT_URL"],
    runtimeLogin: { user: "partner_connector_import_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector import service — external-partner intake path.",
  },
  {
    file: "tests/partner-connector-migration.test.ts",
    seedCoreStubs: true,
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_migration",
    adminVars: ["PARTNER_CONNECTOR_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
    note: "connector migration lineage.",
  },
  {
    file: "tests/partner-connector-query-plan.test.ts",
    seedCoreStubs: true,
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_plan",
    adminVars: ["PARTNER_CONNECTOR_PLAN_ADMIN"],
    critical: true,
    isolate: true,
    note: "connector query plans stay indexed at pilot scale.",
  },
  {
    file: "tests/partner-connector-reconciliation-concurrency.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_recon_load",
    adminVars: ["PARTNER_CONNECTOR_RECON_LOAD_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_RECON_LOAD_RT_URL"],
    runtimeLogin: { user: "partner_connector_load_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector reconciliation under concurrency.",
  },
  {
    file: "tests/partner-connector-reconciliation-service.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_recon",
    adminVars: ["PARTNER_CONNECTOR_RECON_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_RECON_RT_URL"],
    runtimeLogin: { user: "partner_connector_recon_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector reconciliation service.",
  },
  {
    file: "tests/partner-connector-runtime.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_runtime",
    adminVars: ["PARTNER_CONNECTOR_RUNTIME_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_RUNTIME_URL"],
    runtimeLogin: { user: "partner_connector_rt_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector runtime on the restricted login.",
  },
  {
    file: "tests/partner-connector-scale.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_scale",
    adminVars: ["PARTNER_CONNECTOR_SCALE_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_SCALE_RT_URL"],
    runtimeLogin: { user: "partner_connector_scale_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector behaviour at volume.",
  },
  {
    file: "tests/partner-connector-service.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_service",
    adminVars: ["PARTNER_CONNECTOR_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_RT_URL"],
    runtimeLogin: { user: "partner_connector_app_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector service core.",
  },
  {
    file: "tests/partner-connector-validation-migration.test.ts",
    seedCoreStubs: true,
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_val_mig",
    adminVars: ["PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN"],
    critical: true,
    isolate: true,
    note: "connector validation migration lineage.",
  },
  {
    file: "tests/partner-connector-validation-service.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_connector_validation",
    adminVars: ["PARTNER_CONNECTOR_VALIDATION_RT_ADMIN"],
    runtimeVars: ["PARTNER_CONNECTOR_VALIDATION_RT_URL"],
    runtimeLogin: { user: "partner_connector_val_app_test", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "connector validation service.",
  },
  {
    file: "tests/partner-dashboard-risk-equivalence.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_rt",
    adminVars: ["PARTNER_MANAGEMENT_RT_ADMIN"],
    critical: true,
    isolate: true,
    note: "DASHBOARD: admin risk view equivalence.",
  },
  {
    file: "tests/partner-final-owner-invariant.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_final_owner",
    adminVars: ["PARTNER_FINAL_OWNER_ADMIN"],
    critical: true,
    isolate: true,
    note: "RBAC: a tenant can never lose its last active OWNER.",
  },
  {
    file: "tests/partner-integration-seams.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_mount",
    adminVars: ["PARTNER_MOUNT_RT_ADMIN"],
    runtimeVars: ["PARTNER_MOUNT_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_mount", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "seams between the Portal mount and the main app composition.",
  },
  {
    file: "tests/partner-lockout-decay.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_lockout_decay",
    adminVars: ["PARTNER_LOCKOUT_DECAY_RT_ADMIN"],
    runtimeVars: ["PARTNER_LOCKOUT_DECAY_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_lockdecay", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: login lockout decays correctly rather than never releasing.",
  },
  {
    file: "tests/partner-lockout-recovery.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_lockout",
    adminVars: ["PARTNER_LOCKOUT_RT_ADMIN"],
    runtimeVars: ["PARTNER_LOCKOUT_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_lockout", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: lockout recovery path.",
  },
  {
    file: "tests/partner-login-rate-limit-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_public",
    adminVars: ["PARTNER_PUBLIC_RT_ADMIN"],
    runtimeVars: ["PARTNER_PUBLIC_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_public", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: login rate limiting over real HTTP.",
  },
  {
    file: "tests/partner-mfa-enrolment-mandatory.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_mfa_enrol",
    adminVars: ["PARTNER_MFA_ENROL_RT_ADMIN"],
    runtimeVars: ["PARTNER_MFA_ENROL_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_mfa_enrol", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: MFA enrolment is mandatory and cannot be skipped.",
  },
  {
    file: "tests/partner-mfa-factor-hardening.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_mfa_hardening",
    adminVars: ["PARTNER_MFA_HARDENING_RT_ADMIN"],
    runtimeVars: ["PARTNER_MFA_HARDENING_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_mfa_hard", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: second-factor hardening.",
  },
  {
    file: "tests/partner-portal-mount-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_mount",
    adminVars: ["PARTNER_MOUNT_RT_ADMIN"],
    runtimeVars: ["PARTNER_MOUNT_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_mount", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "the Portal is actually mounted in the composed app — the check that caught a dead surface before.",
  },
  {
    file: "tests/partner-public-routes-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_public",
    adminVars: ["PARTNER_PUBLIC_RT_ADMIN"],
    runtimeVars: ["PARTNER_PUBLIC_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_public", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "public partner routes over real HTTP.",
  },
  {
    file: "tests/partner-reset-delivery-integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_public",
    adminVars: ["PARTNER_PUBLIC_RT_ADMIN"],
    runtimeVars: ["PARTNER_PUBLIC_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_public", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "AUTH: password-reset delivery.",
  },
  {
    file: "tests/partner-submission-workflow.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_runtime",
    adminVars: ["PARTNER_RT_ADMIN"],
    runtimeVars: ["PARTNER_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_rt", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "submission workflow end to end.",
  },
  {
    file: "tests/partner-workflow-apis.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_partner_runtime",
    adminVars: ["PARTNER_RT_ADMIN"],
    runtimeVars: ["PARTNER_RT_RUNTIME"],
    runtimeLogin: { user: "partner_app_test_rt", password: "synthetic" },
    critical: true,
    isolate: true,
    note: "workflow APIs end to end.",
  },

  // ---------------- RC-F14: scanner suites that previously ran in NO environment ----------------
  //
  // Both are gated on an env var that was set NOWHERE — not in .github/workflows/ci.yml, not here —
  // so `describe.skip` took each file locally AND in CI while their presence implied coverage.
  // scanner-production-migration additionally required port 5432 exactly, which no disposable
  // cluster in this repository uses, so it could not have run even if the variable were set.
  //
  // Both keep their own disposability guards (loopback host + a mintvault_dgn_* database name), so
  // neither can be aimed at staging or production regardless of what is passed here.
  {
    file: "tests/scanner-production-migration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg17",
    database: "mintvault_dgn_release_scanner",
    adminVars: ["SCANNER_MIGRATION_TEST_DATABASE_URL"],
    critical: true,
    isolate: true,
    note: "applies the REAL scanner production migrations 0045-0047 against a disposable cluster.",
  },
  {
    file: "tests/scanner-evidence-staging-service.integration.test.ts",
    topology: TOPOLOGY.ADMIN,
    cluster: "pg16",
    database: "mintvault_dgn_evidence",
    adminVars: ["SCANNER_STAGING_TEST_DATABASE_URL"],
    critical: true,
    isolate: true,
    note: "scanner evidence staging service against real PostgreSQL; pg16 because the suite accepts ports 5432/55432.",
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

  // Vars that must receive the RESTRICTED login rather than the privileged one. A suite that drives
  // the app end to end needs both: the privileged URL to build its fixture, and the runtime URL the
  // app itself uses — handing it the privileged URL for both would silently disable RLS and turn an
  // isolation proof into a test that cannot fail.
  for (const v of suite.runtimeVars ?? []) {
    const login = suite.runtimeLogin;
    env[v] = login ? url.replace("postgres:postgres@", `${login.user}:${login.password}@`) : url;
  }

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
