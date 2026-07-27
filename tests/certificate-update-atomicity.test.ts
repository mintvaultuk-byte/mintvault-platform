/**
 * certificate-update-atomicity.test.ts — DB-backed (hostile-review H7).
 *
 * Proves the certificate metadata update and its audit row commit inside ONE
 * real database transaction against a disposable PostgreSQL 17 cluster. This is
 * NOT simulated atomicity: the assertions read the committed rows back out of
 * Postgres after each attempt.
 *
 * Contract under test (H7):
 *   • update succeeds + audit succeeds → BOTH commit
 *   • update fails                     → NO audit row
 *   • audit fails                      → certificate update ROLLS BACK
 *   • row missing                      → neither update nor audit
 *
 * No staging or production database is touched — the cluster is created and
 * destroyed by this file.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Pool } = pg;

const runtime: { db: any; pool: any } = { db: null, pool: null };

vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("db used before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));

let cluster: DisposablePostgres17 | null = null;
let pool: pg.Pool | null = null;
let storage: typeof import("../server/storage").storage;

/**
 * Build the two tables from the REAL drizzle schema rather than hand-writing a
 * minimal subset. `updateCertificateAudited` uses `.returning()`, which selects
 * every column drizzle declares — a hand-written subset silently diverges from
 * production and fails on the next schema change. Generating the DDL from
 * `getTableConfig` keeps this test honest and self-maintaining.
 */
async function createSchema(p: pg.Pool): Promise<void> {
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { certificates, auditLog } = await import("../shared/schema");

  const ddlFor = (table: any): string => {
    const cfg = getTableConfig(table);
    const cols = cfg.columns.map((c: any) => {
      let type: string = c.getSQLType();
      // pgvector is not installed on the disposable cluster and is irrelevant to
      // the transaction contract — stand it in as TEXT so `.returning()` still
      // resolves every declared column.
      if (/^vector/i.test(type)) type = "text";
      if (c.primary && /serial|integer/i.test(type)) type = "SERIAL";
      const parts = [`"${c.name}"`, type];
      if (c.primary) parts.push("PRIMARY KEY");
      // NOT NULL is deliberately relaxed for non-primary columns: this suite
      // seeds only the fields under test, and production defaults are not the
      // contract being proven here.
      return parts.join(" ");
    });
    return `CREATE TABLE "${cfg.name}" (${cols.join(", ")});`;
  };

  await p.query(ddlFor(certificates));
  await p.query(ddlFor(auditLog));
  // The audit trail must be able to record a JSON payload.
  await p.query(`ALTER TABLE "audit_log" ALTER COLUMN "details" SET DEFAULT '{}'::jsonb`);
}

const q = async (text: string, params: unknown[] = []) => (await pool!.query(text, params)).rows;

/** Read the seeded certificate back through drizzle, so column-name mapping is
 *  always production's, never a hand-maintained copy. */
async function readCert() {
  const { certificates } = await import("../shared/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await runtime.db.select().from(certificates).where(eq(certificates.certId, "MV1"));
  return row;
}
async function readAudits() {
  const { auditLog } = await import("../shared/schema");
  return await runtime.db.select().from(auditLog);
}
async function seededId(): Promise<number> {
  return (await readCert()).id as number;
}

beforeAll(async () => {
  cluster = await startPostgres17("cert-update-atomicity");
  pool = new Pool({ connectionString: cluster.url, max: 4 });
  runtime.pool = pool;
  runtime.db = drizzle(pool);
  await createSchema(pool);
  ({ storage } = await import("../server/storage"));
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  const { certificates, auditLog } = await import("../shared/schema");
  await runtime.db.delete(auditLog);
  await runtime.db.delete(certificates);
  await runtime.db.insert(certificates).values({
    certId: "MV1",
    cardName: "Charizard",
    setName: "Base Set",
    cardNumber: "4/102",
    year: "1999",
    designations: ["PROMO"],
  } as any);
});


describe("H7: certificate update + audit are ONE transaction (real PostgreSQL)", () => {
  it("both commit when the update and the audit succeed", async () => {
    const id = await seededId();
    const updated = await storage.updateCertificateAudited(
      id,
      { cardName: "Charizard (corrected)" } as any,
      {
        entityId: "MV1",
        action: "update",
        adminUser: "tester@example.com",
        details: { scope: "certificate_only", changes: [{ field: "cardName", previous: "Charizard", next: "Charizard (corrected)" }] },
      },
    );
    expect(updated?.cardName).toBe("Charizard (corrected)");

    const cert = await readCert();
    expect(cert.cardName).toBe("Charizard (corrected)");

    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("update");
    expect(audits[0].adminUser).toBe("tester@example.com");
    expect(audits[0].details.changes[0]).toMatchObject({ field: "cardName", previous: "Charizard" });
  });

  it("update fails (constraint violation) → NO audit row and NO row change", async () => {
    const id = await seededId();
    // grade_overall is NUMERIC; a non-numeric value aborts the UPDATE.
    await expect(
      storage.updateCertificateAudited(id, { gradeOverall: "not-a-number" } as any, {
        entityId: "MV1",
        action: "update",
        adminUser: "tester@example.com",
        details: { scope: "certificate_only" },
      }),
    ).rejects.toThrow();

    const audits = await readAudits();
    expect(audits).toHaveLength(0); // <- the H7 guarantee
    const cert = await readCert();
    expect(cert.cardName).toBe("Charizard");
    expect(cert.gradeOverall).toBeNull();
  });

  it("audit insert fails → the certificate update ROLLS BACK", async () => {
    const id = await seededId();
    // Force the audit INSERT to fail without touching the UPDATE: NOT NULL on action.
    await q("ALTER TABLE audit_log ALTER COLUMN action SET NOT NULL");
    await expect(
      storage.updateCertificateAudited(id, { cardName: "Should Not Persist" } as any, {
        entityId: "MV1",
        action: null as unknown as string, // violates NOT NULL
        adminUser: "tester@example.com",
        details: {},
      }),
    ).rejects.toThrow();

    const cert = await readCert();
    expect(cert.cardName).toBe("Charizard"); // <- rolled back, not "Should Not Persist"
    expect(await readAudits()).toHaveLength(0);
  });

  it("a missing certificate produces neither an update nor an audit row", async () => {
    await expect(
      storage.updateCertificateAudited(999999, { cardName: "Ghost" } as any, {
        entityId: "MV-NOPE",
        action: "update",
        adminUser: "tester@example.com",
        details: {},
      }),
    ).rejects.toThrow(/not found/);
    expect(await readAudits()).toHaveLength(0);
  });

  it("designations are persisted as a real JSONB array alongside their audit diff", async () => {
    const id = await seededId();
    await storage.updateCertificateAudited(id, { designations: ["FIRST_EDITION", "PROMO"] } as any, {
      entityId: "MV1",
      action: "update",
      adminUser: "tester@example.com",
      details: {
        scope: "certificate_only",
        changes: [{ field: "designations", previous: ["PROMO"], next: ["FIRST_EDITION", "PROMO"], source: "request" }],
      },
    });
    const cert = await readCert();
    expect(cert.designations).toEqual(["FIRST_EDITION", "PROMO"]);
    const audits = await readAudits();
    expect(audits[0].details.changes[0].previous).toEqual(["PROMO"]);
    expect(audits[0].details.changes[0].next).toEqual(["FIRST_EDITION", "PROMO"]);
  });

  it("concurrent audited updates both leave a truthful, complete trail", async () => {
    const id = await seededId();
    await Promise.all([
      storage.updateCertificateAudited(id, { year: "2000" } as any, {
        entityId: "MV1",
        action: "update",
        adminUser: "a@example.com",
        details: { changes: [{ field: "year", previous: "1999", next: "2000" }] },
      }),
      storage.updateCertificateAudited(id, { cardNumber: "5/102" } as any, {
        entityId: "MV1",
        action: "update",
        adminUser: "b@example.com",
        details: { changes: [{ field: "cardNumber", previous: "4/102", next: "5/102" }] },
      }),
    ]);
    // Two commits → exactly two audit rows. Neither is lost.
    expect(await readAudits()).toHaveLength(2);
  });
});
