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

export async function getNetworkSummary(): Promise<NetworkSummary> {
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
    tolerateMissingTable(
      () =>
        partnerAdminQuery<{ available: string; reserved: string }>(
          `SELECT COALESCE(SUM(available_balance),0)::bigint AS available,
                  COALESCE(SUM(active_reserved),0)::bigint  AS reserved
             FROM partner_credit_availability`
        ),
      null
    ),
    tolerateMissingTable(
      () =>
        partnerAdminQuery<{ n: string }>(
          `SELECT COALESCE(-SUM(amount),0)::bigint AS n
             FROM partner_credit_ledger
            WHERE amount < 0
              AND created_at >= date_trunc('month', now())`
        ),
      null
    ),
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

/** Allowlist → literal ORDER BY. A client string NEVER reaches SQL. */
const SORT_SQL: Record<PartnerSortKey, string> = {
  created_at: "o.created_at",
  legal_name: "o.legal_name",
  status: "o.status",
  submissions: "submissions",
  last_activity: "last_activity",
};

export interface PartnerListFilters {
  search?: string;
  status?: string;
  risk?: string;
  sort?: PartnerSortKey;
  direction?: SortDirection;
}

export async function listPartnersForDashboard(
  filters: PartnerListFilters,
  pageRaw: unknown,
  pageSizeRaw: unknown
): Promise<Paged<PartnerTableRow>> {
  const { page, pageSize, offset } = clampDashboardPagination(pageRaw, pageSizeRaw);

  const params: unknown[] = [];
  const clauses: string[] = [];
  const add = (sqlFragment: string, val: unknown) => {
    params.push(val);
    clauses.push(sqlFragment.replace("$?", `$${params.length}`));
  };

  if (filters.status) add("o.status = $?", filters.status);
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = `$${params.length}`;
    clauses.push(`(o.legal_name ILIKE ${p} OR o.public_ref ILIKE ${p} OR p.trading_name ILIKE ${p})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const sortKey: PartnerSortKey = filters.sort ?? "created_at";
  const direction = filters.direction === "asc" ? "ASC" : "DESC";
  const orderBy = `${SORT_SQL[sortKey]} ${direction}, o.id ASC`;

  params.push(pageSize, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const { rows } = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT o.id, o.public_ref, o.legal_name, o.status, o.created_at,
            p.trading_name,
            (SELECT count(*)::int FROM partner_users u
              WHERE u.tenant_id = o.id AND u.status = 'ACTIVE')            AS active_staff,
            (SELECT count(*)::int FROM partner_users u
              WHERE u.tenant_id = o.id AND u.locked_until > now())         AS locked_staff,
            (SELECT count(*)::int FROM partner_submissions s
              WHERE s.tenant_id = o.id AND s.status = 'submitted_to_mintvault') AS submissions,
            (SELECT count(*)::int FROM partner_connector_records r
              WHERE r.tenant_id = o.id
                AND r.state NOT IN ('imported','rejected','cancelled'))    AS cards_in_pipeline,
            (SELECT count(*)::int FROM partner_connector_records r
              WHERE r.tenant_id = o.id
                AND r.state IN ('manual_review','reconciliation_required')) AS open_corrections,
            (SELECT count(*)::int FROM partner_security_events e
              WHERE e.tenant_id = o.id
                AND e.severity IN ('high','critical')
                AND e.created_at > now() - interval '30 days')             AS security_alerts,
            (SELECT max(r.updated_at) FROM partner_connector_records r
              WHERE r.tenant_id = o.id)                                    AS last_activity
       FROM partner_organisations o
       LEFT JOIN partner_profiles p ON p.tenant_id = o.id
       ${where}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const totalRes = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM partner_organisations o
       LEFT JOIN partner_profiles p ON p.tenant_id = o.id
       ${where}`,
    params.slice(0, params.length - 2)
  );

  // Wallet figures are joined separately so a missing 0016/0017 degrades to null
  // instead of failing the whole list.
  const ids = rows.map((r) => String(r.id));
  const wallets = ids.length
    ? await tolerateMissingTable(
        () =>
          partnerAdminQuery<{ tenant_id: string; available_balance: string; active_reserved: string }>(
            `SELECT tenant_id, available_balance, active_reserved
               FROM partner_credit_availability
              WHERE tenant_id = ANY($1::uuid[])`,
            [ids]
          ),
        null
      )
    : null;
  const walletByTenant = new Map<string, { available: number; reserved: number }>();
  for (const w of wallets?.rows ?? []) {
    walletByTenant.set(w.tenant_id, {
      available: num(w.available_balance),
      reserved: num(w.active_reserved),
    });
  }

  const mapped: PartnerTableRow[] = rows.map((r) => {
    const wallet = walletByTenant.get(String(r.id));
    const risk = deriveRisk({
      status: String(r.status),
      openCorrections: num(r.open_corrections),
      securityAlerts: num(r.security_alerts),
      lockedStaff: num(r.locked_staff),
      availableCredits: wallet?.available ?? null,
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
      availableCredits: wallet?.available ?? null,
      reservedCredits: wallet?.reserved ?? null,
      activeSubmissions: num(r.submissions),
      cardsInPipeline: num(r.cards_in_pipeline),
      openCorrections: num(r.open_corrections),
      approvedDevices: DEVICES_UNAVAILABLE,
      activeStaff: num(r.active_staff),
      lastActivityAt: iso(r.last_activity),
      alertCount: num(r.security_alerts) + num(r.open_corrections) + (String(r.status) === "SUSPENDED" ? 1 : 0),
    };
  });

  const filtered = filters.risk ? mapped.filter((m) => m.riskStatus.level === filters.risk) : mapped;
  const total = totalRes.rows[0]?.n ?? 0;

  return {
    rows: filtered,
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
  let level: PartnerRisk["level"] = "none";

  const raise = (to: PartnerRisk["level"]) => {
    const rank = { none: 0, low: 1, medium: 2, high: 3 };
    if (rank[to] > rank[level]) level = to;
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

export async function getPartnerWallet(partnerIdRaw: unknown): Promise<PartnerWalletView> {
  const partnerId = requirePartnerId(partnerIdRaw);
  await loadOrg(partnerId);

  const availability = await tolerateMissingTable(
    () =>
      partnerAdminQuery<Record<string, unknown>>(
        `SELECT wallet_id, status, ledger_balance, active_reserved, available_balance, consumed_reservations
           FROM partner_credit_availability WHERE tenant_id = $1`,
        [partnerId]
      ),
    null
  );

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
    // Read-only by design. Enabling this needs a reviewed HTTP write path over the
    // append-only ledger — deliberately out of scope for this first version.
    manualAdjustmentEnabled: false,
    note: "Balances are derived from the append-only ledger. This view is read-only.",
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
     ORDER BY t.created_at DESC
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

export async function getAlerts(limitRaw: unknown): Promise<DashboardAlert[]> {
  const limit = Math.min(200, Math.max(1, Number(limitRaw) || 100));

  const [orgs, security, escalations, lockedUsers, lowCredit] = await Promise.all([
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT id, legal_name, status, created_at FROM partner_organisations
        WHERE status IN ('SUSPENDED','PENDING')`
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT e.id, e.tenant_id, e.severity, e.kind, e.created_at, o.legal_name
         FROM partner_security_events e
         JOIN partner_organisations o ON o.id = e.tenant_id
        WHERE e.severity IN ('high','critical')
          AND e.created_at > now() - interval '30 days'
        ORDER BY e.id DESC
        LIMIT 200`
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT r.tenant_id, o.legal_name, r.state, count(*)::int AS n, max(r.updated_at) AS updated_at
         FROM partner_connector_records r
         JOIN partner_organisations o ON o.id = r.tenant_id
        WHERE r.state IN ('manual_review','reconciliation_required','failed')
        GROUP BY r.tenant_id, o.legal_name, r.state`
    ),
    partnerAdminQuery<Record<string, unknown>>(
      `SELECT u.tenant_id, o.legal_name, count(*)::int AS n, max(u.locked_until) AS locked_until
         FROM partner_users u
         JOIN partner_organisations o ON o.id = u.tenant_id
        WHERE u.locked_until > now()
        GROUP BY u.tenant_id, o.legal_name`
    ),
    // Degrades to null where the wallet schema is not applied, rather than failing all alerts.
    tolerateMissingTable(
      () =>
        partnerAdminQuery<Record<string, unknown>>(
          `SELECT a.tenant_id, o.legal_name, a.available_balance
             FROM partner_credit_availability a
             JOIN partner_organisations o ON o.id = a.tenant_id
            WHERE a.available_balance < 10`
        ),
      null
    ),
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
      detectedAt: new Date().toISOString(),
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
      detectedAt: iso(o.created_at) ?? new Date().toISOString(),
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
      detectedAt: iso(e.created_at) ?? new Date().toISOString(),
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
      detectedAt: iso(r.updated_at) ?? new Date().toISOString(),
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
      detectedAt: iso(u.locked_until) ?? new Date().toISOString(),
      link: `/admin/partners/dashboard?partner=${u.tenant_id}&tab=staff`,
    });
  }

  return sortAlerts(alerts).slice(0, limit);
}
