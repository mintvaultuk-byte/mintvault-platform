/**
 * Server-authoritative GB-04 commercial growth service.
 *
 * The Super Admin UI and a future read-only MCP adapter consume this module;
 * route handlers do not recreate revenue, attribution or lead-state rules.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  ACQUISITION_CATEGORIES,
  deriveAcquisitionCategory,
  generateTrackedCampaignLink,
  isApprovedCampaignCode,
  normaliseAttribution,
  type AcquisitionCategory,
} from "./commercial-attribution";
import { PARTNER_APPLICATION_STATUSES, type PartnerApplicationStatus } from "./partner-applications";

export const GROWTH_PERIODS = ["today", "7d", "30d", "90d", "all"] as const;
export type GrowthPeriod = (typeof GROWTH_PERIODS)[number];

export type Metric = { state: "MEASURED"; value: number };
export type NotInstrumented = { state: "NOT_INSTRUMENTED"; reason: string };

export type AcquisitionPerformance = {
  category: AcquisitionCategory | "UNATTRIBUTED";
  paidSubmissions: number;
  paidCards: number;
  revenuePence: number;
  partnerApplications: number;
};

export type CampaignPerformance = AcquisitionPerformance & { campaign: string };

export type GrowthSummary = {
  period: GrowthPeriod;
  timezone: "Europe/London";
  paid: {
    paidSubmissions: Metric;
    paidCards: Metric;
    revenuePence: Metric;
    averageCardsPerPaidOrder: Metric;
    unattributedPaidSubmissions: Metric;
  };
  sourcePerformance: AcquisitionPerformance[];
  campaignPerformance: CampaignPerformance[];
  partnerApplications: {
    total: Metric;
    new: Metric;
    contacted: Metric;
    qualified: Metric;
    notAFit: Metric;
    onboarding: Metric;
  };
  activePartners: Metric | NotInstrumented;
  partnerCardsPerPartner: NotInstrumented;
  partnerRevenue: NotInstrumented;
  repeatCustomerRate: NotInstrumented;
  historical: NotInstrumented;
};

export type GrowthLeadListItem = {
  id: string;
  businessName: string;
  city: string;
  postcode: string;
  businessType: string;
  webPresence: string | null;
  status: PartnerApplicationStatus;
  source: AcquisitionCategory | "UNATTRIBUTED";
  campaign: string;
  createdAt: string;
};

export type GrowthLeadDetail = GrowthLeadListItem & {
  contactName: string;
  email: string;
  phone: string | null;
  interestReason: string;
  physicalRetail: boolean | null;
  categories: string[];
  demandBand: string | null;
  existingGradingSubmissions: string | null;
};

type QueryResult = { rows: unknown[] };
type QueryExecutor = { execute(query: SQL): Promise<QueryResult> };

type AttributionRow = {
  category?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  paid_submissions?: string | number;
  paid_cards?: string | number;
  revenue_pence?: string | number;
  partner_applications?: string | number;
};

type LeadRow = Record<string, unknown>;

export class GrowthLeadNotFoundError extends Error {
  constructor() {
    super("Partner application not found");
  }
}

export function isGrowthPeriod(value: unknown): value is GrowthPeriod {
  return typeof value === "string" && (GROWTH_PERIODS as readonly string[]).includes(value);
}

export function isPartnerLeadStatus(value: unknown): value is PartnerApplicationStatus {
  return typeof value === "string" && (PARTNER_APPLICATION_STATUSES as readonly string[]).includes(value);
}

/** Calendar boundaries are Britain-local rather than machine-local. */
function periodFilter(column: SQL, period: GrowthPeriod): SQL {
  if (period === "all") return sql`TRUE`;
  const days = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 89;
  return sql`${column} >= ((date_trunc('day', now() AT TIME ZONE 'Europe/London') - (${days} * interval '1 day')) AT TIME ZONE 'Europe/London')`;
}

function numberValue(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function categoryForRow(row: AttributionRow, partnerLead: boolean): AcquisitionCategory | "UNATTRIBUTED" {
  const candidate = typeof row.category === "string" ? row.category.toUpperCase() : "";
  if ((ACQUISITION_CATEGORIES as readonly string[]).includes(candidate)) return candidate as AcquisitionCategory;
  if (!partnerLead) return "UNATTRIBUTED";
  const normalised = normaliseAttribution({
    utm_source: row.source,
    utm_medium: row.medium,
    utm_campaign: row.campaign,
  });
  const hasApprovedValue = !!(normalised.source || normalised.medium || normalised.campaign);
  return hasApprovedValue ? deriveAcquisitionCategory(normalised.source, normalised.medium) : "UNATTRIBUTED";
}

function campaignForRow(row: AttributionRow, partnerLead: boolean): string {
  if (!partnerLead && isApprovedCampaignCode(row.campaign)) return row.campaign;
  if (partnerLead) {
    const normalised = normaliseAttribution({
      utm_source: row.source,
      utm_medium: row.medium,
      utm_campaign: row.campaign,
    });
    if (normalised.campaign && isApprovedCampaignCode(normalised.campaign)) return normalised.campaign;
  }
  return "UNATTRIBUTED";
}

function mergeCampaignRows(rows: Array<{ row: AttributionRow; partnerLead: boolean }>): CampaignPerformance[] {
  const merged = new Map<string, CampaignPerformance>();
  for (const { row, partnerLead } of rows) {
    const category = categoryForRow(row, partnerLead);
    const campaign = campaignForRow(row, partnerLead);
    const key = `${category}\u0000${campaign}`;
    const target = merged.get(key) ?? {
      category,
      campaign,
      paidSubmissions: 0,
      paidCards: 0,
      revenuePence: 0,
      partnerApplications: 0,
    };
    target.paidSubmissions += numberValue(row.paid_submissions);
    target.paidCards += numberValue(row.paid_cards);
    target.revenuePence += numberValue(row.revenue_pence);
    target.partnerApplications += numberValue(row.partner_applications);
    merged.set(key, target);
  }
  return [...merged.values()]
    .sort((a, b) => b.revenuePence - a.revenuePence || b.partnerApplications - a.partnerApplications || b.paidSubmissions - a.paidSubmissions)
    .slice(0, 25);
}

function mergeSourceRows(rows: CampaignPerformance[]): AcquisitionPerformance[] {
  const merged = new Map<AcquisitionPerformance["category"], AcquisitionPerformance>();
  for (const row of rows) {
    const target = merged.get(row.category) ?? {
      category: row.category,
      paidSubmissions: 0,
      paidCards: 0,
      revenuePence: 0,
      partnerApplications: 0,
    };
    target.paidSubmissions += row.paidSubmissions;
    target.paidCards += row.paidCards;
    target.revenuePence += row.revenuePence;
    target.partnerApplications += row.partnerApplications;
    merged.set(row.category, target);
  }
  return [...merged.values()].sort(
    (a, b) => b.revenuePence - a.revenuePence || b.partnerApplications - a.partnerApplications || b.paidSubmissions - a.paidSubmissions
  );
}

function measured(value: unknown): Metric {
  return { state: "MEASURED", value: numberValue(value) };
}

export async function getGrowthSummary(period: GrowthPeriod, executor?: QueryExecutor): Promise<GrowthSummary> {
  const runner = executor ?? (await import("./db")).db;
  const paidWindow = periodFilter(sql`payment_timestamp`, period);
  const applicationWindow = periodFilter(sql`created_at`, period);
  const [paidSummary, paidAttribution, partnerSummary, partnerAttribution] = await Promise.all([
    runner.execute(sql`
      SELECT COUNT(*) AS paid_submissions,
             COALESCE(SUM(card_count), 0) AS paid_cards,
             COALESCE(SUM(ROUND(payment_amount * 100)), 0) AS revenue_pence,
             COALESCE(ROUND(SUM(card_count)::numeric / NULLIF(COUNT(*), 0), 2), 0) AS avg_cards,
             COUNT(*) FILTER (WHERE sa.submission_id IS NULL) AS unattributed
      FROM submissions s
      LEFT JOIN submission_acquisition sa ON sa.submission_id = s.id
      WHERE s.payment_status = 'paid' AND s.deleted_at IS NULL AND s.payment_intent_id IS NOT NULL
        AND s.payment_timestamp IS NOT NULL AND s.payment_currency = 'GBP' AND ${paidWindow}
    `),
    runner.execute(sql`
      SELECT COALESCE(sa.acquisition_category, 'UNATTRIBUTED') AS category,
             COALESCE(sa.utm_campaign, 'UNATTRIBUTED') AS campaign,
             COUNT(*) AS paid_submissions,
             COALESCE(SUM(s.card_count), 0) AS paid_cards,
             COALESCE(SUM(ROUND(s.payment_amount * 100)), 0) AS revenue_pence,
             0 AS partner_applications
      FROM submissions s
      LEFT JOIN submission_acquisition sa ON sa.submission_id = s.id
      WHERE s.payment_status = 'paid' AND s.deleted_at IS NULL AND s.payment_intent_id IS NOT NULL
        AND s.payment_timestamp IS NOT NULL AND s.payment_currency = 'GBP' AND ${paidWindow}
      GROUP BY 1, 2
      ORDER BY paid_submissions DESC, revenue_pence DESC
      LIMIT 50
    `),
    runner.execute(sql`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'NEW') AS new_count,
             COUNT(*) FILTER (WHERE status = 'CONTACTED') AS contacted_count,
             COUNT(*) FILTER (WHERE status = 'QUALIFIED') AS qualified_count,
             COUNT(*) FILTER (WHERE status = 'NOT_A_FIT') AS not_a_fit_count,
             COUNT(*) FILTER (WHERE status = 'ONBOARDING') AS onboarding_count
      FROM partner_applications
      WHERE deleted_at IS NULL AND ${applicationWindow}
    `),
    runner.execute(sql`
      SELECT COALESCE(attribution->>'utmSource', '') AS source,
             COALESCE(attribution->>'utmMedium', '') AS medium,
             COALESCE(attribution->>'utmCampaign', '') AS campaign,
             COUNT(*) AS partner_applications
      FROM partner_applications
      WHERE deleted_at IS NULL AND ${applicationWindow}
      GROUP BY 1, 2, 3
      ORDER BY partner_applications DESC
      LIMIT 50
    `),
  ]);

  const paid = (paidSummary.rows[0] ?? {}) as Record<string, unknown>;
  const applications = (partnerSummary.rows[0] ?? {}) as Record<string, unknown>;
  const campaigns = mergeCampaignRows([
    ...(paidAttribution.rows as AttributionRow[]).map((row) => ({ row, partnerLead: false })),
    ...(partnerAttribution.rows as AttributionRow[]).map((row) => ({ row, partnerLead: true })),
  ]);

  let activePartners: Metric | NotInstrumented;
  try {
    const result = await runner.execute(sql`SELECT COUNT(*) AS active_count FROM partner_organisations WHERE status = 'ACTIVE'`);
    activePartners = measured((result.rows[0] as Record<string, unknown> | undefined)?.active_count);
  } catch {
    activePartners = { state: "NOT_INSTRUMENTED", reason: "Active Partner records are unavailable in this environment." };
  }

  return {
    period,
    timezone: "Europe/London",
    paid: {
      paidSubmissions: measured(paid.paid_submissions),
      paidCards: measured(paid.paid_cards),
      revenuePence: measured(paid.revenue_pence),
      averageCardsPerPaidOrder: measured(paid.avg_cards),
      unattributedPaidSubmissions: measured(paid.unattributed),
    },
    sourcePerformance: mergeSourceRows(campaigns),
    campaignPerformance: campaigns,
    partnerApplications: {
      total: measured(applications.total),
      new: measured(applications.new_count),
      contacted: measured(applications.contacted_count),
      qualified: measured(applications.qualified_count),
      notAFit: measured(applications.not_a_fit_count),
      onboarding: measured(applications.onboarding_count),
    },
    activePartners,
    partnerCardsPerPartner: { state: "NOT_INSTRUMENTED", reason: "No authoritative submission-to-Partner link exists." },
    partnerRevenue: { state: "NOT_INSTRUMENTED", reason: "No authoritative paid-order-to-Partner link exists." },
    repeatCustomerRate: { state: "NOT_INSTRUMENTED", reason: "A privacy-reviewed stable repeat-customer method is not instrumented." },
    historical: {
      state: "NOT_INSTRUMENTED",
      reason: "Earlier orders without verified Stripe amount and paid timestamp remain unattributed rather than estimated.",
    },
  };
}

/** Conceptual GB-04B read boundary: sources are derived from the same paid authority as the summary. */
export async function getAcquisitionPerformance(period: GrowthPeriod, executor?: QueryExecutor): Promise<AcquisitionPerformance[]> {
  return (await getGrowthSummary(period, executor)).sourcePerformance;
}

/** Conceptual GB-04B read boundary: campaigns are derived from the same paid authority as the summary. */
export async function getCampaignPerformance(period: GrowthPeriod, executor?: QueryExecutor): Promise<CampaignPerformance[]> {
  return (await getGrowthSummary(period, executor)).campaignPerformance;
}

function leadAttribution(row: LeadRow): { source: AcquisitionCategory | "UNATTRIBUTED"; campaign: string } {
  const attribution = typeof row.attribution === "object" && row.attribution !== null ? (row.attribution as Record<string, unknown>) : {};
  const normalised = normaliseAttribution({
    utm_source: attribution.utmSource,
    utm_medium: attribution.utmMedium,
    utm_campaign: attribution.utmCampaign,
  });
  const recognised = !!(normalised.source || normalised.medium || normalised.campaign);
  return {
    source: recognised ? normalised.category : "UNATTRIBUTED",
    campaign: normalised.campaign && isApprovedCampaignCode(normalised.campaign) ? normalised.campaign : "UNATTRIBUTED",
  };
}

function leadListItem(row: LeadRow): GrowthLeadListItem {
  const status = stringValue(row.status);
  if (!isPartnerLeadStatus(status)) throw new Error("Partner application status contract is invalid");
  const attribution = leadAttribution(row);
  return {
    id: stringValue(row.id),
    businessName: stringValue(row.business_name),
    city: stringValue(row.city),
    postcode: stringValue(row.postcode),
    businessType: stringValue(row.business_type),
    webPresence: row.web_presence ? stringValue(row.web_presence) : null,
    status,
    source: attribution.source,
    campaign: attribution.campaign,
    createdAt: stringValue(row.created_at),
  };
}

function leadDetail(row: LeadRow): GrowthLeadDetail {
  const list = leadListItem(row);
  return {
    ...list,
    contactName: stringValue(row.contact_name),
    email: stringValue(row.email),
    phone: row.phone ? stringValue(row.phone) : null,
    interestReason: stringValue(row.interest_reason),
    physicalRetail: typeof row.physical_retail === "boolean" ? row.physical_retail : null,
    categories: Array.isArray(row.categories) ? row.categories.map(stringValue) : [],
    demandBand: row.demand_band ? stringValue(row.demand_band) : null,
    existingGradingSubmissions: row.existing_grading_submissions ? stringValue(row.existing_grading_submissions) : null,
  };
}

export async function listPartnerApplications(status?: PartnerApplicationStatus): Promise<GrowthLeadListItem[]> {
  const { db } = await import("./db");
  const result = await db.execute(sql`
    SELECT id, business_name, city, postcode, business_type, web_presence, status, attribution, created_at
    FROM partner_applications
    WHERE deleted_at IS NULL AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
    ORDER BY CASE status WHEN 'NEW' THEN 0 WHEN 'CONTACTED' THEN 1 WHEN 'QUALIFIED' THEN 2 WHEN 'ONBOARDING' THEN 3 ELSE 4 END,
             created_at DESC
    LIMIT 100
  `);
  return (result.rows as LeadRow[]).map(leadListItem);
}

export async function getPartnerApplication(id: string): Promise<GrowthLeadDetail> {
  const { db } = await import("./db");
  const result = await db.execute(sql`
    SELECT id, business_name, contact_name, email, city, postcode, business_type, web_presence, interest_reason,
           phone, physical_retail, categories, demand_band, existing_grading_submissions, status, attribution, created_at
    FROM partner_applications
    WHERE id = ${id} AND deleted_at IS NULL
    LIMIT 1
  `);
  const row = result.rows[0] as LeadRow | undefined;
  if (!row) throw new GrowthLeadNotFoundError();
  return leadDetail(row);
}

/**
 * Growth owns only pre-operational lead status. The transaction makes the
 * status change and its PII-free audit record all-or-nothing.
 */
export async function updatePartnerLeadStatus(
  id: string,
  nextStatus: PartnerApplicationStatus,
  actor: string | null
): Promise<{ changed: boolean; status: PartnerApplicationStatus }> {
  const { db } = await import("./db");
  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      SELECT status FROM partner_applications WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
    `);
    const prior = existing.rows[0] as { status?: unknown } | undefined;
    if (!prior || !isPartnerLeadStatus(prior.status)) throw new GrowthLeadNotFoundError();
    if (prior.status === nextStatus) return { changed: false, status: nextStatus };

    const updated = await tx.execute(sql`
      UPDATE partner_applications
      SET status = ${nextStatus}, updated_at = NOW()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id
    `);
    if (updated.rows.length !== 1) throw new GrowthLeadNotFoundError();
    await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES ('partner_application', ${id}, 'growth_status_changed', ${actor},
        ${JSON.stringify({ from: prior.status, to: nextStatus, source: "growth_command" })}::jsonb)
    `);
    return { changed: true, status: nextStatus };
  });
}

export { generateTrackedCampaignLink };
