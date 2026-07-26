/**
 * certificate-update-route.test.ts — ROUTE-LEVEL proof for hostile-review H-1.
 *
 * Mounts the REAL production handler (`handleCertificateMetadataUpdate`, the exact
 * function `registerRoutes` mounts) behind the REAL `requireAdmin` middleware and
 * the REAL multer chain, over a disposable PostgreSQL 17 cluster, and drives it
 * over real HTTP. Pure resolver tests are NOT sufficient for this finding: the
 * defect was that the route rebuilt the update object unconditionally AFTER the
 * resolver had correctly marked fields as omitted.
 *
 * What this proves:
 *   • a request carrying ONE editable field changes ONLY that field;
 *   • omitted variant / rarity / collectionCode / language / finish / promo /
 *     designations are left exactly as stored — never cleared, never defaulted;
 *   • explicit null / "" / [] still clear where that is the documented
 *     representation;
 *   • a safe concurrent merge preserves the current database value;
 *   • the audit payload matches the COMMITTED row, field for field;
 *   • an audit failure rolls the whole update back;
 *   • a blocked conflict writes no successful-update audit and no row change.
 *
 * No staging or production database is touched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const runtime = vi.hoisted(() => ({ db: null as unknown, pool: null as unknown }));

vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("Route test database was used before setup");
    return runtime.db;
  },
  get pool() {
    if (!runtime.pool) throw new Error("Route test pool was used before setup");
    return runtime.pool;
  },
}));

// R2 is never exercised — this suite posts no images.
vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (k: string) => k),
  deleteFromR2: vi.fn(async () => {}),
  getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed"),
}));

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let server: Server;
let base: string;
let cookie = "";

/** Build the two tables from the REAL drizzle schema so `.returning()` resolves
 *  every declared column and the test cannot drift from production. */
async function createSchema(p: pg.Pool): Promise<void> {
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { certificates, auditLog } = await import("../shared/schema");
  const ddlFor = (table: any): string => {
    const cfg = getTableConfig(table);
    const cols = cfg.columns.map((c: any) => {
      let type: string = c.getSQLType();
      if (/^vector/i.test(type)) type = "text"; // pgvector not installed; irrelevant here
      if (c.primary && /serial|integer/i.test(type)) type = "SERIAL";
      return [`"${c.name}"`, type, c.primary ? "PRIMARY KEY" : ""].filter(Boolean).join(" ");
    });
    return `CREATE TABLE "${cfg.name}" (${cols.join(", ")});`;
  };
  const { users } = await import("../shared/schema");
  await p.query(ddlFor(certificates));
  await p.query(ddlFor(auditLog));
  await p.query(ddlFor(users));
  // requireAdmin re-validates the admin against the users table on EVERY request
  // (credential-version check). Seeding it keeps the REAL authorization in the
  // loop rather than stubbing it out.
  await p.query(
    `INSERT INTO users (id, email, role, credential_version) VALUES ('admin-1', 'mintvaultuk@gmail.com', 'admin', 1)`,
  );
  await p.query(`ALTER TABLE "audit_log" ALTER COLUMN "details" SET DEFAULT '{}'::jsonb`);
  await p.query(`ALTER TABLE "certificates" ALTER COLUMN "language" SET DEFAULT 'English'`);
}

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

async function readCert() {
  const { certificates } = await import("../shared/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await (runtime.db as any).select().from(certificates).where(eq(certificates.certId, "MV1"));
  return row;
}
async function readAudits() {
  const { auditLog } = await import("../shared/schema");
  return await (runtime.db as any).select().from(auditLog);
}
async function certId(): Promise<number> {
  return (await readCert()).id as number;
}

/** PUT the update route as multipart-free urlencoded form data (multer's
 *  `.fields()` accepts urlencoded bodies for text-only posts, exactly as the
 *  browser auto-save does when no image is attached). */
async function put(id: number, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`${base}/api/admin/certificates/${id}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** The snapshot the browser sends so the three-way resolver engages. */
const snapshotOf = (o: Record<string, unknown>) => JSON.stringify(o);

beforeAll(async () => {
  cluster = await startPostgres17("certificate-update-route");
  pool = new pg.Pool({ connectionString: cluster.url, max: 6 });
  runtime.pool = pool;
  runtime.db = drizzle(pool);
  await createSchema(pool);

  const { handleCertificateMetadataUpdate } = await import("../server/routes");
  const { requireAdmin } = await import("../server/auth");
  const multer = (await import("multer")).default;
  const upload = multer({ storage: multer.memoryStorage() });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      name: "mv.sid",
      secret: "certificate-update-route-test-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false },
    }),
  );
  app.post("/__test/admin-session", (req, res) => {
    Object.assign(req.session, {
      isAdmin: true,
      adminEmail: "admin@example.test",
      credentialVersion: 1,
      authenticatedAt: Date.now(),
    });
    req.session.save((e) => (e ? res.status(500).json({ error: e.message }) : res.json({ ok: true })));
  });

  // The REAL production chain: requireAdmin -> multer -> the real handler.
  app.put(
    "/api/admin/certificates/:id",
    requireAdmin,
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    handleCertificateMetadataUpdate as any,
  );

  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/__test/admin-session`, { method: "POST" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("mv.sid");
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server?.close(() => r(null)));
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

/** A fully-populated certificate, so any accidental clear is visible. */
const STORED = {
  certId: "MV1",
  cardGame: "pokemon",
  cardName: "Charizard",
  setName: "Base Set",
  cardNumber: "4/102",
  year: "1999",
  language: "Japanese",
  variant: "1ST EDITION",
  rarity: "",
  collectionCode: "WOTC",
  collectionOther: null,
  finishVariant: "holo",
  promoType: "black_star",
  subsetName: "trainer_gallery",
  rarityCode: "rare",
  designations: ["PROMO", "FIRST_EDITION"],
  notes: "Grader notes that must survive",
  status: "graded",
  // Derived columns the route always recomputes. Seeding them with the values
  // the pipeline produces keeps a metadata-only edit genuinely metadata-only —
  // otherwise the audit truthfully (but distractingly) reports them changing
  // from blank on the first save.
  labelType: "Standard",
  gradeType: "numeric",
};

beforeEach(async () => {
  const { certificates, auditLog } = await import("../shared/schema");
  await (runtime.db as any).delete(auditLog);
  await (runtime.db as any).delete(certificates);
  await (runtime.db as any).insert(certificates).values({ ...STORED } as any);
});

// ─────────────────────────────────────────────────────────────────────────────
// H-1 — omitted fields are untouched
// ─────────────────────────────────────────────────────────────────────────────

describe("H-1: a partial PUT changes ONLY the fields it submits", () => {
  it("a request carrying one editable field changes only that field", async () => {
    const id = await certId();
    const { status } = await put(id, { cardName: "Charizard (corrected)" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.cardName).toBe("Charizard (corrected)");
    // Everything else is byte-for-byte what it was.
    for (const k of [
      "setName", "cardNumber", "year", "language", "variant", "rarity",
      "collectionCode", "finishVariant", "promoType", "subsetName", "rarityCode", "notes",
    ] as const) {
      expect(after[k], `${k} must be untouched`).toEqual((STORED as any)[k]);
    }
    expect(after.designations).toEqual(STORED.designations);
  });

  it("omitted Variant remains unchanged (was: cleared to null)", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).variant).toBe("1ST EDITION");
  });

  it("omitted collectionCode remains unchanged (was: cleared to null)", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).collectionCode).toBe("WOTC");
  });

  it('omitted language remains unchanged (was: defaulted to "English")', async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).language).toBe("Japanese");
  });

  it("omitted Finish remains unchanged", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).finishVariant).toBe("holo");
  });

  it("omitted Promo remains unchanged", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).promoType).toBe("black_star");
  });

  it("omitted designations remain unchanged", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).designations).toEqual(["PROMO", "FIRST_EDITION"]);
  });

  it("omitted notes remain unchanged (same defect class)", async () => {
    const id = await certId();
    await put(id, { cardName: "X" });
    expect((await readCert()).notes).toBe("Grader notes that must survive");
  });

  it("a submitted-but-blank REQUIRED field is still rejected", async () => {
    const id = await certId();
    const { status, json } = await put(id, { cardName: "   " });
    expect(status).toBe(400);
    expect(json.error).toMatch(/cardName is required/i);
    expect((await readCert()).cardName).toBe("Charizard");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit clears still work
// ─────────────────────────────────────────────────────────────────────────────

describe("explicit clear representations still apply", () => {
  it("an explicit empty string clears a scalar", async () => {
    const id = await certId();
    const { status } = await put(id, { variant: "" });
    expect(status).toBe(200);
    expect((await readCert()).variant).toBeNull();
  });

  it("an explicit empty array clears designations", async () => {
    const id = await certId();
    const { status } = await put(id, { designations: [] });
    expect(status).toBe(200);
    expect((await readCert()).designations).toEqual([]);
  });

  it("clearing one field does not disturb its neighbours", async () => {
    const id = await certId();
    await put(id, { variant: "" });
    const after = await readCert();
    expect(after.variant).toBeNull();
    expect(after.collectionCode).toBe("WOTC");
    expect(after.language).toBe("Japanese");
    expect(after.designations).toEqual(["PROMO", "FIRST_EDITION"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency through the real route
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict handling through the real route", () => {
  it("a safe concurrent merge preserves the CURRENT database value", async () => {
    const id = await certId();
    const loaded = { ...STORED, setName: "Base Set" };
    // Another writer corrects the set while this tab is open.
    await q(`UPDATE certificates SET set_name = 'Base Set (Shadowless)' WHERE certificate_number = 'MV1'`);

    const { status } = await put(id, {
      loadedSnapshot: snapshotOf(loaded),
      cardName: "Charizard v2",
      setName: "Base Set", // stale echo — the editor never edited it
    });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.cardName).toBe("Charizard v2");
    expect(after.setName).toBe("Base Set (Shadowless)"); // DB value won, not clobbered
  });

  it("a genuine same-field conflict is blocked: no row change, no success audit", async () => {
    const id = await certId();
    const loaded = { ...STORED, variant: "1ST EDITION" };
    await q(`UPDATE certificates SET variant = 'SHADOWLESS' WHERE certificate_number = 'MV1'`);

    const { status, json } = await put(id, {
      loadedSnapshot: snapshotOf(loaded),
      variant: "UNLIMITED", // editor's own different edit
    });
    expect(status).toBe(409);
    expect(json.conflicts).toContain("variant");

    expect((await readCert()).variant).toBe("SHADOWLESS"); // untouched
    const audits = await readAudits();
    expect(audits.map((a: any) => a.action)).toEqual(["update_conflict_blocked"]);
    expect(audits.map((a: any) => a.action)).not.toContain("update");
  });

  it("M-1: a CONVERGED governing-field change does not block the variant edit", async () => {
    const id = await certId();
    const loaded = { ...STORED, setName: "Base Set", rarityCode: "rare" };
    // Another writer independently sets the SAME new set the editor is setting.
    await q(`UPDATE certificates SET set_name = 'Jungle' WHERE certificate_number = 'MV1'`);

    const { status } = await put(id, {
      loadedSnapshot: snapshotOf(loaded),
      setName: "Jungle", // same value → convergence, not disagreement
      rarityCode: "ultra_rare",
    });
    expect(status).toBe(200);
    const after = await readCert();
    expect(after.setName).toBe("Jungle");
    expect(after.rarityCode).toBe("ultra_rare");
  });

  it("M-1: a DIVERGENT governing-field change still blocks the variant edit", async () => {
    const id = await certId();
    const loaded = { ...STORED, setName: "Base Set", rarityCode: "rare" };
    await q(`UPDATE certificates SET set_name = 'Fossil' WHERE certificate_number = 'MV1'`);

    const { status, json } = await put(id, {
      loadedSnapshot: snapshotOf(loaded),
      setName: "Jungle", // disagrees with the DB's "Fossil"
      rarityCode: "ultra_rare",
    });
    expect(status).toBe(409);
    expect(JSON.stringify(json)).toMatch(/setName/);
    expect((await readCert()).setName).toBe("Fossil");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit truthfulness against the committed row
// ─────────────────────────────────────────────────────────────────────────────

describe("the audit matches the COMMITTED row exactly", () => {
  it("records only the fields that actually changed, with real previous values", async () => {
    const id = await certId();
    await put(id, { cardName: "Charizard (corrected)", year: "1999" /* unchanged */ });

    const [audit] = await readAudits();
    expect(audit.action).toBe("update");
    const changed = (audit.details.changes as any[]).map((c) => c.field);
    expect(changed).toEqual(["cardName"]); // year submitted but unchanged → not a change
    const change = (audit.details.changes as any[])[0];
    expect(change.previous).toBe("Charizard");
    expect(change.next).toBe("Charizard (corrected)");
    expect(audit.details.scope).toBe("certificate_only");
  });

  it("EVERY audited change matches the committed row, and nothing changed silently", async () => {
    const id = await certId();
    const before = await readCert();
    await put(id, { cardName: "New Name", variant: "", designations: ["STAFF"] });
    const after = await readCert();
    const [audit] = await readAudits();
    const changes = audit.details.changes as Array<{ field: string; previous: any; next: any }>;

    // 1. every audited change is real, and `next` equals the committed value
    for (const c of changes) {
      const committed = (after as any)[c.field];
      const normalised = Array.isArray(committed) ? [...committed].sort() : (committed ?? "");
      const expected = Array.isArray(c.next) ? [...c.next].sort() : c.next;
      expect(normalised, `audit next for ${c.field}`).toEqual(expected);
    }
    // 2. every field that actually changed is audited — nothing silent
    const auditedFields = new Set(changes.map((c) => c.field));
    for (const k of Object.keys(before)) {
      const a = (before as any)[k];
      const b = (after as any)[k];
      const same = JSON.stringify(a) === JSON.stringify(b);
      if (!same && k !== "updatedAt") {
        expect(auditedFields.has(k), `${k} changed but is NOT in the audit`).toBe(true);
      }
    }
  });

  it("does NOT claim a change for an omitted field", async () => {
    const id = await certId();
    await put(id, { cardName: "Only This" });
    const [audit] = await readAudits();
    const fields = (audit.details.changes as any[]).map((c) => c.field);
    for (const k of ["variant", "language", "collectionCode", "designations", "notes"]) {
      expect(fields).not.toContain(k);
    }
  });

  it("records a safe merge with `merged` provenance, not as the editor's own edit", async () => {
    const id = await certId();
    const loaded = { ...STORED };
    await q(`UPDATE certificates SET set_name = 'Corrected Set' WHERE certificate_number = 'MV1'`);
    await put(id, {
      loadedSnapshot: snapshotOf(loaded),
      cardName: "Edited",
      setName: "Base Set", // stale echo
    });
    const [audit] = await readAudits();
    expect(audit.details.mergedFromConcurrentEdit).toContain("setName");
    // The merge preserved the DB value, so setName did not CHANGE — it must not
    // be reported as a change.
    expect((audit.details.changes as any[]).map((c) => c.field)).toEqual(["cardName"]);
  });

  it("a concurrently DELETED certificate returns 404, not a 500", async () => {
    const id = await certId();
    await q(`DELETE FROM certificates WHERE certificate_number = 'MV1'`);
    const { status, json } = await put(id, { cardName: "Ghost" });
    expect(status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(await readAudits()).toHaveLength(0);
  });
});

describe("audit failure rolls the whole update back", () => {
  it("a failing audit insert leaves the certificate untouched", async () => {
    const id = await certId();
    // Force the audit INSERT to fail inside the transaction.
    await q(`ALTER TABLE audit_log ADD CONSTRAINT audit_block CHECK (action <> 'update')`);
    try {
      const { status } = await put(id, { cardName: "Should Not Persist" });
      expect(status).toBe(500);
      expect((await readCert()).cardName).toBe("Charizard"); // rolled back
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT audit_block`);
    }
  });
});
