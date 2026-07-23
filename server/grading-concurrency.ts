import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";

/**
 * Optimistic-concurrency contract for mutable grading evidence on a certificate.
 * This deliberately uses an integer token rather than updated_at: timestamp precision
 * and independently-updated non-grading fields are not a safe compare-and-set token.
 */
export const GRADING_VERSION_CONFLICT = "GRADING_VERSION_CONFLICT";
export const INVALID_GRADING_VERSION = "INVALID_GRADING_VERSION";

const MAX_GRADING_VERSION = 2_147_483_646; // integer max minus one increment

export type GradingVersionConflict = {
  status: 409;
  code: typeof GRADING_VERSION_CONFLICT;
  message: string;
  error: string;
  expectedVersion: number;
  currentVersion: number;
  reload: true;
};

/**
 * `GRADING_CONCURRENCY_COMPATIBILITY_MODE=true` is a short-lived deployment
 * bridge only. It accepts a genuinely missing token from a cached pre-rollout
 * client by substituting the version read by that handler immediately before
 * its CAS update. It never accepts malformed tokens, is off by default, and
 * must be removed from the environment once the current frontend is live.
 */
export function parseExpectedGradingVersion(value: unknown, compatibilityCurrentVersion?: unknown): number {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const candidate = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  const missing = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  const compatibilityVersion = Number(compatibilityCurrentVersion);
  if (
    missing &&
    process.env.GRADING_CONCURRENCY_COMPATIBILITY_MODE === "true" &&
    Number.isSafeInteger(compatibilityVersion) &&
    compatibilityVersion >= 1 &&
    compatibilityVersion <= MAX_GRADING_VERSION
  ) {
    console.warn("[grading-concurrency] accepted missing expectedVersion during temporary compatibility mode");
    return compatibilityVersion;
  }
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_GRADING_VERSION) {
    throw Object.assign(new Error("expectedVersion must be a positive integer grading version"), {
      status: 400,
      code: INVALID_GRADING_VERSION,
    });
  }
  return candidate;
}

export function gradingVersionConflict(expectedVersion: number, currentVersion: number): GradingVersionConflict {
  const message = "A newer grading draft exists. Reload the current grading data before saving again.";
  return {
    status: 409,
    code: GRADING_VERSION_CONFLICT,
    message,
    error: message,
    expectedVersion,
    currentVersion,
    reload: true,
  };
}

export function gradingVersionConflictResponse(conflict: GradingVersionConflict) {
  return {
    error: conflict.message,
    code: conflict.code,
    expectedVersion: conflict.expectedVersion,
    currentVersion: conflict.currentVersion,
    reload: conflict.reload,
  };
}

export async function currentGradingVersion(certId: number): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT grading_version
    FROM certificates
    WHERE id = ${certId} AND deleted_at IS NULL
    LIMIT 1
  `);
  const value = Number((result.rows[0] as any)?.grading_version);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Best-effort, content-free evidence of a rejected stale write. The grading
 * payload itself is intentionally never recorded here.
 */
export async function logGradingVersionConflict(args: {
  certId: number;
  actor: string | null | undefined;
  role: string;
  route: string;
  expectedVersion: number;
  currentVersion: number;
}): Promise<void> {
  try {
    await storage.writeAuditLog(
      "certificate",
      String(args.certId),
      "grading_version_conflict",
      args.actor || "unknown",
      {
        role: args.role,
        route: args.route,
        supplied_version: args.expectedVersion,
        current_version: args.currentVersion,
        outcome: "conflict",
      }
    );
  } catch (error) {
    // A stale write must still be rejected if audit infrastructure is temporarily unavailable.
    console.warn(
      "[grading-concurrency] conflict audit failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
