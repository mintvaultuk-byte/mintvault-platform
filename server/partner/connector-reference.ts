/**
 * Trusted Intake Connector — Phase G3A: concurrency-safe destination reference allocation.
 *
 * Fixes the race identified in the G3 architecture audit: `storage.getNextSubmissionId()`
 * (server/storage.ts) is a plain `COUNT(*)`-based generator with no locking — two concurrent
 * requests can compute the same count and attempt the same tracking number. That generator is left
 * untouched (see DESTINATION-BOUNDARY.md — fixing it is a repository-wide behaviour change outside
 * this task's scope, and the existing checkout flow is unaffected either way since G3 never calls it).
 *
 * This module allocates the SAME `MV-SUB-NNNNNN` format from an independent, dedicated Postgres
 * sequence (`partner_connector_submission_ref_seq`, migration 0010). Because the two generators are
 * independent counters, a candidate from this sequence could in principle collide with a value the
 * OTHER generator already used — the actual, unconditional safety net is the real
 * `UNIQUE(tracking_number)` constraint on `submissions`, checked via a bounded SAVEPOINT-based retry
 * so a single collision never poisons the whole importer transaction (a normal INSERT failure inside
 * a transaction aborts the entire transaction unless wrapped in a SAVEPOINT).
 */
import type pg from "pg";
import { ConnectorError } from "./connector-errors";

const MAX_ALLOCATION_ATTEMPTS = 20;

function formatReference(seq: number | string): string {
  return `MV-SUB-${String(seq).padStart(6, "0")}`;
}

/**
 * Runs `insertWithReference` repeatedly, each attempt wrapped in its own SAVEPOINT, until it
 * succeeds or `MAX_ALLOCATION_ATTEMPTS` is exhausted. `insertWithReference` should attempt exactly
 * one INSERT using the given candidate reference and return its result; on a `tracking_number`
 * unique-violation (Postgres code 23505) this function rolls back to the savepoint and tries the
 * next sequence value. Any OTHER error propagates immediately (not retried) — retry is scoped
 * strictly to reference collisions, never to unrelated failures.
 *
 * No gaplessness is claimed: a rolled-back attempt burns a sequence value, matching any Postgres
 * sequence used inside a transaction that can roll back (documented in migration 0010's own header).
 */
export async function allocateReferenceAndInsert<T>(
  client: pg.PoolClient,
  insertWithReference: (reference: string) => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
    await client.query("SAVEPOINT connector_ref_alloc");
    const { rows } = await client.query<{ nextval: string }>(
      "SELECT nextval('partner_connector_submission_ref_seq') AS nextval"
    );
    const reference = formatReference(rows[0].nextval);
    try {
      const result = await insertWithReference(reference);
      await client.query("RELEASE SAVEPOINT connector_ref_alloc");
      return result;
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      const isTrackingNumberCollision =
        pgErr?.code === "23505" && String(pgErr.constraint ?? "").includes("tracking_number");
      await client.query("ROLLBACK TO SAVEPOINT connector_ref_alloc");
      if (!isTrackingNumberCollision) throw err;
      // fall through to next attempt
    }
  }
  throw new ConnectorError(
    "import_reference_allocation_failed",
    `Could not allocate a unique submission reference after ${MAX_ALLOCATION_ATTEMPTS} attempts.`,
    true
  );
}
