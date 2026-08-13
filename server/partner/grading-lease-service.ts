/**
 * P9 — THE GRADING EDIT LEASE.
 *
 * THE DEFECT THIS CLOSES. Nothing prevented two graders opening the same Card Job and both saving.
 * The second save simply won, silently, and the first grader's assessment vanished without either
 * of them being told — on a record that becomes a permanent published grade with a certificate
 * behind it.
 *
 * THE TWO GUARDS, AND WHY BOTH ARE NEEDED.
 *
 *   THE LEASE answers "who may write". It is enforced by a partial UNIQUE index, because
 *   "at most one active editor" checked by SELECT-then-INSERT is not enforced at all — two
 *   concurrent acquires interleave between the read and the write.
 *
 *   THE REVISION answers "what were they looking at". A grader who held the lease, lost it to an
 *   authorised takeover, and then submits a form loaded ten minutes ago must be refused. The lease
 *   alone cannot catch that: by then they do not hold it, and the honest answer is "your copy is
 *   stale", not "you are not the holder".
 *
 * EXPIRY WITHOUT A SWEEPER. A grader who closes a laptop must not lock a card forever. Every
 * acquire releases an expired lease inside its own transaction before taking a new one, so
 * correctness never depends on a background job having run. That ordering is the whole design, and
 * it is why acquisition is not a bare INSERT.
 *
 * NOTHING HERE IS PROCESS-LOCAL. The lease lives in PostgreSQL because a lease in memory would be
 * lost on every rolling deploy and invisible to the other Fly Machine — two graders routed to
 * different machines would both believe they held it (invariant I19).
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";

export class GradingLeaseError extends Error {
  constructor(
    public code:
      | "CARD_JOB_NOT_FOUND"
      | "LEASE_HELD_BY_ANOTHER"
      | "NOT_LEASE_HOLDER"
      | "LEASE_EXPIRED"
      | "STALE_REVISION"
      | "NOT_GRADABLE"
      | "FORBIDDEN",
    message: string,
    /** Safe, minimal detail for the occupied banner. Never an email or any other PII. */
    public detail?: { holderDisplay?: string | null; expiresAt?: string; revision?: number }
  ) {
    super(message);
  }
}

/**
 * How long a lease survives without a heartbeat.
 *
 * Two minutes against a 30-second heartbeat — four missed beats. Long enough that a slow network or
 * a brief tab suspension does not hand somebody's card to a colleague mid-assessment, short enough
 * that a genuinely abandoned card frees up while the operator is still standing there.
 */
export const LEASE_TTL_SECONDS = 120;

/** Card Job states in which grading may legitimately be edited. */
const GRADABLE_STATUSES = new Set(["READY_TO_GRADE", "GRADING"]);

/** The permission that means "may grade". SCANNER_OPERATOR deliberately does not hold it. */
export const GRADING_PERMISSION = "partner.cards.assess";

export interface LeaseView {
  cardJobId: string;
  holderUserId: string;
  holderDisplay: string | null;
  acquiredAt: string;
  expiresAt: string;
  revision: number;
  /** True when the CALLER holds it. The client must never infer this by comparing ids itself. */
  heldByYou: boolean;
}

function leaseView(
  row: {
    card_job_id: string;
    holder_user_id: string;
    holder_display: string | null;
    acquired_at: string;
    expires_at: string;
    revision: number;
  },
  callerUserId: string
): LeaseView {
  return {
    cardJobId: row.card_job_id,
    holderUserId: row.holder_user_id,
    holderDisplay: row.holder_display,
    acquiredAt: new Date(row.acquired_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revision: row.revision,
    heldByYou: row.holder_user_id === callerUserId,
  };
}

/**
 * Load the Card Job with a HARD tenant predicate, and a location predicate for scoped users.
 *
 * Cross-tenant and cross-location both resolve to CARD_JOB_NOT_FOUND rather than a distinct
 * FORBIDDEN: a different answer would confirm that the id is real and belongs to somebody, which is
 * the fact a prober is after.
 */
async function loadGradableJob(
  client: PoolClient,
  principal: PartnerPrincipal,
  cardJobId: string
): Promise<{ id: string; status: string; location_id: string | null }> {
  const scopedLocationId = principal.orgWide ? null : principal.locationId;
  const { rows } = await client.query<{ id: string; status: string; location_id: string | null }>(
    `SELECT id, status, location_id
       FROM partner_card_jobs
      WHERE id = $1 AND tenant_id = $2 AND cancelled_at IS NULL
        AND ($3::uuid IS NULL OR location_id = $3::uuid)`,
    [cardJobId, principal.tenantId, scopedLocationId]
  );
  const row = rows[0];
  if (!row) throw new GradingLeaseError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
  if (!GRADABLE_STATUSES.has(row.status)) {
    throw new GradingLeaseError("NOT_GRADABLE", `A card in ${row.status} is not open for grading.`);
  }
  return row;
}

/** Every grading action requires the assess permission. SCANNER_OPERATOR never holds it. */
function assertMayGrade(principal: PartnerPrincipal): void {
  if (!principal.permissions.has(GRADING_PERMISSION)) {
    throw new GradingLeaseError("FORBIDDEN", "Your role does not include grading.");
  }
}

/**
 * Retire any lease on this Card Job that has passed its expiry.
 *
 * Runs inside the caller's transaction, immediately before an acquire. This is what makes an
 * abandoned lease reacquirable WITHOUT a background sweeper — correctness never waits for a job to
 * have run. Released rather than deleted, because a lease is evidence of who was editing when.
 */
async function releaseExpired(client: PoolClient, tenantId: string, cardJobId: string): Promise<void> {
  await client.query(
    `UPDATE partner_grading_leases
        SET released_at = now()
      WHERE tenant_id = $1 AND card_job_id = $2
        AND released_at IS NULL
        AND expires_at <= now()`,
    [tenantId, cardJobId]
  );
}

export interface AcquireResult {
  lease: LeaseView;
  /** True when an expired lease was reclaimed rather than a free card taken. */
  reacquired: boolean;
}

/**
 * Take the edit lease, or fail loudly telling the caller who holds it.
 *
 * IDEMPOTENT FOR THE HOLDER: a grader who already holds it gets it back with the expiry extended,
 * so a page refresh does not lock somebody out of their own card.
 */
export async function acquireLease(
  principal: PartnerPrincipal,
  cardJobId: string,
  holderDisplay?: string | null
): Promise<AcquireResult> {
  assertMayGrade(principal);
  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      const job = await loadGradableJob(client, principal, cardJobId);

      /*
       * Serialise concurrent acquires on THIS card before doing anything else.
       *
       * Without the advisory lock, two acquires could both pass the "is it free" read and then race
       * the unique index — one would win and the other would surface a raw constraint violation
       * rather than a clean LEASE_HELD_BY_ANOTHER. The index is still the authority; this makes the
       * losing side's answer intelligible.
       */
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grading-lease:${cardJobId}`]);

      await releaseExpired(client, principal.tenantId, cardJobId);

      const existing = await client.query<{
        card_job_id: string;
        holder_user_id: string;
        holder_display: string | null;
        acquired_at: string;
        expires_at: string;
        revision: number;
      }>(
        `SELECT card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision
           FROM partner_grading_leases
          WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL`,
        [principal.tenantId, cardJobId]
      );

      const held = existing.rows[0];
      if (held && held.holder_user_id !== principal.userId) {
        throw new GradingLeaseError(
          "LEASE_HELD_BY_ANOTHER",
          "Another grader is working on this card.",
          // Enough for an honest banner, and no more: a display name the shop already shows its own
          // staff, never an email or a user id.
          { holderDisplay: held.holder_display, expiresAt: new Date(held.expires_at).toISOString() }
        );
      }

      if (held) {
        // Already ours — extend rather than churn, so a refresh is not a lock-out.
        const renewed = await client.query<typeof held>(
          `UPDATE partner_grading_leases
              SET heartbeat_at = now(), expires_at = now() + ($3 || ' seconds')::interval
            WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL
            RETURNING card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision`,
          [principal.tenantId, cardJobId, String(LEASE_TTL_SECONDS)]
        );
        return { lease: leaseView(renewed.rows[0], principal.userId), reacquired: false };
      }

      const inserted = await client.query<typeof held>(
        `INSERT INTO partner_grading_leases
           (tenant_id, card_job_id, holder_user_id, holder_display, location_id, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
         RETURNING card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision`,
        [
          principal.tenantId,
          cardJobId,
          principal.userId,
          holderDisplay ?? null,
          job.location_id,
          String(LEASE_TTL_SECONDS),
        ]
      );

      const prior = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM partner_grading_leases
          WHERE tenant_id=$1 AND card_job_id=$2 AND released_at IS NOT NULL`,
        [principal.tenantId, cardJobId]
      );

      return { lease: leaseView(inserted.rows[0], principal.userId), reacquired: Number(prior.rows[0].n) > 0 };
    }
  );
}

/**
 * Extend the lease. Refuses anybody who is not the current holder, and refuses an expired one.
 *
 * An expired lease is NOT silently renewed: the holder may have been away for an hour and somebody
 * else may now be part-way through the card. They must go back through acquire, which will tell
 * them so.
 */
export async function heartbeatLease(principal: PartnerPrincipal, cardJobId: string): Promise<LeaseView> {
  assertMayGrade(principal);
  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      const renewed = await client.query<{
        card_job_id: string;
        holder_user_id: string;
        holder_display: string | null;
        acquired_at: string;
        expires_at: string;
        revision: number;
      }>(
        `UPDATE partner_grading_leases
            SET heartbeat_at = now(), expires_at = now() + ($4 || ' seconds')::interval
          WHERE tenant_id = $1 AND card_job_id = $2
            AND holder_user_id = $3
            AND released_at IS NULL
            AND expires_at > now()
          RETURNING card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision`,
        [principal.tenantId, cardJobId, principal.userId, String(LEASE_TTL_SECONDS)]
      );
      if (renewed.rowCount === 0) {
        throw new GradingLeaseError("LEASE_EXPIRED", "Your editing session on this card has ended. Reopen the card.");
      }
      return leaseView(renewed.rows[0], principal.userId);
    }
  );
}

/** Give the card back. Only the holder may release; anyone else releasing would be a takeover. */
export async function releaseLease(principal: PartnerPrincipal, cardJobId: string): Promise<void> {
  await withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      await client.query(
        `UPDATE partner_grading_leases SET released_at = now()
          WHERE tenant_id=$1 AND card_job_id=$2 AND holder_user_id=$3 AND released_at IS NULL`,
        [principal.tenantId, cardJobId, principal.userId]
      );
    }
  );
}

/**
 * Take the card off whoever holds it. EXPLICIT, PERMISSIONED AND AUDITED.
 *
 * Never automatic. A takeover ends somebody's work in progress, so it is a deliberate act by
 * somebody entitled to make it, and the audit row is what lets that be reviewed afterwards. The
 * previous holder is not merely bumped: their lease is marked `taken_over_by`, which is how the
 * trail distinguishes a grader who finished from one whose card was removed.
 *
 * Requires `partner.cards.assess` AND organisation-wide authority — a location-scoped grader may
 * not seize a colleague's work.
 */
export async function takeoverLease(
  principal: PartnerPrincipal,
  cardJobId: string,
  reason: string,
  holderDisplay?: string | null
): Promise<LeaseView> {
  assertMayGrade(principal);
  if (!principal.orgWide) {
    throw new GradingLeaseError("FORBIDDEN", "Only an owner or manager can take over another grader's card.");
  }
  const cleanReason = (reason ?? "").trim();
  if (!cleanReason) {
    // An unexplained takeover is indistinguishable from an accident or a grudge. The audit row is
    // the only thing that can tell them apart later.
    throw new GradingLeaseError("FORBIDDEN", "A reason is required to take over another grader's card.");
  }

  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      await loadGradableJob(client, principal, cardJobId);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grading-lease:${cardJobId}`]);

      const previous = await client.query<{ holder_user_id: string; revision: number }>(
        `UPDATE partner_grading_leases
            SET released_at = now(), taken_over_by = $3, taken_over_at = now()
          WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL
          RETURNING holder_user_id, revision`,
        [principal.tenantId, cardJobId, principal.userId]
      );

      const inserted = await client.query<{
        card_job_id: string;
        holder_user_id: string;
        holder_display: string | null;
        acquired_at: string;
        expires_at: string;
        revision: number;
      }>(
        `INSERT INTO partner_grading_leases
           (tenant_id, card_job_id, holder_user_id, holder_display, expires_at, revision)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, $6)
         RETURNING card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision`,
        [
          principal.tenantId,
          cardJobId,
          principal.userId,
          holderDisplay ?? null,
          String(LEASE_TTL_SECONDS),
          // The revision CARRIES OVER. Restarting it at 1 would make the displaced grader's stale
          // form look current again, which is the exact write this whole mechanism exists to refuse.
          (previous.rows[0]?.revision ?? 0) + 1,
        ]
      );

      await writePartnerAudit(client, {
        tenantId: principal.tenantId,
        locationId: principal.locationId ?? null,
        actorUserId: principal.userId,
        action: "partner_grading_lease_taken_over",
        recordType: "partner_card_job",
        recordId: cardJobId,
        before: {
          holderUserId: previous.rows[0]?.holder_user_id ?? null,
          revision: previous.rows[0]?.revision ?? null,
        },
        after: { holderUserId: principal.userId, revision: inserted.rows[0].revision },
        reason: cleanReason,
      });

      return leaseView(inserted.rows[0], principal.userId);
    }
  );
}

/**
 * The gate every grading WRITE must pass.
 *
 * Checks both guards in the order that produces the most useful answer: hold the lease, and be
 * looking at the current revision. A caller who passes gets the NEW revision back, which their next
 * write must present — so a form submitted twice cannot land twice.
 *
 * Returns inside the caller's transaction deliberately: a write that is authorised and then
 * separately performed leaves a window in which the lease could be taken between the two.
 */
export async function assertMayWrite(
  client: PoolClient,
  principal: PartnerPrincipal,
  cardJobId: string,
  expectedRevision: number
): Promise<number> {
  assertMayGrade(principal);
  const { rows } = await client.query<{ holder_user_id: string; revision: number; expired: boolean }>(
    `SELECT holder_user_id, revision, (expires_at <= now()) AS expired
       FROM partner_grading_leases
      WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL
      FOR UPDATE`,
    [principal.tenantId, cardJobId]
  );
  const lease = rows[0];
  if (!lease) throw new GradingLeaseError("NOT_LEASE_HOLDER", "Reopen this card before saving — you do not hold it.");
  if (lease.holder_user_id !== principal.userId) {
    throw new GradingLeaseError("NOT_LEASE_HOLDER", "Another grader now holds this card. Your changes were not saved.");
  }
  if (lease.expired) {
    throw new GradingLeaseError("LEASE_EXPIRED", "Your editing session ended. Reopen the card before saving.");
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision !== lease.revision) {
    throw new GradingLeaseError(
      "STALE_REVISION",
      "This card changed since you opened it. Reload before saving so nothing is overwritten.",
      { revision: lease.revision }
    );
  }

  const bumped = await client.query<{ revision: number }>(
    `UPDATE partner_grading_leases SET revision = revision + 1
      WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL
      RETURNING revision`,
    [principal.tenantId, cardJobId]
  );
  return bumped.rows[0].revision;
}

/** Read the current lease without taking it — for rendering an occupied banner. */
export async function getLease(principal: PartnerPrincipal, cardJobId: string): Promise<LeaseView | null> {
  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      await loadGradableJob(client, principal, cardJobId);
      const { rows } = await client.query<{
        card_job_id: string;
        holder_user_id: string;
        holder_display: string | null;
        acquired_at: string;
        expires_at: string;
        revision: number;
      }>(
        `SELECT card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision
           FROM partner_grading_leases
          WHERE tenant_id = $1 AND card_job_id = $2 AND released_at IS NULL AND expires_at > now()`,
        [principal.tenantId, cardJobId]
      );
      return rows[0] ? leaseView(rows[0], principal.userId) : null;
    }
  );
}
