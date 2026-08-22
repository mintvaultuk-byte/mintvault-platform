/**
 * THE ONBOARDING TEST CARD — declaring one, and reporting where it got to.
 *
 * WHAT PROBLEM THIS SOLVES. Before a shop is handed a live counter it should put ONE real card
 * through the whole chain: scan front, scan back, hand off to MintVault, get it graded and approved.
 * Onboarding needed to know whether that had happened, and there was no canonical way to ask —
 * every available answer was a guess about which Card Job "the test one" was (the newest job, the
 * newest MV number, the newest submission, whatever was created near setup time). Each of those
 * starts naming a real customer's card the moment a shop scans a live card during onboarding, and a
 * gate built on a mislabel is worse than no gate at all.
 *
 * Migration 0109 replaces the guess with a declaration: `partner_card_jobs.purpose`. This module
 * owns both ends of it — MintVault DECLARING a shop's next card to be the test (the armed intent,
 * consumed inside the NEW transaction by card-job-authority), and READING back what became of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never writes a Card Job, never reserves or releases a credit,
 * never touches grading, evidence, certificates or MV allocation, and never reads across tenants.
 * A test card is an ordinary paid card that happens to be labelled — that is the entire feature.
 */
import { partnerAdminQuery } from "./db";
import { testCardStateOf, type PartnerTestCardFacts } from "./operational-readiness";

/**
 * Read this shop's onboarding test-card facts.
 *
 * Returns null — meaning UNKNOWN, never "no test card" — when the Card Job authority cannot be
 * consulted at all: `partner_card_jobs` absent, or `purpose` absent because migration 0109 has not
 * been applied to this database. Both are real states during a rolling deploy, and both must
 * withhold readiness rather than quietly report a shop as untested (which would be a guess) or as
 * complete (which would be worse).
 */
export async function loadPartnerTestCardFacts(tenantId: string): Promise<PartnerTestCardFacts | null> {
  let rows: Array<{ id: string; mv_number: string | null; status: string; certificate_id: number | null }>;
  try {
    /*
     * EXPLICIT MARKER ONLY. There is no ORDER-BY-created_at fallback to "the newest card" and no
     * date window: a shop with no marked job has NOT started its test card, full stop.
     *
     * LIMIT 50 is a safety bound, not a business rule. 0109 permits at most one OPEN test card per
     * shop, so the realistic row count is one or two; the bound exists so a pathological history
     * cannot turn a readiness read into an unbounded scan.
     */
    const result = await partnerAdminQuery<{
      id: string;
      mv_number: string | null;
      status: string;
      certificate_id: number | null;
    }>(
      `SELECT id, mv_number, status, certificate_id
         FROM partner_card_jobs
        WHERE tenant_id = $1 AND purpose = 'ONBOARDING_TEST'
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [tenantId]
    );
    rows = result.rows;
  } catch {
    return null;
  }

  // Counted, not read off the latest row: a shop that has already proven a card end to end stays
  // proven even if it later starts another test card. See PartnerTestCardFacts.completedCount.
  const completedCount = rows.filter((row) => testCardStateOf(row.status) === "COMPLETE").length;
  const latest = rows[0] ?? null;
  if (!latest) return { completedCount, latest: null };

  return {
    completedCount,
    latest: {
      id: latest.id,
      mvNumber: latest.mv_number,
      status: latest.status,
      sidesAccepted: await loadAcceptedSides(tenantId, latest.certificate_id),
    },
  };
}

/**
 * Which sides the CAPTURE authority has accepted for this card.
 *
 * Deliberately the SAME predicate `bothSidesCaptured` uses to promote a job to READY_TO_GRADE —
 * current immutable TIFF master, bound to a terminal capture session, on an ACTIVE station owned by
 * this tenant. Re-deriving it with a looser rule here would let onboarding show "front accepted"
 * for evidence the lifecycle does not count, which is the two-authorities drift this whole readiness
 * package exists to end.
 *
 * Informational only: the STATE comes from the Card Job status, which the capture path already
 * advances. So `null` (a partner-only database with no scanner evidence tables, or a job with no
 * certificate yet) degrades the display and nothing else.
 */
async function loadAcceptedSides(
  tenantId: string,
  certificateId: number | null
): Promise<Array<"front" | "back"> | null> {
  if (certificateId === null) return null;
  try {
    const { rows } = await partnerAdminQuery<{ side: string }>(
      `SELECT evidence.side
         FROM certificate_image_evidence evidence
         JOIN scanner_capture_sessions session
           ON session.id = evidence.capture_metadata ->> 'captureSessionId'
          AND session.certificate_id = evidence.certificate_id
          AND session.side = evidence.side
          AND session.state = 'captured'
         JOIN partner_stations station
           ON station.id = session.station_id
          AND station.status = 'ACTIVE'
          AND station.tenant_id = $2::uuid
        WHERE evidence.certificate_id = $1
          AND evidence.is_current = true
          AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
          AND evidence.format = 'tiff'
        GROUP BY evidence.side`,
      [certificateId, tenantId]
    );
    const sides: Array<"front" | "back"> = [];
    for (const side of ["front", "back"] as const) {
      if (rows.some((row) => row.side === side)) sides.push(side);
    }
    return sides;
  } catch {
    return null;
  }
}

/**
 * Is a test card currently armed for this shop?
 *
 * Read separately from the Card Job facts because it answers a different question: not "how far has
 * the test card got" but "has MintVault told this shop's next card to BE the test card". The wizard
 * needs both — an armed shop that has not scanned yet is waiting on the operator at the Mac, not on
 * MintVault.
 *
 * null means the arming authority could not be read (0109 not applied). Not false: an unapplied
 * migration is not proof that nothing is armed.
 */
export async function loadOnboardingTestCardArmedAt(tenantId: string): Promise<string | null | undefined> {
  try {
    const { rows } = await partnerAdminQuery<{ armed_at: string | null }>(
      `SELECT onboarding_test_card_armed_at AS armed_at FROM partner_profiles WHERE tenant_id = $1`,
      [tenantId]
    );
    // No profile row is a definite "nothing armed" — the column is per-Partner and there is no
    // Partner-level state to be uncertain about.
    return rows[0]?.armed_at ?? null;
  } catch {
    return undefined;
  }
}
