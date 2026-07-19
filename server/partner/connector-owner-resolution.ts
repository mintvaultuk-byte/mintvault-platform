/**
 * Trusted Intake Connector — Phase G3A: deterministic destination-owner resolution.
 *
 * Fixes the risk identified in the G3 architecture audit: `storage.createSubmission()`
 * (server/storage.ts:411) falls back to `COALESCE(userId, (SELECT id FROM users LIMIT 1),
 * gen_random_uuid())` when no owner is supplied — silently attaching a submission to an arbitrary
 * existing user, or a garbage UUID matching no real row. This module is never allowed to reach that
 * code path at all (see DESTINATION-BOUNDARY.md) — it resolves a real, deterministic owner BEFORE
 * any submission INSERT is attempted, and the importer always passes that resolved id explicitly.
 *
 * See CUSTOMER-OWNERSHIP-DECISION.md for the full design rationale: resolution is keyed by
 * (partner_organisation_id, partner_customer_id), never by email — two different Partner
 * organisations' customers must never resolve to the same MintVault user even if they share an
 * email address. `users.email` is left NULL on connector-created rows (that column carries a
 * DB-level UNIQUE constraint the resolution key deliberately does not rely on).
 */
import type pg from "pg";
import { ConnectorError } from "./connector-errors";

export interface ResolvedOwner {
  userId: string;
  wasCreated: boolean;
}

interface PartnerCustomerSnapshot {
  id: string;
  fullName: string;
  email: string | null;
}

function splitName(fullName: string): { firstName: string | null; lastName: string | null } {
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Resolve (or create) the MintVault `users` row for a validated Partner customer. Must be called
 * inside the importer's own transaction, with `client` holding the connector-record row lock already
 * — this function performs no locking of its own beyond the UNIQUE constraint on
 * `partner_connector_customer_links(partner_organisation_id, partner_customer_id)`, which is what
 * actually prevents two concurrent imports for the same Partner customer from creating two `users`
 * rows (the loser's INSERT conflicts; see the concurrency test for the exact behaviour).
 */
export async function resolveDestinationOwner(
  client: pg.PoolClient,
  params: { partnerOrganisationId: string; customer: PartnerCustomerSnapshot }
): Promise<ResolvedOwner> {
  const { partnerOrganisationId, customer } = params;

  const existing = await client.query<{ mintvault_user_id: string }>(
    `SELECT mintvault_user_id FROM partner_connector_customer_links
      WHERE partner_organisation_id = $1 AND partner_customer_id = $2`,
    [partnerOrganisationId, customer.id]
  );
  if (existing.rows.length === 1) {
    return { userId: existing.rows[0].mintvault_user_id, wasCreated: false };
  }

  const { firstName, lastName } = splitName(customer.fullName);
  const userRes = await client.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, role)
     VALUES ($1, $2, 'customer')
     RETURNING id`,
    [firstName, lastName]
  );
  const userId = userRes.rows[0].id;

  // A failed INSERT aborts the whole enclosing transaction unless wrapped in a SAVEPOINT — the
  // link-uniqueness conflict below is an EXPECTED, handled outcome (a concurrent import for the same
  // Partner customer), not a real failure, so it must not poison the importer's outer transaction.
  await client.query("SAVEPOINT connector_owner_link");
  try {
    await client.query(
      `INSERT INTO partner_connector_customer_links
         (partner_organisation_id, partner_customer_id, mintvault_user_id, email_snapshot)
       VALUES ($1, $2, $3, $4)`,
      [partnerOrganisationId, customer.id, userId, customer.email]
    );
    await client.query("RELEASE SAVEPOINT connector_owner_link");
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    await client.query("ROLLBACK TO SAVEPOINT connector_owner_link");
    if (pgErr?.code === "23505" && String(pgErr.constraint ?? "").includes("org_customer")) {
      // Lost a race with a concurrent import for the SAME Partner customer — the winner's link
      // already exists; the freshly-created `users` row above is simply unused (still valid, just
      // orphaned from this resolution's point of view — acceptable, since it holds no other data and
      // this is the same "lost the reservation race" shape the import-mapping UNIQUE constraint
      // handles at a higher level). Re-read and use the winner's link instead of retrying the INSERT.
      const winner = await client.query<{ mintvault_user_id: string }>(
        `SELECT mintvault_user_id FROM partner_connector_customer_links
          WHERE partner_organisation_id = $1 AND partner_customer_id = $2`,
        [partnerOrganisationId, customer.id]
      );
      if (winner.rows.length === 1) {
        return { userId: winner.rows[0].mintvault_user_id, wasCreated: false };
      }
    }
    throw new ConnectorError("import_owner_resolution_failed", "Could not resolve the destination owner.", true);
  }

  return { userId, wasCreated: true };
}
