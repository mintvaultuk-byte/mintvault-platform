import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";

export type CustomerSessionAuthority = {
  userId: string;
  email: string;
  emailVerified: boolean;
  credentialVersion: number;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve a customer session against the live users row.
 *
 * The session document is only a cache: it is never identity authority. Requiring
 * the credential-version stamp makes password/PIN/email changes invalidate every
 * older session even if physical session-row deletion is delayed or fails.
 */
export async function loadCustomerSessionAuthority(req: Request): Promise<CustomerSessionAuthority | null> {
  const session = req.session;
  const userId =
    typeof session?.userId === "string" && session.userId
      ? session.userId
      : session?.authRole === "customer" && typeof session?.authUserId === "string" && session.authUserId
        ? session.authUserId
        : null;
  if (!userId) return null;

  const result = await db.execute(sql`
    SELECT id, email, email_verified, credential_version
    FROM users
    WHERE id = ${userId}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  const row = result.rows[0] as
    { id: string; email: string | null; email_verified: boolean; credential_version: number } | undefined;
  const liveVersion = positiveInteger(row?.credential_version);
  const sessionVersion = positiveInteger(session?.credentialVersion);
  if (
    !row?.id ||
    !row.email ||
    session?.authRole !== "customer" ||
    session?.authUserId !== row.id ||
    liveVersion === null ||
    sessionVersion !== liveVersion
  ) {
    return null;
  }

  return {
    userId: row.id,
    email: row.email.toLowerCase().trim(),
    emailVerified: row.email_verified === true,
    credentialVersion: liveVersion,
  };
}

/**
 * Best-effort physical cleanup for customer sessions in the shared PostgreSQL
 * store. Credential-version validation remains the authoritative revocation gate.
 */
export async function revokeCustomerSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = exceptSessionId
    ? await db.execute(sql`
        DELETE FROM session
        WHERE (sess ->> 'userId' = ${userId} OR sess ->> 'authUserId' = ${userId})
          AND sid <> ${exceptSessionId}
        RETURNING sid
      `)
    : await db.execute(sql`
        DELETE FROM session
        WHERE sess ->> 'userId' = ${userId} OR sess ->> 'authUserId' = ${userId}
        RETURNING sid
      `);
  return result.rows.length;
}
