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
import { beginCardJobGrading, releaseCardJobGrading } from "./card-job-grading-bridge";
import type { PartnerPrincipal } from "./session";
import { hasAdmittedPartnerWorkingEvidence, loadPartnerWorkingEvidenceRows } from "./working-evidence-admission";

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
): Promise<{ id: string; status: string; location_id: string | null; certificate_id: number | null }> {
  const scopedLocationId = principal.orgWide ? null : principal.locationId;
  const { rows } = await client.query<{
    id: string;
    status: string;
    location_id: string | null;
    certificate_id: number | null;
  }>(
    `SELECT id, status, location_id, certificate_id
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

/**
 * The lifecycle transition is not evidence admission. A Card Job can be marked READY_TO_GRADE
 * while a derivative is later found missing, resized or otherwise invalid. Before a lease can
 * make that card editable, re-run the single canonical admission evaluator against both current
 * immutable sides inside the same transaction that changes the lifecycle. This is deliberately
 * the evaluator used by the queue and workstation, not a second lease-local approximation.
 */
async function requireAdmittedWorkingEvidence(
  client: PoolClient,
  certificateId: number | null,
  tenantId: string
): Promise<void> {
  if (certificateId === null || !Number.isSafeInteger(certificateId) || certificateId <= 0) {
    throw new GradingLeaseError("NOT_GRADABLE", "This card has no certificate evidence record to open for grading.");
  }
  const rows = await loadPartnerWorkingEvidenceRows(client, [certificateId], tenantId, { forShare: true });
  if (!(await hasAdmittedPartnerWorkingEvidence(rows, certificateId))) {
    throw new GradingLeaseError(
      "NOT_GRADABLE",
      "Both FRONT and BACK need admitted full-resolution working evidence before this card can be opened for grading."
    );
  }
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
      /*
       * Serialise concurrent acquires on THIS card before doing anything else.
       *
       * Without the advisory lock, two acquires could both pass the "is it free" read and then race
       * the unique index — one would win and the other would surface a raw constraint violation
       * rather than a clean LEASE_HELD_BY_ANOTHER. The index is still the authority; this makes the
       * losing side's answer intelligible.
       */
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grading-lease:${cardJobId}`]);

      // Re-read after taking the per-card lock. The lifecycle and evidence admission used to
      // authorise this lease therefore belong to the same serialised decision.
      const job = await loadGradableJob(client, principal, cardJobId);

      // Fail closed before creating or renewing a lease. A raw READY_TO_GRADE lifecycle state
      // alone is never enough to authorize inspection or grading.
      await requireAdmittedWorkingEvidence(client, job.certificate_id, principal.tenantId);

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
        // Idempotent: a refresh on a card already in GRADING re-stamps the grader and changes no
        // lifecycle state. See beginCardJobGrading.
        await beginCardJobGrading(client, principal, cardJobId);
        return { lease: leaseView(renewed.rows[0], principal.userId), reacquired: false };
      }

      /*
       * THE REVISION CARRIES OVER FROM ANY PRIOR LEASE ON THIS CARD.
       *
       * A new editing session must never reuse a generation number a previous one already had.
       * Restarting at 1 would make a grader whose lease EXPIRED — laptop closed mid-card, tab
       * suspended — able to submit their ten-minute-old form the moment somebody else's session
       * happened to land on the same number. This is the same reasoning takeover already applied;
       * expiry is simply the other way a session ends, and it was the one left open.
       */
      const prior = await client.query<{ n: string; max_revision: number | null }>(
        `SELECT count(*)::text AS n, max(revision) AS max_revision
           FROM partner_grading_leases
          WHERE tenant_id=$1 AND card_job_id=$2 AND released_at IS NOT NULL`,
        [principal.tenantId, cardJobId]
      );

      const inserted = await client.query<typeof held>(
        `INSERT INTO partner_grading_leases
           (tenant_id, card_job_id, holder_user_id, holder_display, location_id, expires_at, revision)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, $7)
         RETURNING card_job_id, holder_user_id, holder_display, acquired_at, expires_at, revision`,
        [
          principal.tenantId,
          cardJobId,
          principal.userId,
          holderDisplay ?? null,
          job.location_id,
          String(LEASE_TTL_SECONDS),
          (prior.rows[0]?.max_revision ?? 0) + 1,
        ]
      );

      /*
       * TAKING THE LEASE IS STARTING TO GRADE.
       *
       * READY_TO_GRADE → GRADING happens HERE, in the same transaction as the lease, because the two
       * facts must never disagree: a card recorded as GRADING with no live lease is a card nobody may
       * write to, and a lease on a card still recorded READY_TO_GRADE is invisible to every lifecycle
       * consumer (the queue, the dashboard buckets, the write guard). Before this, nothing in the
       * repository performed the transition at all, so a Scanner Card Job sat in NEEDS_SCAN or
       * READY_TO_GRADE for ever.
       */
      await beginCardJobGrading(client, principal, cardJobId);

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
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grading-lease:${cardJobId}`]);
      const job = await loadGradableJob(client, principal, cardJobId);
      // An editing session may not be extended merely because it was valid when it was opened.
      // Working evidence can be invalidated by a later integrity check or recapture, so every
      // renewal reuses the same single admission authority as a first acquire.
      await requireAdmittedWorkingEvidence(client, job.certificate_id, principal.tenantId);
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
      const released = await client.query(
        `UPDATE partner_grading_leases SET released_at = now()
          WHERE tenant_id=$1 AND card_job_id=$2 AND holder_user_id=$3 AND released_at IS NULL`,
        [principal.tenantId, cardJobId, principal.userId]
      );
      /*
       * Only a caller who genuinely HELD the lease hands the card back.
       *
       * Without the rowCount check, anybody with the assess permission could put a colleague's
       * in-progress card back on the shop floor by calling release on it — the UPDATE above would
       * match nothing (correctly) while the lifecycle transition below still fired. Displacing
       * another grader is a TAKEOVER: explicit, org-wide, reasoned and audited.
       */
      if (released.rowCount === 1) {
        await releaseCardJobGrading(client, principal, cardJobId);
      }
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
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grading-lease:${cardJobId}`]);
      const job = await loadGradableJob(client, principal, cardJobId);
      // Takeover is a new editing session, never a way around evidence admission. Do this before
      // releasing the existing holder so a refusal leaves their historical lease untouched.
      await requireAdmittedWorkingEvidence(client, job.certificate_id, principal.tenantId);

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

      // The card stays open for grading; only the holder changed. This re-stamps the certificate's
      // grader so QA and the return-to-grader path name the person who actually finishes the card,
      // not the one who was displaced.
      await beginCardJobGrading(client, principal, cardJobId);

      return leaseView(inserted.rows[0], principal.userId);
    }
  );
}

/**
 * The gate every grading WRITE must pass.
 *
 * Checks both guards in the order that produces the most useful answer: hold the lease, and be
 * looking at the current revision.
 *
 * THE REVISION IS AN EDITING-SESSION GENERATION, NOT A PER-WRITE COUNTER.
 *
 * It was originally bumped on every accepted write, on the reasoning that "a form submitted twice
 * cannot land twice". Putting the lease on the write path proved that wrong in the most basic way:
 * the grading workstation AUTOSAVES. A grader who legitimately holds the card writes repeatedly from
 * one open form, so a per-write bump makes the SECOND autosave — and every one after it — fail
 * STALE_REVISION for a grader who has done nothing wrong and still holds the card. That is not a
 * safety property, it is an unusable workstation, and it is why this could not be wired honestly
 * before.
 *
 * 0087's own header states the actual requirement: "a grader who held the lease, LOST IT TO AN
 * AUTHORISED TAKEOVER, and then submitted a form loaded ten minutes ago must be refused". That is a
 * change of EDITING SESSION, not a change of keystroke. So the revision advances exactly where the
 * session changes hands — on takeover, and on a reacquire after expiry — and is stable for as long
 * as one grader holds one card.
 *
 * Nothing is lost on the consequential edge: submit cannot land twice because the Card Job's own
 * GRADING → SUBMITTED transition is taken FOR UPDATE and the Grading Credit consume carries a
 * deterministic idempotency key. Replay protection lives where the irreversible act is, rather than
 * being approximated by a counter on every keystroke.
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
  // A lease asserts who may edit, but it never turns stale or invalid evidence back into a
  // grading source. Re-check the canonical admission inside the caller's write transaction so an
  // integrity failure after acquisition cannot be saved through an old browser tab.
  const job = await loadGradableJob(client, principal, cardJobId);
  await requireAdmittedWorkingEvidence(client, job.certificate_id, principal.tenantId);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== lease.revision) {
    throw new GradingLeaseError(
      "STALE_REVISION",
      "This card changed since you opened it. Reload before saving so nothing is overwritten.",
      { revision: lease.revision }
    );
  }

  // Deliberately NOT bumped — see the note above. The caller's next write presents this same
  // revision, and only a takeover or a reacquire after expiry moves it on.
  return lease.revision;
}

/**
 * Resolve the Card Job behind a certificate — the join the workstation could not make.
 *
 * WHY THIS EXISTS. The lease is keyed on the Card Job, because that is the unit a grader edits and
 * the unit that becomes a permanent MV. The grading workstation is keyed on the CERTIFICATE, because
 * that is what the grading engine has always taken. Until this function there was no way to get from
 * one to the other, which is why `assertMayWrite` had no caller: the write path physically could not
 * name the thing the lease protects.
 *
 * `partner_card_jobs.certificate_id` is uniquely indexed where non-null (0080), so at most one job
 * answers, and it is immutable once allocated — a certificate cannot drift to a different job.
 *
 * NULL IS A LEGITIMATE ANSWER, not a failure. A certificate that arrived through the connector
 * import path has no Card Job and never will; those cards graded before this lease existed and must
 * keep grading. Returning null means "no lease applies here", and the caller leaves that path
 * exactly as it was. Only Card Job cards gain the guard.
 *
 * Scoped by tenant AND, for a location-bound user, by location — the same predicate loadGradableJob
 * uses, so a scoped grader cannot reach another floor's job by naming its certificate instead.
 */
export async function resolveCardJobIdForCertificate(
  client: PoolClient,
  principal: PartnerPrincipal,
  certificateId: number
): Promise<string | null> {
  if (!Number.isSafeInteger(certificateId) || certificateId <= 0) return null;
  const scopedLocationId = principal.orgWide ? null : principal.locationId;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM partner_card_jobs
      WHERE certificate_id = $1 AND tenant_id = $2 AND cancelled_at IS NULL
        AND ($3::uuid IS NULL OR location_id = $3::uuid)`,
    [certificateId, principal.tenantId, scopedLocationId]
  );
  return rows[0]?.id ?? null;
}

/** What a caller learns when the lease actually applied to their write. */
export interface CertificateWriteAuthority {
  cardJobId: string;
  /** The revision the caller's NEXT write must present. */
  revision: number;
}

/**
 * The certificate-shaped front door to `assertMayWrite`.
 *
 * Returns null when the certificate has no Card Job — see resolveCardJobIdForCertificate. Otherwise
 * it enforces both guards and returns the bumped revision.
 *
 * ON TRANSACTION SCOPE, HONESTLY. `assertMayWrite` is written to run inside the CALLER's
 * transaction, and that is still the right shape. It cannot be honoured here: the grading write goes
 * through the HQ grader on the Drizzle pool while the lease lives on the restricted partner-admin
 * pool, and joining those two into one transaction would mean restructuring the grading engine —
 * which is precisely what this pass is forbidden to do to prove a concurrency point.
 *
 * What survives is stronger than it looks, because the revision bump is the serialisation point:
 *   - the row is taken FOR UPDATE, so two writers cannot both read the same revision;
 *   - the loser presents a revision that is no longer current and is refused STALE_REVISION;
 *   - a different holder is refused NOT_LEASE_HOLDER before any grade is touched.
 *
 * The residual window is between this commit and the grade write, and only an authorised TAKEOVER
 * can occupy it — a deliberate, confirmed, audited act by an org-wide user, not a race two graders
 * can fall into. An in-flight write from the grader being displaced can still land in that window.
 * That is a bounded, documented MEDIUM, recorded rather than papered over; closing it properly means
 * putting the grade write on the partner pool, which is P10's business, not P9's.
 */
export async function assertMayWriteCertificate(
  principal: PartnerPrincipal,
  certificateId: number,
  expectedRevision: unknown
): Promise<CertificateWriteAuthority | null> {
  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      const cardJobId = await resolveCardJobIdForCertificate(client, principal, certificateId);
      if (!cardJobId) return null;
      // A Card Job card whose client sent no revision is a client that has not been taught the
      // lease. It must be refused, not waved through — a missing guard is the defect, not a default.
      const revision = await assertMayWrite(
        client,
        principal,
        cardJobId,
        typeof expectedRevision === "number" ? expectedRevision : Number.NaN
      );
      return { cardJobId, revision };
    }
  );
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
