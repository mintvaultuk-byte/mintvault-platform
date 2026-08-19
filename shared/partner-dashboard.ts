/**
 * Super Admin Partner Master Dashboard — shared contract.
 *
 * One definition of every response shape, consumed by BOTH `server/partner/dashboard-*.ts`
 * and `client/src/pages/admin/partner-dashboard*.ts(x)` (CLAUDE.md: types live in shared/,
 * never duplicated per-side).
 *
 * HONESTY RULE (load-bearing — do not "improve" this away):
 * Several dashboard areas have NO data source in the schema today. Rather than render a
 * fake zero, every such area returns a `MetricUnavailable` carrying the REASON. The existing
 * `getStatistics` endpoint already sets this precedent by hard-returning
 * `certificatesCount: null, unavailable: [...]` (server/partner/partner-management-service.ts).
 * A zero and "we cannot know" are different facts and must render differently.
 */

/** Why a metric cannot be shown. Rendered to the operator as a tooltip. */
export type UnavailableReason =
  | "NO_DATA_SOURCE" // the schema has no table/column for this at all
  | "NOT_LINKED" // data exists but has no partner/tenant linkage
  | "REQUIRES_BACKEND_WORK" // a writer/producer exists in design only
  | "INSUFFICIENT_DATA"; // statistically too few samples to report

export interface MetricUnavailable {
  available: false;
  reason: UnavailableReason;
  /** Plain-English explanation shown in the UI. Never a number. */
  detail: string;
}

export interface MetricAvailable<T> {
  available: true;
  value: T;
}

export type Metric<T> = MetricAvailable<T> | MetricUnavailable;

export function metric<T>(value: T): MetricAvailable<T> {
  return { available: true, value };
}

export function unavailable(reason: UnavailableReason, detail: string): MetricUnavailable {
  return { available: false, reason, detail };
}

// ---------------------------------------------------------------------------
// Status ladders — mirrored from the authoritative sources, NOT invented.
// ---------------------------------------------------------------------------

/** Partner organisation status. Source: server/partner/partner-management-errors.ts PARTNER_STATUSES. */
export const DASHBOARD_PARTNER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
export type DashboardPartnerStatus = (typeof DASHBOARD_PARTNER_STATUSES)[number];

/**
 * Partner submission status. Source of truth: migrations/0007_partner_submissions.sql:76-77
 *   CHECK (status IN ('draft','submitted_to_mintvault','cancelled'))
 * This is the WHOLE ladder — there is deliberately no "in grading"/"graded" partner-side state.
 */
export const DASHBOARD_SUBMISSION_STATUSES = ["draft", "submitted_to_mintvault", "cancelled"] as const;
export type DashboardSubmissionStatus = (typeof DASHBOARD_SUBMISSION_STATUSES)[number];

/**
 * Connector record state — the REAL operational pipeline for partner work.
 * Source of truth: migrations/0011_partner_connector_reconciliation.sql:23 (the final widening).
 * Do NOT use 0008's original list; it contained 'awaiting_validation', migrated away in 0009.
 */
export const DASHBOARD_CONNECTOR_STATES = [
  "queued",
  "claimed",
  "validating",
  "ready_for_import",
  "importing",
  "reconciliation_required",
  "manual_review",
  "rejected",
  "failed",
  "cancelled",
  "imported",
] as const;
export type DashboardConnectorState = (typeof DASHBOARD_CONNECTOR_STATES)[number];

/** Connector states that represent work stuck needing a human. */
export const BOTTLENECK_STATES: readonly DashboardConnectorState[] = [
  "reconciliation_required",
  "manual_review",
  "failed",
];

// ---------------------------------------------------------------------------
// Sorting — allowlist ONLY. A client-supplied sort key never reaches SQL.
// ---------------------------------------------------------------------------

export const PARTNER_SORT_KEYS = ["created_at", "legal_name", "status", "submissions", "last_activity"] as const;
export type PartnerSortKey = (typeof PARTNER_SORT_KEYS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export function isPartnerSortKey(v: unknown): v is PartnerSortKey {
  return typeof v === "string" && (PARTNER_SORT_KEYS as readonly string[]).includes(v);
}

export function isSortDirection(v: unknown): v is SortDirection {
  return typeof v === "string" && (SORT_DIRECTIONS as readonly string[]).includes(v);
}

export function isDashboardPartnerStatus(v: unknown): v is DashboardPartnerStatus {
  return typeof v === "string" && (DASHBOARD_PARTNER_STATUSES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Pagination — bounded on BOTH axes (page AND pageSize), unlike clampPagination
// which leaves `page` unbounded and permits an arbitrarily deep OFFSET.
// ---------------------------------------------------------------------------

export const DASHBOARD_DEFAULT_PAGE_SIZE = 25;
export const DASHBOARD_MAX_PAGE_SIZE = 100;
/** Hard ceiling so `?page=1e12` cannot produce a 12-digit OFFSET. */
export const DASHBOARD_MAX_PAGE = 500;

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

function toPosInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Clamp both axes. Never throws — an absurd input degrades to the bounds. */
export function clampDashboardPagination(pageRaw: unknown, pageSizeRaw: unknown): Pagination {
  const pageSize = Math.min(DASHBOARD_MAX_PAGE_SIZE, toPosInt(pageSizeRaw, DASHBOARD_DEFAULT_PAGE_SIZE));
  const page = Math.min(DASHBOARD_MAX_PAGE, toPosInt(pageRaw, 1));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export interface Paged<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// A. Network overview
// ---------------------------------------------------------------------------

export interface NetworkSummary {
  shops: {
    total: number;
    active: number;
    suspended: number;
    onboarding: number; // PENDING
    revoked: number;
  };
  staff: {
    total: number;
    active: number;
    /**
     * "Active graders" needs a partner-side grading role assignment that is not
     * populated today (partner_user_roles is unseeded — partner_roles has 0 rows).
     */
    activeGraders: Metric<number>;
  };
  work: {
    /** Cards in the connector pipeline, i.e. genuinely in progress. */
    inProgress: number;
    byState: Record<string, number>;
    bottlenecks: number;
    /** Partner-side submission counts by the real 3-state ladder. */
    submissionsByStatus: Record<string, number>;
    completedToday: Metric<number>;
    completedThisMonth: Metric<number>;
  };
  corrections: {
    /** Connector escalations awaiting a human — the only real "open correction" today. */
    openEscalations: number;
    manualReview: number;
    reconciliationRequired: number;
  };
  security: {
    openAlerts: number;
    bySeverity: Record<string, number>;
  };
  credits: {
    /** Derived from the append-only ledger via partner_credit_availability. Never stored. */
    totalAvailable: Metric<number>;
    totalReserved: Metric<number>;
    consumedThisMonth: Metric<number>;
  };
  /** Areas with no data source at all, surfaced so the UI can explain rather than show 0. */
  unavailable: string[];
  generatedAt: string;
}

/**
 * R2: bounded consolidated data for the canonical Partner Network overview.
 * The browser receives one projection, rather than composing a dashboard by fan-out requests.
 */
export interface PartnerNetworkOverview {
  summary: NetworkSummary;
  partners: Paged<PartnerTableRow>;
  alerts: DashboardAlert[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// B. Partner table row
// ---------------------------------------------------------------------------

export interface PartnerTableRow {
  partnerId: string;
  publicRef: string;
  shopName: string;
  tradingName: string | null;
  status: DashboardPartnerStatus | string;
  onboardingStage: string;
  qualityRating: MetricUnavailable;
  riskStatus: PartnerRisk;
  availableCredits: number | null;
  reservedCredits: number | null;
  activeSubmissions: number;
  cardsInPipeline: number;
  openCorrections: number;
  approvedDevices: MetricUnavailable;
  activeStaff: number;
  lastActivityAt: string | null;
  alertCount: number;
}

/** Risk is DERIVED from real signals only (suspension, lockouts, escalations, security events). */
export interface PartnerRisk {
  level: RiskLevel;
  reasons: string[];
}

export const RISK_LEVELS = ["none", "low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

/**
 * Ordering of severity. Shared so the SQL `CASE` in dashboard-service and the JS `deriveRisk`
 * cannot drift on which signal wins — there is one ranking, proven equivalent by test.
 */
export const RISK_RANK: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

// ---------------------------------------------------------------------------
// C/D. Drill-down sections
// ---------------------------------------------------------------------------

export interface PartnerOverview {
  partnerId: string;
  publicRef: string;
  shopName: string;
  status: string;
  createdAt: string;
  profile: {
    tradingName: string | null;
    organisationKind: string | null;
    onboardingDate: string | null;
    internalTier: string | null;
    healthNote: string | null;
    addressCity: string | null;
    addressCountry: string | null;
  } | null;
  counts: {
    locations: number;
    users: number;
    submissions: number;
    connectorRecords: number;
  };
  /**
   * Grading origin ("Graded by <Shop>" + approved address snapshot) is NOT implemented
   * anywhere in the codebase — the certificate issuer is a hard-coded literal and there is
   * no per-certificate partner origin column. Reported, never invented.
   */
  gradingOrigin: MetricUnavailable;
  certificatesGraded: MetricUnavailable;
}

export interface PartnerStaffRow {
  userId: string;
  publicRef: string;
  email: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  lockedUntil: string | null;
  failedLoginCount: number;
  roles: string[];
  activeSessions: number;
}

export interface PartnerWalletView {
  configured: boolean;
  walletId: string | null;
  status: string | null;
  /** All three derived from the append-only ledger. Never from editable UI state. */
  availableCredits: number | null;
  reservedCredits: number | null;
  ledgerBalance: number | null;
  consumedReservations: number | null;
  recentLedger: LedgerEntryView[];
  purchases: MetricUnavailable;
  /** True when the audited Super Admin adjustment workflow is available. */
  manualAdjustmentEnabled: boolean;
  note: string;
}

export interface LedgerEntryView {
  id: string;
  amount: number;
  entryType: string;
  source: string;
  reason: string;
  actorType: string;
  actorEmail: string | null;
  createdAt: string;
}

export interface PartnerSubmissionsView {
  byStatus: Record<string, number>;
  connectorByState: Record<string, number>;
  recent: PartnerSubmissionRow[];
}

export interface PartnerSubmissionRow {
  id: string;
  publicRef: string;
  status: string;
  cardCount: number;
  estimatedPricePence: number | null;
  createdAt: string;
  submittedAt: string | null;
}

export interface PartnerQualityView {
  /** Every metric in the brief's Section F. All unavailable — no data source exists. */
  metrics: Record<string, MetricUnavailable>;
  overallRating: MetricUnavailable;
  trend: MetricUnavailable;
  graderPerformance: MetricUnavailable;
  explanation: string;
}

export interface PartnerDevicesView {
  devices: never[];
  status: MetricUnavailable;
  scannerTelemetry: MetricUnavailable;
  /** Session activity is the ONLY real proximate signal, and it is a browser session, not a machine. */
  recentSessions: PartnerSessionRow[];
  explanation: string;
}

export interface PartnerSessionRow {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  mfaPassed: boolean;
}

export interface PartnerCorrectionsView {
  /** Connector escalations — the only implemented correction/escalation routing. */
  escalations: PartnerCorrectionRow[];
  counts: { manualReview: number; reconciliationRequired: number; failed: number };
  adminActions: PartnerAdminActionRow[];
  explanation: string;
}

export interface PartnerCorrectionRow {
  recordId: string;
  state: string;
  attemptCount: number;
  lastErrorCategory: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerAdminActionRow {
  id: string;
  actionType: string;
  actorEmail: string;
  reason: string;
  result: string;
  beforeState: string | null;
  afterState: string | null;
  createdAt: string;
}

export interface PartnerSecurityView {
  events: PartnerSecurityEventRow[];
  emergencyControls: PartnerEmergencyControlRow[];
  lockedUsers: number;
}

export interface PartnerSecurityEventRow {
  id: number;
  severity: string;
  kind: string;
  createdAt: string;
}

export interface PartnerEmergencyControlRow {
  id: string;
  scope: string;
  frozen: boolean;
  reason: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// I. Alerts — every alert is derived from a REAL condition, never a placeholder.
// ---------------------------------------------------------------------------

export const ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface DashboardAlert {
  id: string;
  partnerId: string;
  partnerName: string;
  severity: AlertSeverity;
  kind: string;
  reason: string;
  recommendedAction: string;
  /**
   * When the underlying CONDITION was recorded in the database — a real stored timestamp.
   *
   * `null` for alerts derived from a live balance/threshold (e.g. "credits low"), which have no
   * stored detection event. Those are conditions observed at query time, not things that
   * "happened at" a moment, and stamping them with `now()` made every refresh look like a fresh
   * incident. The UI must render null as an evaluated-now state, never as a detection time.
   */
  detectedAt: string | null;
  /** Admin-relative link to the record this alert is about. */
  link: string;
}

export const ALERT_SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function sortAlerts(alerts: DashboardAlert[]): DashboardAlert[] {
  return [...alerts].sort((a, b) => {
    const bySeverity = ALERT_SEVERITY_RANK[a.severity] - ALERT_SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    // Undated (live-condition) alerts sort after dated ones of equal severity; `id` is the final
    // tiebreak so the order is deterministic across requests.
    if (a.detectedAt !== b.detectedAt) {
      if (a.detectedAt === null) return 1;
      if (b.detectedAt === null) return -1;
      return b.detectedAt.localeCompare(a.detectedAt);
    }
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// J. Audit timeline — events from distinct sources are TAGGED, never merged in a
// way that loses which ledger they came from.
// ---------------------------------------------------------------------------

export type AuditSource = "partner_audit" | "security" | "management" | "connector_admin";

export interface AuditTimelineEntry {
  source: AuditSource;
  id: string;
  action: string;
  actorEmail: string | null;
  reason: string | null;
  result: string | null;
  recordType: string | null;
  recordId: string | null;
  severity: string | null;
  createdAt: string;
}
