/**
 * Pure catalogue access predicate. The live pickers (rarity/finish/promo) are
 * used by graders AND admins, so catalogue READS are allowed for either; catalogue
 * WRITES stay Super-Admin-only (enforced by requireSuperAdmin on the write routes).
 * Kept pure so the read gate is unit-testable.
 */
export interface CatalogueSessionLike {
  isAdmin?: boolean;
  isGrader?: boolean;
}

/** True when the session may READ the catalogue (admin OR any logged-in grader/staff). */
export function canReadCatalogue(session: CatalogueSessionLike | undefined | null): boolean {
  return Boolean(session?.isAdmin || session?.isGrader);
}
