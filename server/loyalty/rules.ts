/**
 * Loyalty programme — earn rates + multipliers.
 *
 * Two anchors:
 *   1. Submissions  — points awarded once per submission when status='completed',
 *                     based on the submission's serviceTier.
 *   2. Certificates — per-card service points awarded when grade_approved_at
 *                     is set, based on the resulting label or service.
 *
 * Multiplier: Vault Club Silver members get 1.5× on every earn. Math.floor
 * applied AT AWARD TIME (i.e. the integer point delta is what's recorded
 * in the ledger; the 1.5× isn't reapplied later).
 *
 * Source of truth for the actual numbers awaits legal sign-off of the
 * programme T&Cs. These constants land here so the service code can
 * reference them; nothing in this PR awards real points to real users.
 */

export const EARN_SUBMISSION = {
  VAULT_QUEUE: 1,
  STANDARD:    2,
  EXPRESS:     4,
} as const;

export const EARN_CERTIFICATE = {
  BLACK_LABEL:    7,
  AUTHENTICATION: 1,
  REHOLDER:       1,
  CROSSOVER:      2,
} as const;

export const VAULT_CLUB_SILVER_MULTIPLIER = 1.5;

export type SubmissionTier   = keyof typeof EARN_SUBMISSION;
export type CertificateService = keyof typeof EARN_CERTIFICATE;

/**
 * Apply the Vault Club multiplier (if the user qualifies) and floor to int.
 * Pure function; no DB hits — the caller passes in `isVaultClubSilver`.
 */
export function applyMultiplier(basePoints: number, isVaultClubSilver: boolean): number {
  if (!isVaultClubSilver) return basePoints;
  return Math.floor(basePoints * VAULT_CLUB_SILVER_MULTIPLIER);
}
