/**
 * Shared types for the Instagram automation pipeline.
 *
 * IgPostData is the contract between data fetchers (server/jobs/ig-daily-post.ts),
 * the image generator (image-generator.ts), and the caption generator
 * (caption-generator.ts). Every post type populates the subset of fields it
 * needs and leaves the rest undefined.
 */
import type { IgPostType } from "@shared/schema";

export interface IgPostData {
  postType: IgPostType;

  // ── card_reveal ────────────────────────────────────────────────────────
  certId?: string;            // display form, "MV42" (MV- prefix stripped)
  cardName?: string;
  setName?: string;
  cardNumber?: string;
  year?: string;
  variant?: string;
  rarity?: string;
  cardGame?: string;
  language?: string;
  gradeOverall?: string;      // "10", "8.5", or non-numeric like "NO" / "AA"
  gradeType?: string;         // "numeric" | "NO" | "AA"
  gradeCentering?: string;
  gradeCorners?: string;
  gradeEdges?: string;
  gradeSurface?: string;
  labelType?: string;         // "Standard" | "black"
  serviceTierLabel?: string;  // "Vault Queue" / "Standard" / "Express" / "Black Label Review"

  // ── grade_breakdown ────────────────────────────────────────────────────
  insight?: string;           // from cert.gradingReport.overall

  // ── service_explainer ──────────────────────────────────────────────────
  tierName?: string;          // "Vault Queue", "Standard", "Express", "Black Label Review"
  tierTagline?: string;
  tierPricePence?: number;
  tierTurnaroundDays?: number;
  tierTurnaroundLabel?: string;
  tierBenefit?: string;       // one-line distilled benefit

  // ── vault_club ─────────────────────────────────────────────────────────
  vaultClubMonthly?: string;  // "£9.99/mo"
  vaultClubAnnual?: string;   // "£99/yr"
  vaultClubBenefits?: string[];

  // ── market_insight ─────────────────────────────────────────────────────
  insightStat?: string;       // e.g. "127 cards graded this week"
  insightContext?: string;    // one-line elaboration
}
