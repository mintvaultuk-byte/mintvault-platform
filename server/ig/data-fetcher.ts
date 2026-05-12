/**
 * Per-post-type data fetchers.
 *
 * Kept separate from the cron orchestration so:
 *   - the dry-run CLI can call these without invoking the post pipeline
 *   - unit tests / probes can shape IgPostData without DB mocks
 *
 * card_reveal pulls from the certificates table — picks the most recently
 * graded cert that has NOT already been posted (cert_id not in any
 * ig_post_queue row with status='posted'). Falls back to any recent
 * approved cert if the ig_post_queue is empty or unavailable (e.g.
 * migration not yet applied on this branch).
 *
 * Other post types return mostly-static data with one live look-up where
 * useful (service_explainer pulls live tier prices from service_tiers).
 */
import { and, desc, eq, gte, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { certificates, igPostQueue, serviceTiers, type IgPostType } from "@shared/schema";

// Aspirational-grade floor: card_reveal + grade_breakdown only post certs
// scoring at least this. Lower-grade slabs don't make compelling feed content.
// If the high-grade pool is empty we fall back to any approved cert (with a
// warning log) so the cron / Post Now never silently 404s.
const HIGH_GRADE_FLOOR = "8.0";
import type { IgPostData } from "./types";

// Cert IDs are stored "MV-0000000001" but display as "MV42" — strip the
// padding zeroes then drop the "MV" prefix to match the slab front render.
function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  return m ? `MV${m[1]}` : raw;
}
function stripMvPrefix(raw: string): string {
  return raw.replace(/^MV/, "");
}

// Map a tier_id from service_tiers to its human-friendly service-tier label
// the slab uses. Kept here so the IG pipeline doesn't depend on a separate
// shared constants file.
const TIER_DISPLAY_NAMES: Record<string, string> = {
  standard: "Vault Queue",
  priority: "Standard",
  express:  "Express",
  gold:     "Black Label Review",
};

export async function fetchCardRevealData(): Promise<IgPostData> {
  // Subquery: cert_ids that have already been successfully posted.
  // notInArray over a subquery — Drizzle supports this directly.
  const postedSubquery = db
    .select({ id: igPostQueue.certId })
    .from(igPostQueue)
    .where(and(
      isNotNull(igPostQueue.certId),
      eq(igPostQueue.status, "posted"),
      isNull(igPostQueue.deletedAt),
    ));

  let cert: any = null;

  // Preferred path: high-grade (≥ HIGH_GRADE_FLOOR), unposted, most recent first.
  try {
    const rows = await db
      .select()
      .from(certificates)
      .where(and(
        isNull(certificates.deletedAt),
        isNotNull(certificates.gradeApprovedAt),
        gte(certificates.gradeOverall, HIGH_GRADE_FLOOR),
        notInArray(certificates.id, postedSubquery),
      ))
      .orderBy(desc(certificates.gradeOverall), desc(certificates.gradeApprovedAt))
      .limit(1);
    cert = rows[0] ?? null;
  } catch (err: any) {
    // Likely "relation ig_post_queue does not exist" — migration not applied.
    // Skip the unposted-filter, keep the grade filter.
    console.warn(`[ig-data] card_reveal: ig_post_queue lookup failed (${err?.message ?? err}). Falling back to grade-only filter.`);
    try {
      const rows = await db
        .select()
        .from(certificates)
        .where(and(
          isNull(certificates.deletedAt),
          isNotNull(certificates.gradeApprovedAt),
          gte(certificates.gradeOverall, HIGH_GRADE_FLOOR),
        ))
        .orderBy(desc(certificates.gradeOverall), desc(certificates.gradeApprovedAt))
        .limit(1);
      cert = rows[0] ?? null;
    } catch {
      cert = null;
    }
  }

  // Final fallback: no grade ≥ 8 available. Drop the grade floor and pick
  // any recent approved cert. Logged so the operator notices a quiet pool.
  if (!cert) {
    console.warn(`[ig-data] card_reveal: no certs found at grade ≥ ${HIGH_GRADE_FLOOR}. Falling back to any recent approved cert.`);
    const rows = await db
      .select()
      .from(certificates)
      .where(and(
        isNull(certificates.deletedAt),
        isNotNull(certificates.gradeApprovedAt),
      ))
      .orderBy(desc(certificates.gradeApprovedAt))
      .limit(1);
    cert = rows[0] ?? null;
  }

  if (!cert) {
    throw new Error("[ig-data] No approved certs available for card_reveal");
  }

  const tierLabel =
    (cert.serviceTierId && TIER_DISPLAY_NAMES[cert.serviceTierId])
    ?? (cert.labelType === "black" ? "Black Label" : "Standard");

  return {
    postType:         "card_reveal",
    certId:           stripMvPrefix(normalizeCertId(String(cert.certId))),
    cardName:         cert.cardName ?? undefined,
    setName:          cert.setName ?? undefined,
    cardNumber:       cert.cardNumber ?? undefined,
    year:             cert.year ?? undefined,
    variant:          cert.variant ?? undefined,
    rarity:           cert.rarity ?? undefined,
    cardGame:         cert.cardGame ?? undefined,
    language:         cert.language ?? undefined,
    gradeOverall:     cert.gradeOverall ? String(cert.gradeOverall).replace(/\.0$/, "") : undefined,
    gradeType:        cert.gradeType ?? undefined,
    gradeCentering:   cert.gradeCentering ? String(cert.gradeCentering) : undefined,
    gradeCorners:     cert.gradeCorners   ? String(cert.gradeCorners)   : undefined,
    gradeEdges:       cert.gradeEdges     ? String(cert.gradeEdges)     : undefined,
    gradeSurface:     cert.gradeSurface   ? String(cert.gradeSurface)   : undefined,
    labelType:        cert.labelType ?? undefined,
    serviceTierLabel: tierLabel,
    // The grader's overall note doubles as the caption-prompt insight.
    insight:          cert.gradingReport?.overall ?? undefined,
    // Cert.id is the numeric PK — exposed so the cron can write it
    // into ig_post_queue.cert_id. Not part of the documented IgPostData
    // interface; cast through.
    ...({ _certPk: cert.id } as any),
  };
}

export async function fetchGradeBreakdownData(): Promise<IgPostData> {
  // Most-recent graded cert with all four subgrades populated AND overall ≥ 8.
  // Fall back to any subgraded cert if the high-grade pool is empty.
  let cert: any = null;
  try {
    const rows = await db
      .select()
      .from(certificates)
      .where(and(
        isNull(certificates.deletedAt),
        isNotNull(certificates.gradeApprovedAt),
        isNotNull(certificates.gradeCentering),
        isNotNull(certificates.gradeCorners),
        isNotNull(certificates.gradeEdges),
        isNotNull(certificates.gradeSurface),
        gte(certificates.gradeOverall, HIGH_GRADE_FLOOR),
      ))
      .orderBy(desc(certificates.gradeOverall), desc(certificates.gradeApprovedAt))
      .limit(1);
    cert = rows[0] ?? null;
  } catch (err: any) {
    console.warn(`[ig-data] grade_breakdown lookup failed: ${err?.message ?? err}`);
  }

  // Final fallback: no grade ≥ 8 with subgrades. Drop the grade floor.
  if (!cert) {
    console.warn(`[ig-data] grade_breakdown: no subgraded certs at grade ≥ ${HIGH_GRADE_FLOOR}. Falling back to any subgraded cert.`);
    try {
      const rows = await db
        .select()
        .from(certificates)
        .where(and(
          isNull(certificates.deletedAt),
          isNotNull(certificates.gradeApprovedAt),
          isNotNull(certificates.gradeCentering),
          isNotNull(certificates.gradeCorners),
          isNotNull(certificates.gradeEdges),
          isNotNull(certificates.gradeSurface),
        ))
        .orderBy(desc(certificates.gradeApprovedAt))
        .limit(1);
      cert = rows[0] ?? null;
    } catch {
      cert = null;
    }
  }

  if (!cert) {
    return {
      postType:       "grade_breakdown",
      cardName:       "—",
      gradeOverall:   "—",
      gradeCentering: "0",
      gradeCorners:   "0",
      gradeEdges:     "0",
      gradeSurface:   "0",
      insight:        "Approved certs with subgrades will appear here.",
    };
  }

  return {
    postType:       "grade_breakdown",
    cardName:       cert.cardName ?? "—",
    gradeOverall:   cert.gradeOverall ? String(cert.gradeOverall).replace(/\.0$/, "") : "—",
    gradeCentering: String(cert.gradeCentering),
    gradeCorners:   String(cert.gradeCorners),
    gradeEdges:     String(cert.gradeEdges),
    gradeSurface:   String(cert.gradeSurface),
    insight:        cert.gradingReport?.overall ?? "",
    ...({ _certPk: cert.id } as any),
  };
}

export async function fetchServiceExplainerData(tierId: string = "standard"): Promise<IgPostData> {
  let tierRow: any = null;
  try {
    const rows = await db
      .select()
      .from(serviceTiers)
      .where(eq(serviceTiers.tierId, tierId))
      .limit(1);
    tierRow = rows[0] ?? null;
  } catch (err: any) {
    console.warn(`[ig-data] service_explainer: service_tiers lookup failed: ${err?.message ?? err}`);
  }

  return {
    postType:             "service_explainer",
    tierName:             TIER_DISPLAY_NAMES[tierId] ?? tierRow?.name ?? "—",
    tierTagline:          tierRow?.turnaroundLabel ?? "",
    tierPricePence:       tierRow?.pricePerCard ?? undefined,
    tierTurnaroundDays:   tierRow?.turnaroundDays ?? undefined,
    tierTurnaroundLabel:  tierRow?.turnaroundLabel ?? undefined,
  };
}

export function fetchVaultClubData(): IgPostData {
  // Pricing is locked per server/vault-club.ts L142 — £9.99/mo or £99/yr.
  // Benefits curated for the social context; not pulled from DB since
  // marketing copy lives in pricing-v2.tsx and isn't normalised yet.
  return {
    postType:           "vault_club",
    vaultClubMonthly:   "£9.99 / mo",
    vaultClubAnnual:    "£99 / yr",
    vaultClubBenefits:  [
      "Priority grading queue",
      "10% off every submission",
      "Member-only collector reports",
    ],
  };
}

export async function fetchMarketInsightData(): Promise<IgPostData> {
  // Lightweight aggregate over certificates. SQL count of graded certs in the
  // last 7 days. Failure-tolerant — falls back to a generic stat string.
  let weeklyCount = 0;
  try {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM certificates
      WHERE deleted_at IS NULL
        AND grade_approved_at >= NOW() - INTERVAL '7 days'
    `);
    // drizzle returns { rows: [...] } from .execute()
    const first = (rows as any).rows?.[0] ?? (Array.isArray(rows) ? rows[0] : null);
    weeklyCount = first?.n ?? 0;
  } catch (err: any) {
    console.warn(`[ig-data] market_insight count failed: ${err?.message ?? err}`);
  }

  return {
    postType:        "market_insight",
    insightStat:     `${weeklyCount} cards graded`,
    insightContext:  weeklyCount > 0
      ? "This week through the MintVault registry."
      : "Stats are quiet this week — more graded cards landing soon.",
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function fetchPostData(postType: IgPostType, opts: { tierId?: string } = {}): Promise<IgPostData> {
  switch (postType) {
    case "card_reveal":        return fetchCardRevealData();
    case "grade_breakdown":    return fetchGradeBreakdownData();
    case "service_explainer":  return fetchServiceExplainerData(opts.tierId ?? "standard");
    case "vault_club":         return fetchVaultClubData();
    case "market_insight":     return fetchMarketInsightData();
  }
}

/**
 * Daily rotation. day-of-week + week-number both feed the rotation so
 * service_explainer cycles through tiers across consecutive Thursdays.
 *
 * Mon/Wed/Fri/Sun → card_reveal (most engagement)
 * Tue → grade_breakdown
 * Thu → service_explainer (rotating tier_id)
 * Sat → vault_club or market_insight, alternating week-by-week
 */
export function selectPostType(now: Date = new Date()): { postType: IgPostType; tierId?: string } {
  const day = now.getDay();                                // 0=Sun ... 6=Sat
  const weekNumber = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));

  if ([1, 3, 5, 0].includes(day)) return { postType: "card_reveal" };
  if (day === 2)                  return { postType: "grade_breakdown" };
  if (day === 4) {
    const tiers = ["standard", "priority", "express", "gold"];
    return { postType: "service_explainer", tierId: tiers[weekNumber % 4] };
  }
  // Saturday
  return weekNumber % 2 === 0
    ? { postType: "vault_club" }
    : { postType: "market_insight" };
}
