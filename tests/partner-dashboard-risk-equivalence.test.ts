/**
 * Partner Master Dashboard — risk ladder: SQL ≡ JS.
 *
 * Risk is now derived TWICE: once in SQL (`RISK_LEVEL_SQL`, so the risk filter can run before
 * LIMIT/OFFSET) and once in JS (`deriveRisk`, which also produces the human-readable reasons the
 * UI shows). If those two drift, the dashboard silently filters on one rule and LABELS with
 * another — a partner would appear under "high risk" wearing a "medium" badge, or vanish from a
 * filter it belongs in.
 *
 * This suite makes drift impossible to merge: it evaluates the EXACT exported SQL string against
 * an exhaustive matrix of signal combinations in real Postgres, and compares every result to
 * `deriveRisk` on the same inputs. There is no second copy of the ladder here to fall out of
 * date — both sides are imported from the implementation.
 *
 * Requires PARTNER_MANAGEMENT_RT_ADMIN (disposable loopback Postgres); skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { RISK_LEVEL_SQL, deriveRisk } from "../server/partner/dashboard-service";
import { RISK_LEVELS } from "@shared/partner-dashboard";

const ADMIN_DB = process.env.PARTNER_MANAGEMENT_RT_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB);

/** Every combination that can change the outcome, including both sides of each threshold. */
const STATUSES = ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED"];
const SECURITY_ALERTS = [0, 1, 3];
const LOCKED_STAFF = [0, 1];
const OPEN_CORRECTIONS = [0, 2];
const AVAILABLE_CREDITS: Array<number | null> = [null, -5, 0, 1, 9, 10, 250];

interface Case {
  status: string;
  securityAlerts: number;
  lockedStaff: number;
  openCorrections: number;
  availableCredits: number | null;
}

const CASES: Case[] = [];
for (const status of STATUSES) {
  for (const securityAlerts of SECURITY_ALERTS) {
    for (const lockedStaff of LOCKED_STAFF) {
      for (const openCorrections of OPEN_CORRECTIONS) {
        for (const availableCredits of AVAILABLE_CREDITS) {
          CASES.push({ status, securityAlerts, lockedStaff, openCorrections, availableCredits });
        }
      }
    }
  }
}

let client: Client;

(isLocal ? describe : describe.skip)("risk ladder — SQL and JS agree exactly", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: ADMIN_DB });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it(`produces identical levels for all ${CASES.length} signal combinations`, async () => {
    // Feed the matrix through the REAL SQL expression via a VALUES table whose column names
    // match the ones RISK_LEVEL_SQL references.
    const values = CASES.map(
      (_, i) => `($${i * 5 + 1}::text, $${i * 5 + 2}::int, $${i * 5 + 3}::int, $${i * 5 + 4}::int, $${i * 5 + 5}::bigint)`
    ).join(",");
    const params = CASES.flatMap((c) => [
      c.status,
      c.securityAlerts,
      c.lockedStaff,
      c.openCorrections,
      c.availableCredits,
    ]);

    const { rows } = await client.query<{ idx: string; risk_level: string }>(
      `SELECT (row_number() OVER ())::text AS idx, ${RISK_LEVEL_SQL} AS risk_level
         FROM (VALUES ${values})
           AS t(status, security_alerts, locked_staff, open_corrections, available_credits)`,
      params
    );

    expect(rows).toHaveLength(CASES.length);

    const mismatches: string[] = [];
    rows.forEach((row, i) => {
      const c = CASES[i];
      const js = deriveRisk({
        status: c.status,
        openCorrections: c.openCorrections,
        securityAlerts: c.securityAlerts,
        lockedStaff: c.lockedStaff,
        availableCredits: c.availableCredits,
      }).level;
      if (js !== row.risk_level) {
        mismatches.push(
          `status=${c.status} sec=${c.securityAlerts} locked=${c.lockedStaff} ` +
            `corr=${c.openCorrections} credits=${c.availableCredits}: SQL=${row.risk_level} JS=${js}`
        );
      }
    });

    expect(mismatches, `SQL/JS risk ladder drift:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("only ever emits declared risk levels", async () => {
    const { rows } = await client.query<{ risk_level: string }>(
      `SELECT DISTINCT ${RISK_LEVEL_SQL} AS risk_level
         FROM (VALUES
                ('ACTIVE'::text, 0::int, 0::int, 0::int, NULL::bigint),
                ('SUSPENDED',    0,      0,      0,      100),
                ('ACTIVE',       1,      0,      0,      100),
                ('ACTIVE',       0,      1,      0,      100),
                ('ACTIVE',       0,      0,      1,      100),
                ('ACTIVE',       0,      0,      0,      0),
                ('ACTIVE',       0,      0,      0,      5))
           AS t(status, security_alerts, locked_staff, open_corrections, available_credits)`
    );
    for (const r of rows) {
      expect(RISK_LEVELS as readonly string[]).toContain(r.risk_level);
    }
  });

  it("treats unknown credits (no wallet schema) exactly as JS does — no credit-driven risk", async () => {
    const { rows } = await client.query<{ risk_level: string }>(
      `SELECT ${RISK_LEVEL_SQL} AS risk_level
         FROM (VALUES ('ACTIVE'::text, 0::int, 0::int, 0::int, NULL::bigint))
           AS t(status, security_alerts, locked_staff, open_corrections, available_credits)`
    );
    expect(rows[0].risk_level).toBe("none");
    expect(
      deriveRisk({ status: "ACTIVE", openCorrections: 0, securityAlerts: 0, lockedStaff: 0, availableCredits: null })
        .level
    ).toBe("none");
  });
});
