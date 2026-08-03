/**
 * Super Admin Partner Master Dashboard — READ-ONLY service.
 *
 * Every function here is a SELECT. This module contains no INSERT/UPDATE/DELETE and must
 * never gain one: the dashboard is an observation surface, and the credit ledger in
 * particular is append-only with its own hardened write path (partner-credit-admin-service).
 *
 * Data path: `partnerAdminQuery` — the existing privileged, cross-tenant admin pool
 * (server/partner/db.ts). That pool does NOT apply RLS, so EVERY tenant-scoped query below
 * carries an explicit `WHERE tenant_id = $n`. This mirrors what every existing admin partner
 * service already does.
 *
 * SQL discipline (matches the house pattern in partner-management-service.ts):
 *   - user values ALWAYS travel as $n parameters, never string-spliced
 *   - column and ORDER BY names come only from hardcoded constants / allowlists
 *   - explicit column lists, never SELECT * (a future secret column must not auto-publish)
 *
 * Secret columns deliberately never selected anywhere in this file:
 *   partner_users.password_hash, partner_sessions.token_hash, partner_mfa_methods.secret_ref,
 *   partner_mfa_methods.last_totp_counter, partner_recovery_codes.code_hash,
 *   partner_password_reset_tokens.token_hash.
 */
import { partnerAdminQuery } from "./db";
import {
  BOTTLENECK_STATES,
  clampDashboardPagination,
  DASHBOARD_CONNECTOR_STATES,
  DASHBOARD_SUBMISSION_STATUSES,
  metric,
  RISK_RANK,
  sortAlerts,
  unavailable,
  type AuditTimelineEntry,
  type DashboardAlert,
  type LedgerEntryView,
  type MetricUnavailable,
  type NetworkSummary,
  type Paged,
  type PartnerCorrectionsView,
  type PartnerDevicesView,
  type PartnerOverview,
  type PartnerQualityView,
  type PartnerRisk,
  type PartnerSecurityView,
  type PartnerSortKey,
  type PartnerStaffRow,
  type PartnerSubmissionsView,
  type PartnerTableRow,
  type PartnerWalletView,
  type RiskLevel,
  type SortDirection,
} from "@shared/partner-dashboard";

/** Postgres "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

export class DashboardError extends Error {
  constructor(
    public code: "PARTNER_NOT_FOUND" | "INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "DashboardError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fail closed on a malformed id BEFORE it reaches Postgres. Without this a non-UUID param
 * raises 22P02 deep in the driver and surfaces as an opaque 500 (the existing admin partner
 * routes have exactly that gap).
 */
export function requirePartnerId(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new DashboardError("INVALID_INPUT", "A valid partner id is required.");
  }
  return raw;
}

/**
 * The wallet/reservation tables arrive in migrations 0016/0017. Those are confirmed applied on
 * staging but their production state is UNVERIFIED. Rather than 500 the entire dashboard on an
 * environment where they are absent, wallet reads degrade to null and the UI says so.
 */
async function tolerateMissingTable<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string })?.code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Zero-filled bucket map so the UI shows every state, not only the non-zero ones. */
function bucket(keys: readonly string[], rows: Array<{ k: string; n: unknown }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  for (const r of rows) out[r.k] = num(r.n);
  return out;
}

// ---------------------------------------------------------------------------
// Reasons — written once so the UI and the tests agree on the wording.
// ---------------------------------------------------------------------------

export const QUALITY_UNAVAILABLE: MetricUnavailable = unavailable(
  "NO_DATA_SOURCE",
  "No partner quality data exists in the schema. Certificates carry no partner/tenant link, so approval rate, grade variance, missed defects and turnaround cannot be computed for a shop. This requires backend work — it is not a display gap."
);

export const DEVICES_UNAVAILABLE: MetricUnavailable = unavailable(
  "NO_DATA_SOURCE",
  "No device registry exists. There is no approved-Mac table; partner_audit_events.device_id is written NULL by every call site, and the scanner identifies itself by operator email only — no machine id and no heartbeat are collected."
);

export const SCANNER_TELEMETRY_UNAVAILABLE: MetricUnavailable = unavailable(
  "NO_DATA_SOURCE",
  "Live scanner telemetry is not collected anywhere in the platform."
);

export const GRADING_ORIGIN_UNAVAILABLE: MetricUnavailable = unavailable(
  "REQUIRES_BACKEND_WORK",
  'Per-certificate grading origin is not implemented. The certificate issuer is a fixed literal ("Graded by MintVault UK"); there is no stored "Graded by <Shop>" value or approved-address snapshot to display.'
);

export const CERTS_UNAVAILABLE: MetricUnavailable = unavailable(
  "NOT_LINKED",
  "Certificates have no tenant column, so per-partner certificate and graded counts cannot be derived."
);

export const PURCHASES_UNAVAILABLE: MetricUnavailable = unavailable(
  "REQUIRES_BACKEND_WORK",
  "No Stripe credit-purchase path exists for partners. The ledger permits a 'purchase'/'stripe' entry but nothing writes one."
);

/** Wallet schema absent in this environment (migrations 0016/0017 not applied here). */
export const PURCHASES_UNAVAILABLE_WALLET: MetricUnavailable = unavailable(
  "REQUIRES_BACKEND_WORK",
  "The partner wallet schema is not present in this environment (migrations 0016/0017 not applied here)."
);

export const GRADERS_UNAVAILABLE: MetricUnavailable = unavailable(
  "REQUIRES_BACKEND_WORK",
  "Partner role assignments are unpopulated (the partner_roles reference set is unseeded), so an 'active graders' count cannot be derived."
);

export const COMPLETED_UNAVAILABLE: MetricUnavailable = unavailable(
  "NOT_LINKED",
  "Completed-card counts require the partner-to-certificate link, which does not exist. Connector pipeline counts are shown instead."
);

// ---------------------------------------------------------------------------
// A. Network summary
// ---------------------------------------------------------------------------

export async function getNetworkSummary(walletSchema = true): Promise<NetworkSummary> {
  const [orgs, users, connector, submissions, security, credits, consumed] = await Promise.all([
    partnerAdminQuery<{ status: string; n: string }>(
      "SELECT status, count(*)::bigint AS n FROM partner_organisations GROUP BY status"
    ),
    partnerAdminQuery<{ status: string; n: string }>(
      "SELECT status, count(*)::bigint AS n FROM partner_users GROUP BY status"
    ),
    partnerAdminQuery<{ state: string; n: string }>(
      "SELECT state, count(*)::bigint AS n FROM partner_connector_records GROUP BY state"
    ),
    partnerAdminQuery<{ status: string; n: string }>(
      "SELECT status, count(*)::bigint AS n FROM partner_submissions GROUP BY status"
    ),
    partnerAdminQuery<{ severity: string; n: string }>(
      `SELECT severity, count(*)::bigint AS n
         FROM partner_security_events
        WHERE created_at > now() - interval '30 days'
        GROUP BY severity`
    ),
    walletSchema
      ? tolerateMissingTable(
          () =>
            partnerAdminQuery<{ available: string; reserved: string }>(
              `SELECT COALESCE(SUM(available_balance),0)::bigint AS available,
                      COALESCE(SUM(active_reserved),0)::bigint  AS reserved
                 FROM partner_credit_availability`
            ),
          null
        )
      : null,
    /**
     * Consumed grading credits = reservations that actually reached the `consumed` terminal
     * state this month, counted at their real `consumed_at` timestamp.
     *
     * It is NOT "negative ledger entries". Consumption writes its ledger row with
     * entry_type='admin_adjustment' (partner-credit-reservation-service.ts), which is
     * indistinguishable from a genuine negative admin adjustment or a refund movement — so the
     * old `SUM(amount) WHERE amount < 0` reported clawbacks and refunds as consumed cards.
     * `reserved_credits` is CHECK-constrained to exactly 1 (migration 0017), preserving
     * one-credit-per-card semantics.
     */
    walletSchema
      ? tolerateMissingTable(
          () =>
            partnerAdminQuery<{ n: string }>(
              `SELECT COALESCE(SUM(reserved_credits),0)::bigint AS n
                 FROM partner_credit_reservations
                WHERE status = 'consumed'
                  AND consumed_at IS NOT NULL
                  AND consumed_at >= date_trunc('month', now())`
            ),
          null
        )
      : null,
  ]);

  const orgByStatus = bucket(
    ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"],
    orgs.rows.map((r) => ({ k: r.status, n: r.n }))
  );
  const connectorByState = bucket(
    DASHBOARD_CONNECTOR_STATES,
    connector.rows.map((r) => ({ k: r.state, n: r.n }))
  );
  const submissionsByStatus = bucket(
    DASHBOARD_SUBMISSION_STATUSES,
    submissions.rows.map((r) => ({ k: r.status, n: r.n }))
  );

  const totalUsers = users.rows.reduce((a, r) => a + num(r.n), 0);
  const activeUsers = num(users.rows.find((r) => r.status === "ACTIVE")?.n);

  // "In progress" = genuinely moving through the connector pipeline (not terminal states).
  const terminal = new Set(["imported", "rejected", "cancelled"]);
  const inProgress = DASHBOARD_CONNECTOR_STATES.filter((s) => !terminal.has(s)).reduce(
    (a, s) => a + (connectorByState[s] ?? 0),
    0
  );
  const bottlenecks = BOTTLENECK_STATES.reduce((a, s) => a + (connectorByState[s] ?? 0), 0);

  const severityBuckets = bucket(
    ["info", "low", "medium", "high", "critical"],
    security.rows.map((r) => ({ k: r.severity, n: r.n }))
  );

  const walletRow = credits?.rows?.[0];

  return {
    shops: {
      total: Object.values(orgByStatus).reduce((a, b) => a + b, 0),
      active: orgByStatus.ACTIVE,
      suspended: orgByStatus.SUSPENDED,
      onboarding: orgByStatus.PENDING,
      revoked: orgByStatus.REVOKED,
    },
    staff: { total: totalUsers, active: activeUsers, activeGraders: GRADERS_UNAVAILABLE },
    work: {
      inProgress,
      byState: connectorByState,
      bottlenecks,
      submissionsByStatus,
      completedToday: COMPLETED_UNAVAILABLE,
      completedThisMonth: COMPLETED_UNAVAILABLE,
    },
    corrections: {
      openEscalations: (connectorByState.manual_review ?? 0) + (connectorByState.reconciliation_required ?? 0),
      manualReview: connectorByState.manual_review ?? 0,
      reconciliationRequired: connectorByState.reconciliation_required ?? 0,
    },
    security: {
      openAlerts: severityBuckets.high + severityBuckets.critical,
      bySeverity: severityBuckets,
    },
    credits: {
      totalAvailable: walletRow ? metric(num(walletRow.available)) : PURCHASES_UNAVAILABLE_WALLET,
      totalReserved: walletRow ? metric(num(walletRow.reserved)) : PURCHASES_UNAVAILABLE_WALLET,
      consumedThisMonth: consumed ? metric(num(consumed.rows[0]?.n)) : PURCHASES_UNAVAILABLE_WALLET,
    },
    unavailable: [
      "qualityRating",
      "devices",
      "scannerTelemetry",
      "gradingOrigin",
      "certificatesGraded",
      "creditPurchases",
    ],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// B. Partner table
// ---------------------------------------------------------------------------

/**
 * Allowlist → literal ORDER BY. A client string NEVER reaches SQL.
 * These name columns projected by the `scored` CTE below, not raw table columns.
 */
const SORT_SQL: Record<PartnerSortKey, string> = {
  created_at: "created_at",
  legal_name: "legal_name",
  status: "status",
  submissions: "submissions",
  last_activity: "last_activity",
};

/**
 * The risk ladder, in SQL. This is the SAME rule as `deriveRisk` below, and the two are held
 * equivalent by an exhaustive matrix test (tests/partner-dashboard-risk-equivalence.test.ts)
 * that evaluates THIS EXACT STRING against a VALUES table and compares to `deriveRisk`.
 *
 * Ordered high→low, so the first matching branch is the highest triggered level — which is what
 * `deriveRisk`'s `raise()` (keep the max) computes. The `low` branch is only reached when the
 * `medium` branch did not match, so `available_credits > 0` is already implied there, exactly
 * mirroring the JS `else if`.
 *
 * It lives in SQL because filtering by risk MUST happen before LIMIT/OFFSET: filtering the page
 * after pagination returns an incomplete set with an unfiltered total.
 */
export const RISK_LEVEL_SQL = `CASE
    WHEN status IN ('SUSPENDED','REVOKED') OR security_alerts > 0 THEN 'high'
    WHEN locked_staff > 0
      OR open_corrections > 0
      OR (available_credits IS NOT NULL AND available_credits <= 0) THEN 'medium'
    WHEN available_credits IS NOT NULL AND available_credits < 10 THEN 'low'
    ELSE 'none'
  END`;

export interface PartnerListFilters {
  search?: string;
  status?: string;
  risk?: string;
  sort?: PartnerSortKey;
  direction?: SortDirection;
}

/**
 * Per-tenant aggregates computed ONCE by a grouped scan each, then LEFT JOINed — instead of
 * correlated subqueries re-evaluated per organisation.
 *
 * Two reasons, both load-bearing:
 *   1. Correctness: risk filtering happens in SQL now, so every signal column must exist for
 *      EVERY candidate row before the filter runs — not just the page.
 *   2. Performance: sorting by `last_activity` previously forced the `max(updated_at)` subquery
 *      to run once per organisation (measured 5003 loops → ~268 ms at 200k connector records).
 *      One grouped pass removes the per-partner repetition.
 */
const AGGREGATE_CTES = `
  staff AS (
    SELECT tenant_id,
           count(*) FILTER (WHERE status = 'ACTIVE')::int      AS active_staff,
           count(*) FILTER (WHERE locked_until > now())::int   AS locked_staff
      FROM partner_users GROUP BY tenant_id
  ),
  subs AS (
    SELECT tenant_id,
           count(*) FILTER (WHERE status = 'submitted_to_mintvault')::int AS submissions
      FROM partner_submissions GROUP BY tenant_id
  ),
  conn AS (
    SELECT tenant_id,
           count(*) FILTER (WHERE state NOT IN ('imported','rejected','cancelled'))::int  AS cards_in_pipeline,
           count(*) FILTER (WHERE state IN ('manual_review','reconciliation_required'))::int AS open_corrections,
           max(updated_at) AS last_activity
      FROM partner_connector_records GROUP BY tenant_id
  ),
  sec AS (
    SELECT tenant_id, count(*)::int AS security_alerts
      FROM partner_security_events
     WHERE severity IN ('high','critical')
       AND created_at > now() - interval '30 days'
     GROUP BY tenant_id
  )`;

/**
 * Build the shared CTE chain + WHERE for the partner list. The page query and the (rare) count
 * fallback are generated from THIS ONE builder, so `total` can never be computed with different
 * logic from the rows it describes.
 */
export function buildPartnerListBase(
  filters: PartnerListFilters,
  walletSchema: boolean
): { sql: string; params: unknown[]; riskParamIndex: number } {
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`o.status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = `$${params.length}`;
    clauses.push(`(o.legal_name ILIKE ${p} OR o.public_ref ILIKE ${p} OR p.trading_name ILIKE ${p})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Wallet relations are optional (0016/0017). When absent, project NULLs of the right type so
  // the risk CASE sees "unknown credits" and skips the credit branches — the same thing
  // `deriveRisk` does for `availableCredits === null`.
  const walletSelect = walletSchema
    ? `w.available_balance::bigint AS available_credits,
       w.active_reserved::bigint   AS reserved_credits`
    : `NULL::bigint AS available_credits,
       NULL::bigint AS reserved_credits`;
  const walletJoin = walletSchema ? `LEFT JOIN partner_credit_availability w ON w.tenant_id = o.id` : "";

  params.push(filters.risk ?? null);
  const riskParamIndex = params.length;

  const sql = `
    WITH ${AGGREGATE_CTES},
    base AS (
      SELECT o.id, o.public_ref, o.legal_name, o.status, o.created_at,
             p.trading_name,
             COALESCE(staff.active_staff, 0)      AS active_staff,
             COALESCE(staff.locked_staff, 0)      AS locked_staff,
             COALESCE(subs.submissions, 0)        AS submissions,
             COALESCE(conn.cards_in_pipeline, 0)  AS cards_in_pipeline,
             COALESCE(conn.open_corrections, 0)   AS open_corrections,
             COALESCE(sec.security_alerts, 0)     AS security_alerts,
             conn.last_activity                   AS last_activity,
             ${walletSelect}
        FROM partner_organisations o
        LEFT JOIN partner_profiles p ON p.tenant_id = o.id
        LEFT JOIN staff ON staff.tenant_id = o.id
        LEFT JOIN subs  ON subs.tenant_id  = o.id
        LEFT JOIN conn  ON conn.tenant_id  = o.id
        LEFT JOIN sec   ON sec.tenant_id   = o.id
        ${walletJoin}
        ${where}
    ),
    scored AS (
      SELECT base.*, ${RISK_LEVEL_SQL} AS risk_level FROM base
    ),
    matched AS (
      SELECT * FROM scored
       WHERE $${riskParamIndex}::text IS NULL OR risk_level = $${riskParamIndex}::text
    )`;

  return { sql, params, riskParamIndex };
}

export async function listPartnersForDashboard(
  filters: PartnerListFilters,
  pageRaw: unknown,
  pageSizeRaw: unknown,
  walletSchema = true
): Promise<Paged<PartnerTableRow>> {
  const { page, pageSize, offset } = clampDashboardPagination(pageRaw, pageSizeRaw);
  const { sql, params } = buildPartnerListBase(filters, walletSchema);

  const sortKey: PartnerSortKey = filters.sort ?? "created_at";
  const direction = filters.direction === "asc" ? "ASC" : "DESC";
  // `id ASC` is the deterministic tiebreak — without it equal sort values make page boundaries
  // plan-dependent, which silently repeats and skips rows across pages.
  const orderBy = `${SORT_SQL[sortKey]} ${direction}, id ASC`;

  const pageParams = [...params, pageSize, offset];
  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    `${sql}
     SELECT matched.*, count(*) OVER () AS total_matching
       FROM matched
      ORDER BY ${orderBy}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams
  );

  // The window count is the filtered total and comes from the very rows returned, so rows and
  // total can never disagree. It is only absent when the page is empty — which means either
  // nothing matched at all, or the caller paged past the end. The second case needs one extra
  // count; it is rare enough not to pay for on every request.
  let total: number;
  if (rows.length > 0) {
    total = num(rows[0].total_matching);
  } else if (page === 1) {
    total = 0;
  } else {
    const countRes = await partnerAdminQuery<{ n: number }>(`${sql} SELECT count(*)::int AS n FROM matched`, params);
    total = countRes.rows[0]?.n ?? 0;
  }

  const mapped: PartnerTableRow[] = rows.map((r) => {
    const availableCredits = r.available_credits == null ? null : num(r.available_credits);
    const risk = deriveRisk({
      status: String(r.status),
      openCorrections: num(r.open_corrections),
      securityAlerts: num(r.security_alerts),
      lockedStaff: num(r.locked_staff),
      availableCredits,
    });
    return {
      partnerId: String(r.id),
      publicRef: String(r.public_ref),
      shopName: String(r.legal_name),
      tradingName: (r.trading_name as string) ?? null,
      status: String(r.status),
      // The dedicated onboarding-stage column is a dead default; business status is the truth.
      onboardingStage: String(r.status) === "PENDING" ? "Onboarding" : "Onboarded",
      qualityRating: QUALITY_UNAVAILABLE,
      riskStatus: risk,
      availableCredits,
      reservedCredits: r.reserved_credits == null ? null : num(r.reserved_credits),
      activeSubmissions: num(r.submissions),
      cardsInPipeline: num(r.cards_in_pipeline),
      openCorrections: num(r.open_corrections),
      approvedDevices: DEVICES_UNAVAILABLE,
      activeStaff: num(r.active_staff),
      lastActivityAt: iso(r.last_activity),
      alertCount: num(r.security_alerts) + num(r.open_corrections) + (String(r.status) === "SUSPENDED" ? 1 : 0),
    };
  });

  return {
    rows: mapped,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Risk is derived ONLY from signals that genuinely exist. No score is invented. */
export function deriveRisk(input: {
  status: string;
  openCorrections: number;
  securityAlerts: number;
  lockedStaff: number;
  availableCredits: number | null;
}): PartnerRisk {
  const reasons: string[] = [];
  let level: RiskLevel = "none";

  // RISK_RANK is shared so the JS ladder and RISK_LEVEL_SQL cannot drift on precedence.
  const raise = (to: RiskLevel) => {
    if (RISK_RANK[to] > RISK_RANK[level]) level = to;
  };

  if (input.status === "SUSPENDED" || input.status === "REVOKED") {
    reasons.push(`Account ${input.status.toLowerCase()}`);
    raise("high");
  }
  if (input.securityAlerts > 0) {
    reasons.push(`${input.securityAlerts} high/critical security event(s) in 30 days`);
    raise("high");
  }
  if (input.lockedStaff > 0) {
    reasons.push(`${input.lockedStaff} locked staff account(s)`);
    raise("medium");
  }
  if (input.openCorrections > 0) {
    reasons.push(`${input.openCorrections} escalation(s) awaiting action`);
    raise("medium");
  }
  if (input.availableCredits !== null && input.availableCredits <= 0) {
    reasons.push("No available grading credits");
    raise("medium");
  } else if (input.availableCredits !== null && input.availableCredits < 10) {
    reasons.push(`Low credit balance (${input.availableCredits})`);
    raise("low");
  }

  return { level, reasons };
}

// ---------------------------------------------------------------------------
// C. Drill-down
// ---------------------------------------------------------------------------

async function loadOrg(partnerId: string) {
  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    "SELECT id, public_ref, legal_name, status, created_at FROM partner_organisations WHERE id = $1",
    [partnerId]
  );
  if (rows.length === 0) throw new DashboardError("PARTNER_NOT_FOUND", "Partner not found.");
  return rows[0];
}

export async function getPartnerOverview(partnerIdRaw: unknown): Promise<PartnerOverview> {
  const partnerId = requirePartnerId(partnerIdRaw);
  const org = await loadOrg(partnerId);

  const [profile, counts] = await Promise.all([
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT trading_name, organisation_kind, onboarding_date, internal_tier, health_note,
              address_city, address_country
         FROM partner_profiles WHERE tenant_id = $1`,
      [partnerId]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT (SELECT count(*)::int FROM partner_locations WHERE tenant_id = $1)          AS locations,
              (SELECT count(*)::int FROM partner_users WHERE tenant_id = $1)              AS users,
              (SELECT count(*)::int FROM partner_submissions WHERE tenant_id = $1)        AS submissions,
              (SELECT count(*)::int FROM partner_connector_records WHERE tenant_id = $1)  AS connector_records`,
      [partnerId]
    ),
  ]);

  const p = profile.rows[0];
  const c = counts.rows[0] ?? {};

  return {
    partnerId: String(org.id),
    publicRef: String(org.public_ref),
    shopName: String(org.legal_name),
    status: String(org.status),
    createdAt: iso(org.created_at) ?? "",
    profile: p
      ? {
          tradingName: (p.trading_name as string) ?? null,
          organisationKind: (p.organisation_kind as string) ?? null,
          onboardingDate: iso(p.onboarding_date),
          internalTier: (p.internal_tier as string) ?? null,
          healthNote: (p.health_note as string) ?? null,
          addressCity: (p.address_city as string) ?? null,
          addressCountry: (p.address_country as string) ?? null,
        }
      : null,
    counts: {
      locations: num(c.locations),
      users: num(c.users),
      submissions: num(c.submissions),
      connectorRecords: num(c.connector_records),
    },
    gradingOrigin: GRADING_ORIGIN_UNAVAILABLE,
    certificatesGraded: CERTS_UNAVAILABLE,
  };
}

export async function getPartnerStaff(partnerIdRaw: unknown): Promise<PartnerStaffRow[]> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  // NOTE: password_hash is deliberately absent from this projection.
  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT u.id, u.public_ref, u.email, u.status, u.mfa_enabled, u.last_login_at,
            u.failed_login_count, u.locked_until,
            COALESCE(
              (SELECT array_agg(r.code ORDER BY r.code)
                 FROM partner_user_roles ur
                 JOIN partner_roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND ur.tenant_id = $1),
              ARRAY[]::text[]
            ) AS roles,
            (SELECT count(*)::int FROM partner_sessions s
              WHERE s.user_id = u.id AND s.tenant_id = $1
                AND s.revoked_at IS NULL AND s.absolute_expires_at > now()) AS active_sessions
       FROM partner_users u
      WHERE u.tenant_id = $1
      ORDER BY u.created_at DESC, u.id ASC
      LIMIT 500`,
    [partnerId]
  );

  return rows.map((r) => ({
    userId: String(r.id),
    publicRef: String(r.public_ref),
    email: String(r.email),
    status: String(r.status),
    mfaEnabled: r.mfa_enabled === true,
    lastLoginAt: iso(r.last_login_at),
    locked: r.locked_until != null && new Date(String(r.locked_until)).getTime() > Date.now(),
    lockedUntil: iso(r.locked_until),
    failedLoginCount: num(r.failed_login_count),
    roles: Array.isArray(r.roles) ? (r.roles as string[]) : [],
    activeSessions: num(r.active_sessions),
  }));
}

export async function getPartnerWallet(partnerIdRaw: unknown, walletSchema = true): Promise<PartnerWalletView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const availability = walletSchema
    ? await tolerateMissingTable(
        () =>
          partnerAdminQuery<Record<string, unknown>>(
            `SELECT wallet_id, status, ledger_balance, active_reserved, available_balance, consumed_reservations
               FROM partner_credit_availability WHERE tenant_id = $1`,
            [partnerId]
          ),
        null
      )
    : null;

  if (!availability) {
    return {
      configured: false,
      walletId: null,
      status: null,
      availableCredits: null,
      reservedCredits: null,
      ledgerBalance: null,
      consumedReservations: null,
      recentLedger: [],
      purchases: PURCHASES_UNAVAILABLE,
      manualAdjustmentEnabled: false,
      note: "The partner wallet schema is not present in this environment (migrations 0016/0017 not applied here).",
    };
  }

  const w = availability.rows[0];
  if (!w) {
    return {
      configured: false,
      walletId: null,
      status: null,
      availableCredits: null,
      reservedCredits: null,
      ledgerBalance: null,
      consumedReservations: null,
      recentLedger: [],
      purchases: PURCHASES_UNAVAILABLE,
      manualAdjustmentEnabled: false,
      note: "No wallet has been opened for this partner yet.",
    };
  }

  const ledger = await tolerateMissingTable(
    () =>
      partnerAdminQuery<Record<string, unknown>>(
        `SELECT id, amount, entry_type, source, reason, actor_type, actor_email, created_at
           FROM partner_credit_ledger
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
        [partnerId]
      ),
    null
  );

  const recentLedger: LedgerEntryView[] = (ledger?.rows ?? []).map((r) => ({
    id: String(r.id),
    amount: num(r.amount),
    entryType: String(r.entry_type),
    source: String(r.source),
    reason: String(r.reason ?? ""),
    actorType: String(r.actor_type),
    actorEmail: (r.actor_email as string) ?? null,
    createdAt: iso(r.created_at) ?? "",
  }));

  return {
    configured: true,
    walletId: String(w.wallet_id),
    status: String(w.status),
    availableCredits: num(w.available_balance),
    reservedCredits: num(w.active_reserved),
    ledgerBalance: num(w.ledger_balance),
    consumedReservations: num(w.consumed_reservations),
    recentLedger,
    purchases: PURCHASES_UNAVAILABLE,
    manualAdjustmentEnabled: true,
    note: "Balances are ledger-derived. Super Admin adjustments append immutable entries.",
  };
}

export async function getPartnerSubmissions(partnerIdRaw: unknown): Promise<PartnerSubmissionsView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const [byStatus, byState, recent] = await Promise.all([
    partnerAdminQuery<{ status: string; n: string }>(
      "SELECT status, count(*)::bigint AS n FROM partner_submissions WHERE tenant_id = $1 GROUP BY status",
      [partnerId]
    ),
    partnerAdminQuery<{ state: string; n: string }>(
      "SELECT state, count(*)::bigint AS n FROM partner_connector_records WHERE tenant_id = $1 GROUP BY state",
      [partnerId]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, public_ref, status, card_count, estimated_price_pence, created_at, submitted_at
         FROM partner_submissions
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id ASC
        LIMIT 50`,
      [partnerId]
    ),
  ]);

  return {
    byStatus: bucket(
      DASHBOARD_SUBMISSION_STATUSES,
      byStatus.rows.map((r) => ({ k: r.status, n: r.n }))
    ),
    connectorByState: bucket(
      DASHBOARD_CONNECTOR_STATES,
      byState.rows.map((r) => ({ k: r.state, n: r.n }))
    ),
    recent: recent.rows.map((r) => ({
      id: String(r.id),
      publicRef: String(r.public_ref),
      status: String(r.status),
      cardCount: num(r.card_count),
      estimatedPricePence: r.estimated_price_pence == null ? null : num(r.estimated_price_pence),
      createdAt: iso(r.created_at) ?? "",
      submittedAt: iso(r.submitted_at),
    })),
  };
}

export async function getPartnerQuality(partnerIdRaw: unknown): Promise<PartnerQualityView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  // Every metric named in the Partner Quality Rating requirement, each explicitly
  // reported as having no data source. Deliberately NOT computed from unrelated
  // MintVault-operator statistics, which are keyed on internal staff, not partners.
  const names = [
    "adminApprovalRate",
    "returnedForChangeRate",
    "averageGradeVariance",
    "missedDefectRate",
    "cardIdentityErrors",
    "imageRecaptureRate",
    "correctionRate",
    "averageTurnaroundTime",
    "policySecurityIncidents",
    "deviceLocationIssues",
    "auditOutcomes",
  ];
  const metrics: Record<string, MetricUnavailable> = {};
  for (const n of names) metrics[n] = QUALITY_UNAVAILABLE;

  return {
    metrics,
    overallRating: QUALITY_UNAVAILABLE,
    trend: QUALITY_UNAVAILABLE,
    graderPerformance: QUALITY_UNAVAILABLE,
    explanation:
      "Partner Quality Rating is not yet implemented. No quality table or column exists, and certificates carry no partner link, so none of these metrics can be derived from current data. Showing zero would be misleading, so nothing is shown.",
  };
}

export async function getPartnerDevices(partnerIdRaw: unknown): Promise<PartnerDevicesView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT id, user_id, created_at, last_seen_at, revoked_at, mfa_passed
       FROM partner_sessions
      WHERE tenant_id = $1
      ORDER BY created_at DESC, id ASC
      LIMIT 50`,
    [partnerId]
  );

  return {
    devices: [],
    status: DEVICES_UNAVAILABLE,
    scannerTelemetry: SCANNER_TELEMETRY_UNAVAILABLE,
    recentSessions: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      createdAt: iso(r.created_at) ?? "",
      lastSeenAt: iso(r.last_seen_at),
      revokedAt: iso(r.revoked_at),
      mfaPassed: r.mfa_passed === true,
    })),
    explanation:
      "No device registry exists in the platform. The sessions below are browser sessions, not approved machines — they are shown as the only real proximate signal and must not be read as device approval or scanner health.",
  };
}

export async function getPartnerCorrections(partnerIdRaw: unknown): Promise<PartnerCorrectionsView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const [escalations, actions] = await Promise.all([
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, state, attempt_count, last_error_category, last_error_code, created_at, updated_at
         FROM partner_connector_records
        WHERE tenant_id = $1
          AND state IN ('manual_review','reconciliation_required','failed')
        ORDER BY updated_at DESC, id ASC
        LIMIT 100`,
      [partnerId]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, action_type, actor_email, reason, result, before_state, after_state, created_at
         FROM partner_connector_admin_actions
        WHERE partner_organisation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [partnerId]
    ),
  ]);

  const counts = { manualReview: 0, reconciliationRequired: 0, failed: 0 };
  for (const r of escalations.rows) {
    if (r.state === "manual_review") counts.manualReview += 1;
    else if (r.state === "reconciliation_required") counts.reconciliationRequired += 1;
    else if (r.state === "failed") counts.failed += 1;
  }

  return {
    escalations: escalations.rows.map((r) => ({
      recordId: String(r.id),
      state: String(r.state),
      attemptCount: num(r.attempt_count),
      lastErrorCategory: (r.last_error_category as string) ?? null,
      lastErrorCode: (r.last_error_code as string) ?? null,
      createdAt: iso(r.created_at) ?? "",
      updatedAt: iso(r.updated_at) ?? "",
    })),
    counts,
    adminActions: actions.rows.map((r) => ({
      id: String(r.id),
      actionType: String(r.action_type),
      actorEmail: String(r.actor_email),
      reason: String(r.reason ?? ""),
      result: String(r.result),
      beforeState: (r.before_state as string) ?? null,
      afterState: (r.after_state as string) ?? null,
      createdAt: iso(r.created_at) ?? "",
    })),
    explanation:
      "Correction routing today is connector escalation: records land in manual_review or reconciliation_required and are resolved by a super admin. There is no partner-facing correction workflow.",
  };
}

export async function getPartnerSecurity(partnerIdRaw: unknown): Promise<PartnerSecurityView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const [events, controls, locked] = await Promise.all([
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, severity, kind, created_at
         FROM partner_security_events
        WHERE tenant_id = $1
        ORDER BY id DESC
        LIMIT 100`,
      [partnerId]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, scope, frozen, reason, updated_at
         FROM partner_emergency_controls
        WHERE tenant_id = $1
        ORDER BY updated_at DESC, id ASC
        LIMIT 50`,
      [partnerId]
    ),
    partnerAdminQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_users WHERE tenant_id = $1 AND locked_until > now()",
      [partnerId]
    ),
  ]);

  return {
    events: events.rows.map((r) => ({
      id: num(r.id),
      severity: String(r.severity),
      kind: String(r.kind),
      createdAt: iso(r.created_at) ?? "",
    })),
    emergencyControls: controls.rows.map((r) => ({
      id: String(r.id),
      scope: String(r.scope),
      frozen: r.frozen === true,
      reason: (r.reason as string) ?? null,
      updatedAt: iso(r.updated_at) ?? "",
    })),
    lockedUsers: locked.rows[0]?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// J. Audit timeline — sources are TAGGED so evidential detail is not lost.
//
// ORDERING IS EVIDENTIAL. `created_at` defaults to now(), which is TRANSACTION time, so every
// row written in one transaction shares an identical timestamp. Ordering on the timestamp alone
// left tied rows in plan-dependent order, which silently repeats and SKIPS audit rows across
// pages. (source, id) completes the key: `source` is a distinct literal per UNION branch and
// `id` is unique within a branch, so the composite order is total and stable.
// ---------------------------------------------------------------------------

export async function getPartnerAuditTimeline(
  partnerIdRaw: unknown,
  pageRaw: unknown,
  pageSizeRaw: unknown
): Promise<Paged<AuditTimelineEntry>> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);
  const { page, pageSize, offset } = clampDashboardPagination(pageRaw, pageSizeRaw);

  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT * FROM (
        SELECT 'partner_audit'::text AS source, a.id::text AS id, a.action AS action,
               NULL::text AS actor_email, a.reason AS reason, NULL::text AS result,
               a.record_type AS record_type, a.record_id AS record_id,
               NULL::text AS severity, a.created_at AS created_at
          FROM partner_audit_events a WHERE a.tenant_id = $1
        UNION ALL
        SELECT 'security', s.id::text, s.kind, NULL, NULL, NULL, NULL, NULL, s.severity, s.created_at
          FROM partner_security_events s WHERE s.tenant_id = $1
        UNION ALL
        SELECT 'management', m.id::text, m.action_type, m.actor_email, m.reason, m.result,
               m.entity_type, m.entity_id, NULL, m.created_at
          FROM partner_management_audit m WHERE m.tenant_id = $1
        UNION ALL
        SELECT 'connector_admin', c.id::text, c.action_type, c.actor_email, c.reason, c.result,
               'connector_record', c.connector_record_id::text, NULL, c.created_at
          FROM partner_connector_admin_actions c WHERE c.partner_organisation_id = $1
     ) t
     ORDER BY t.created_at DESC, t.source ASC, t.id ASC
     LIMIT $2 OFFSET $3`,
    [partnerId, pageSize, offset]
  );

  const totalRes = await partnerAdminQuery<{ n: number }>(
    `SELECT (
       (SELECT count(*) FROM partner_audit_events WHERE tenant_id = $1) +
       (SELECT count(*) FROM partner_security_events WHERE tenant_id = $1) +
       (SELECT count(*) FROM partner_management_audit WHERE tenant_id = $1) +
       (SELECT count(*) FROM partner_connector_admin_actions WHERE partner_organisation_id = $1)
     )::int AS n`,
    [partnerId]
  );

  const total = totalRes.rows[0]?.n ?? 0;
  return {
    rows: rows.map((r) => ({
      source: String(r.source) as AuditTimelineEntry["source"],
      id: String(r.id),
      action: String(r.action),
      actorEmail: (r.actor_email as string) ?? null,
      reason: (r.reason as string) ?? null,
      result: (r.result as string) ?? null,
      recordType: (r.record_type as string) ?? null,
      recordId: (r.record_id as string) ?? null,
      severity: (r.severity as string) ?? null,
      createdAt: iso(r.created_at) ?? "",
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------------
// I. Alerts — real conditions only.
// ---------------------------------------------------------------------------

export async function getAlerts(limitRaw: unknown, walletSchema = true): Promise<DashboardAlert[]> {
  const limit = Math.min(200, Math.max(1, Number(limitRaw) || 100));

  // Every source query is ORDERed and LIMITed in SQL. Previously each returned its entire
  // matching set and the whole list was built in memory before `.slice(limit)` — unbounded in
  // partner count, on an endpoint that auto-refreshes. `limit` bounds each source, and the
  // severity sort still runs across the combined set, so prioritisation is unchanged for any
  // realistic alert volume.
  const [orgs, security, escalations, lockedUsers, lowCredit] = await Promise.all([
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, legal_name, status, created_at FROM partner_organisations
        WHERE status IN ('SUSPENDED','PENDING')
        ORDER BY (status = 'SUSPENDED') DESC, created_at DESC, id ASC
        LIMIT $1`,
      [limit]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT e.id, e.tenant_id, e.severity, e.kind, e.created_at, o.legal_name
         FROM partner_security_events e
         JOIN partner_organisations o ON o.id = e.tenant_id
        WHERE e.severity IN ('high','critical')
          AND e.created_at > now() - interval '30 days'
        ORDER BY e.id DESC
        LIMIT $1`,
      [limit]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT r.tenant_id, o.legal_name, r.state, count(*)::int AS n, max(r.updated_at) AS updated_at
         FROM partner_connector_records r
         JOIN partner_organisations o ON o.id = r.tenant_id
        WHERE r.state IN ('manual_review','reconciliation_required','failed')
        GROUP BY r.tenant_id, o.legal_name, r.state
        ORDER BY (r.state = 'failed') DESC, count(*) DESC, r.tenant_id ASC
        LIMIT $1`,
      [limit]
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT u.tenant_id, o.legal_name, count(*)::int AS n, max(u.locked_until) AS locked_until
         FROM partner_users u
         JOIN partner_organisations o ON o.id = u.tenant_id
        WHERE u.locked_until > now()
        GROUP BY u.tenant_id, o.legal_name
        ORDER BY count(*) DESC, u.tenant_id ASC
        LIMIT $1`,
      [limit]
    ),
    // Degrades to null where the wallet schema is not applied, rather than failing all alerts.
    walletSchema
      ? tolerateMissingTable(
          () =>
            partnerAdminQuery<Record<string, unknown>>(
              `SELECT a.tenant_id, o.legal_name, a.available_balance
                 FROM partner_credit_availability a
                 JOIN partner_organisations o ON o.id = a.tenant_id
                WHERE a.available_balance < 10
                ORDER BY a.available_balance ASC, a.tenant_id ASC
                LIMIT $1`,
              [limit]
            ),
          null
        )
      : null,
  ]);

  const alerts: DashboardAlert[] = [];

  for (const c of lowCredit?.rows ?? []) {
    const balance = num(c.available_balance);
    alerts.push({
      id: `credit-${c.tenant_id}`,
      partnerId: String(c.tenant_id),
      partnerName: String(c.legal_name),
      severity: balance <= 0 ? "high" : "medium",
      kind: balance <= 0 ? "credits_exhausted" : "credits_low",
      reason:
        balance <= 0
          ? "No grading credits available — new work cannot be reserved."
          : `Only ${balance} grading credit(s) available.`,
      recommendedAction: "Contact the partner to top up before their next submission.",
      // A live balance threshold, not a recorded event: there is no stored moment at which this
      // "happened". Stamping now() made it look like a fresh incident on every refresh.
      detectedAt: null,
      link: `/admin/partners/dashboard?partner=${c.tenant_id}&tab=wallet`,
    });
  }

  for (const o of orgs.rows) {
    const suspended = String(o.status) === "SUSPENDED";
    alerts.push({
      id: `org-${o.id}-${o.status}`,
      partnerId: String(o.id),
      partnerName: String(o.legal_name),
      severity: suspended ? "high" : "low",
      kind: suspended ? "partner_suspended" : "onboarding_incomplete",
      reason: suspended ? "Partner account is suspended." : "Partner is still in onboarding (status PENDING).",
      recommendedAction: suspended
        ? "Review the suspension reason in the audit timeline and decide on reinstatement."
        : "Complete onboarding checks and activate the partner.",
      detectedAt: iso(o.created_at),
      link: `/admin/partners/dashboard?partner=${o.id}`,
    });
  }

  for (const e of security.rows) {
    alerts.push({
      id: `sec-${e.id}`,
      partnerId: String(e.tenant_id),
      partnerName: String(e.legal_name),
      severity: String(e.severity) === "critical" ? "critical" : "high",
      kind: String(e.kind),
      reason: `Security event "${e.kind}" recorded at ${String(e.severity)} severity.`,
      recommendedAction: "Open the partner's Security tab and confirm the event was expected.",
      detectedAt: iso(e.created_at),
      link: `/admin/partners/dashboard?partner=${e.tenant_id}&tab=security`,
    });
  }

  for (const r of escalations.rows) {
    const state = String(r.state);
    alerts.push({
      id: `esc-${r.tenant_id}-${state}`,
      partnerId: String(r.tenant_id),
      partnerName: String(r.legal_name),
      severity: state === "failed" ? "high" : "medium",
      kind: `connector_${state}`,
      reason: `${num(r.n)} connector record(s) in ${state}.`,
      recommendedAction: "Resolve from the Connector Operations console.",
      detectedAt: iso(r.updated_at),
      link: `/admin/partner-network`,
    });
  }

  for (const u of lockedUsers.rows) {
    alerts.push({
      id: `lock-${u.tenant_id}`,
      partnerId: String(u.tenant_id),
      partnerName: String(u.legal_name),
      severity: "medium",
      kind: "accounts_locked",
      reason: `${num(u.n)} staff account(s) locked by repeated failed logins.`,
      recommendedAction: "Confirm with the partner that the lockouts are legitimate.",
      // `locked_until` is when the lock EXPIRES (a future time), not when it was detected, so it
      // must not be presented as a detection timestamp.
      detectedAt: null,
      link: `/admin/partners/dashboard?partner=${u.tenant_id}&tab=staff`,
    });
  }

  return sortAlerts(alerts).slice(0, limit);
}
