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
  // Three columns the DEDICATED grading route writes by raw SQL that
  // shared/schema.ts does not declare, so the Drizzle-derived DDL above misses
  // them. They exist in the real database; without them the grading UPDATE would
  // fail here for a reason production does not have.
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "auth_status" text DEFAULT 'genuine'`);
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "auth_notes" text`);
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "private_notes" text`);
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

/** PUT the DEDICATED grading route with its real snake_case JSON contract. */
async function putGrade(id: number, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/admin/certificates/${id}/grade`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
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

  const { handleCertificateMetadataUpdate, handleCertificateGradeUpdate } = await import("../server/routes");
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

  // The DEDICATED grading route, mounted exactly as registerRoutes mounts it, so
  // the grading edits PR A migrates off the metadata route are proven against the
  // real handler rather than a stand-in.
  app.put("/api/admin/certificates/:id/grade", requireAdmin, handleCertificateGradeUpdate as any);

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
  // FINAL REVIEW / HIGH-1: this fixture carries a REAL grade and REAL subgrades.
  // It previously left them blank, which made every "nothing else changed" loop
  // self-fulfilling — the route was nulling `gradeOverall` on every partial PUT
  // and no assertion could see it, because there was nothing to lose.
  gradeType: "numeric",
  gradeOverall: "9.5",
  gradeCentering: "9",
  gradeCorners: "10",
  gradeEdges: "9.5",
  gradeSurface: "10",
  labelType: "Standard",
};

/** Every column a metadata-only edit must never touch. */
const GRADE_COLUMNS = [
  "gradeOverall",
  "gradeType",
  "labelType",
  "gradeCentering",
  "gradeCorners",
  "gradeEdges",
  "gradeSurface",
] as const;

/** A genuine Pristine certificate: 10 overall, every subgrade 10, black label. */
const PRISTINE = {
  ...STORED,
  gradeOverall: "10",
  gradeCentering: "10",
  gradeCorners: "10",
  gradeEdges: "10",
  gradeSurface: "10",
  labelType: "black",
};

async function reseed(row: Record<string, unknown>): Promise<number> {
  const { certificates, auditLog } = await import("../shared/schema");
  await (runtime.db as any).delete(auditLog);
  await (runtime.db as any).delete(certificates);
  await (runtime.db as any).insert(certificates).values({ ...row } as any);
  return await certId();
}

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

// ─────────────────────────────────────────────────────────────────────────────
// FINAL HOSTILE REVIEW / HIGH-1 — grade fields honour omission
//
// The route used to write `gradeOverall`, `gradeType` and `labelType` on EVERY
// request. A metadata-only PUT therefore nulled a stored grade and demoted a
// Pristine black label, and the audit falsely attributed both to the request.
// These cases drive the REAL handler over real PostgreSQL with a fixture that
// carries a REAL grade and REAL subgrades, so a regression cannot hide.
// ─────────────────────────────────────────────────────────────────────────────

describe("HIGH-1: a metadata-only edit preserves the grade", () => {
  const metadataOnlyEdits: Array<[string, Record<string, unknown>]> = [
    ["cardName-only", { cardName: "Charizard (typo fix)" }],
    ["year-only", { year: "2000" }],
    ["variant-only", { variant: "SHADOWLESS" }],
    ["language-only", { language: "English" }],
    ["notes-only", { notes: "Re-checked centering by hand" }],
    ["designations-only", { designations: ["PROMO"] }],
  ];

  for (const [name, body] of metadataOnlyEdits) {
    it(`${name}: every grade column is byte-for-byte unchanged`, async () => {
      const id = await certId();
      const before = await readCert();
      const { status } = await put(id, body);
      expect(status).toBe(200);

      const after = await readCert();
      for (const col of GRADE_COLUMNS) {
        expect(after[col], `${col} must survive a ${name} edit`).toEqual(before[col]);
      }
      // ...and the edit itself really did land, so this is not a no-op pass.
      const [[field, value]] = Object.entries(body);
      if (field !== "designations") expect(String(after[field])).toBe(String(value));
    });

    it(`${name}: no grade field appears in the audit`, async () => {
      const id = await certId();
      const { status } = await put(id, body);
      expect(status).toBe(200);

      const [audit] = await readAudits();
      const changed = (audit.details.changes as Array<{ field: string }>).map((c) => c.field);
      for (const col of GRADE_COLUMNS) {
        expect(changed, `${col} must not be reported as changed`).not.toContain(col);
      }
    });
  }

  it("a Pristine black-label certificate stays black — grade, subgrades and label all intact", async () => {
    const id = await reseed(PRISTINE);
    const { status } = await put(id, { cardName: "Charizard (typo fix)" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall).toBe("10.0");
    expect(after.labelType).toBe("black");
    expect(after.gradeType).toBe("numeric");
    for (const col of ["gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"] as const) {
      expect(after[col], `${col} must be untouched`).toBe("10.0");
    }
    expect(after.cardName).toBe("Charizard (typo fix)");

    const [audit] = await readAudits();
    expect((audit.details.changes as Array<{ field: string }>).map((c) => c.field)).toEqual(["cardName"]);
  });

  it("the audit exactly matches the committed row after a metadata-only edit", async () => {
    const id = await certId();
    const before = await readCert();
    const { status } = await put(id, { cardName: "Audit Truth", year: "2001" });
    expect(status).toBe(200);
    const after = await readCert();

    const [audit] = await readAudits();
    const changes = audit.details.changes as Array<{ field: string; previous: unknown; next: unknown }>;

    // Every audited change is real, and matches the committed row.
    for (const c of changes) {
      expect(c.previous, `${c.field}.previous`).toEqual(before[c.field]);
      expect(String(after[c.field]), `${c.field}.next`).toBe(String(c.next));
    }
    // Every column that actually changed is audited — nothing changed silently.
    // `updatedAt` is excluded: it is a mechanical row timestamp stamped by the
    // storage layer on every write, not an editable business field, so it is
    // deliberately absent from the field-level change list.
    const reallyChanged = Object.keys(after).filter(
      (k) => k !== "updatedAt" && JSON.stringify(after[k]) !== JSON.stringify(before[k]),
    );
    expect(reallyChanged.sort()).toEqual(changes.map((c) => c.field).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR A — the five legitimate grading edits, MIGRATED to the dedicated route
//
// These five cases previously asserted that a legitimate grade edit works
// THROUGH THE METADATA ROUTE. Under permanent full separation that path no
// longer exists, so each one is re-proven against
// PUT /api/admin/certificates/:id/grade using its real snake_case contract. The
// behavioural guarantee each case encodes is preserved — only the endpoint the
// guarantee is proven on has changed. Two cases document a REAL behavioural
// difference between the two routes; both are called out inline and in the
// report rather than papered over.
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A: legitimate grading edits work on the dedicated grade route", () => {
  it("1. an explicit overall-grade update succeeds and audits truthfully", async () => {
    const id = await certId();
    const { status } = await putGrade(id, { overall_grade: "8" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall).toBe("8.0");
    expect(after.gradeType).toBe("numeric");

    // The grading route audits under its own action with a payload-keyed diff.
    const audits = await readAudits();
    const save = audits.find((a: any) => a.action === "draft_save");
    expect(save, "a grading save must be audited").toBeTruthy();
    expect(save.details.changed.overall_grade.from).toBe("9.5");
    expect(save.details.changed.overall_grade.to).toBe("8");
    expect(save.details.was_approved).toBe(false);
    // ...and no metadata `update` event is fabricated for a grading write.
    expect(audits.map((a: any) => a.action)).not.toContain("update");
  });

  it("2. a legitimate full Grade-stage save persists grade AND sub-grades", async () => {
    const id = await certId();
    const { status } = await putGrade(id, {
      overall_grade: "9",
      grade_centering: "8.5",
      grade_corners: "9",
      grade_edges: "9.5",
      grade_surface: "9",
      centering_front_lr: "52/48",
      grade_explanation: "Re-measured by hand",
    });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall).toBe("9.0");
    expect(after.gradeCentering).toBe("8.5");
    expect(after.gradeCorners).toBe("9.0");
    expect(after.gradeEdges).toBe("9.5");
    expect(after.gradeSurface).toBe("9.0");
    expect(after.centeringFrontLr).toBe("52/48");
    // Metadata is NOT disturbed by a grading save.
    expect(after.cardName).toBe("Charizard");
    expect(after.variant).toBe("1ST EDITION");
    expect(after.notes).toBe("Grader notes that must survive");
  });

  it("3. grade clearing: only the documented path clears, an empty payload preserves", async () => {
    // BEHAVIOURAL DIFFERENCE, DELIBERATE. The metadata route treated an explicit
    // empty `gradeOverall` as a clear. The dedicated route does NOT: it uses
    // COALESCE preservation, precisely because an autosave arriving with an empty
    // grade had erased published grades before (MV205, PR #251). The operator's
    // real clear mechanism is the authentication-only conversion, proven in 4.
    // Both halves are asserted so neither can regress.
    const id = await certId();

    const empty = await putGrade(id, { overall_grade: "" });
    expect(empty.status).toBe(200);
    expect((await readCert()).gradeOverall, "an empty grade must NOT erase a stored grade").toBe("9.5");

    const omitted = await putGrade(id, { grade_explanation: "note only" });
    expect(omitted.status).toBe(200);
    expect((await readCert()).gradeOverall, "an omitted grade must NOT erase a stored grade").toBe("9.5");

    // The documented clear: convert to authentication-only.
    const cleared = await putGrade(id, { overall_grade: "NO" });
    expect(cleared.status).toBe(200);
    expect((await readCert()).gradeOverall).toBeNull();
  });

  it("4. numeric → non-numeric conversion clears every incompatible numeric field", async () => {
    const id = await certId();
    const { status } = await putGrade(id, { overall_grade: "AA", auth_status: "authentic_altered" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeType).toBe("AA");
    expect(after.gradeOverall).toBeNull();
    for (const col of ["gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"] as const) {
      expect(after[col], `${col} is incompatible with a non-numeric kind and must be cleared`).toBeNull();
    }

    const save = (await readAudits()).find((a: any) => a.action === "draft_save");
    expect(save.details.changed.overall_grade.to).toBe("AA");
  });

  it("4b. converting a PUBLISHED certificate's kind is refused and audited", async () => {
    const id = await reseed({ ...STORED, gradeApprovedAt: new Date(), gradeApprovedBy: "admin@example.test" } as any);
    const { status, json } = await putGrade(id, { overall_grade: "NO" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Super Admin Correction Mode/);

    const after = await readCert();
    expect(after.gradeType).toBe("numeric");
    expect(after.gradeOverall).toBe("9.5");
    expect((await readAudits()).map((a: any) => a.action)).toContain("grade_kind_change_rejected");
  });

  it("5. TRACKED FINDING — the grading route's audit is best-effort, NOT atomic", async () => {
    // The metadata route commits the row change and its audit row in ONE
    // transaction (proven above, unchanged). The dedicated grading route does
    // not: its audit INSERT sits in its own try/catch that deliberately logs and
    // continues ("Don't fail the save if audit insert fails"), so a grade change
    // can commit with NO audit row.
    //
    // This test CHARACTERISES that real behaviour rather than asserting a
    // guarantee the route does not provide. Making the grading write atomic means
    // changing the protected grading route's transaction behaviour, which needs
    // explicit owner approval and is NOT in this PR's scope. Reported as an open
    // risk. If someone later makes it atomic, this test fails loudly — which is
    // exactly the signal wanted.
    const id = await certId();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT audit_block2 CHECK (action <> 'draft_save')`);
    try {
      const { status } = await putGrade(id, { overall_grade: "7" });
      expect(status).toBe(200);
      expect((await readCert()).gradeOverall, "the grade change commits without its audit row").toBe("7.0");
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT audit_block2`);
    }
  });

  it("the metadata route's own audit atomicity is UNCHANGED by this PR", async () => {
    const id = await certId();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT audit_block3 CHECK (action <> 'update')`);
    try {
      const { status } = await put(id, { cardName: "Should Not Persist" });
      expect(status).toBe(500);
      expect((await readCert()).cardName).toBe("Charizard");
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT audit_block3`);
    }
  });

  it("an invalid grade is rejected by the metadata route and nothing is written", async () => {
    // Unchanged guarantee: value validation still runs before the ownership gate,
    // so a nonsense grade is a 400 and never reaches the database or the audit.
    const id = await certId();
    const { status } = await put(id, { gradeOverall: "11" });
    expect(status).toBe(400);
    expect((await readCert()).gradeOverall).toBe("9.5");
    expect(await readAudits()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR A — server-side field ownership (real route, real PostgreSQL)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A: the metadata route cannot alter grading state", () => {
  it("6. a stale/malicious client cannot change gradeOverall", async () => {
    const id = await certId();
    const before = await readCert();
    const { status, json } = await put(id, { gradeOverall: "3.0" });
    expect(status).toBe(409);
    expect(json.rejectedFields).toContain("gradeOverall");
    const after = await readCert();
    expect(after.gradeOverall).toBe(before.gradeOverall);
  });

  it("7. gradeType, labelType and subgrades are equally rejected", async () => {
    const id = await certId();
    const before = await readCert();
    for (const [field, value] of [["gradeType", "NO"], ["labelType", "black"], ["gradeCorners", "3.0"]] as const) {
      const { status, json } = await put(id, { [field]: value });
      expect(status, `${field} must be rejected`).toBe(409);
      expect(json.rejectedFields).toContain(field);
    }
    const after = await readCert();
    expect(after.gradeType).toBe(before.gradeType);
    expect(after.labelType).toBe(before.labelType);
    expect(after.gradeCorners).toBe(before.gradeCorners);
  });

  it("a harmless ECHO of an unchanged grading value is tolerated, not rejected", async () => {
    const id = await certId();
    const before = await readCert();
    const { status } = await put(id, { gradeOverall: String(before.gradeOverall), cardName: "Echo Tolerated" });
    expect(status).toBe(200);
    const after = await readCert();
    expect(after.cardName).toBe("Echo Tolerated");
    expect(after.gradeOverall).toBe(before.gradeOverall);
  });

  it("8/9. MV900007 REGRESSION — a concurrent grade change survives a metadata save", async () => {
    const id = await certId();
    // grader (or the workstation) writes a NEWER grade out-of-band
    await q(`UPDATE certificates SET grade = '10.0' WHERE certificate_number = 'MV1'`);
    // a STALE Card Details tab now saves metadata only
    const { status } = await put(id, { cardName: "Metadata Only Edit" });
    expect(status).toBe(200);
    const after = await readCert();
    expect(after.cardName).toBe("Metadata Only Edit");
    expect(after.gradeOverall).toBe("10.0");     // <- the newer grade SURVIVES
  });

  it("metadata-only save leaves every grading column untouched", async () => {
    const id = await certId();
    const before = await readCert();
    await put(id, { cardName: "Grading Untouched" });
    const after = await readCert();
    for (const k of ["gradeOverall","gradeType","labelType","gradeCentering","gradeCorners","gradeEdges","gradeSurface"] as const) {
      expect(after[k], `${k} must be unchanged`).toEqual(before[k]);
    }
  });

  it("14. a no-op metadata update creates no audit row", async () => {
    const id = await certId();
    const before = await readCert();
    const { status } = await put(id, { cardName: before.cardName });
    expect(status).toBe(200);

    // No audit row AT ALL — not an `update` row with an empty change list.
    expect(await readAudits()).toHaveLength(0);
    // Nothing else may be an audit row either (no rejection, no conflict event).
    const changeAudits = (await readAudits()).filter((a: any) => a.action === "update");
    expect(changeAudits.every((a: any) => (a.details?.changes ?? []).length > 0)).toBe(true);
  });

  it("14b. a no-op does not bump updated_at (intentional: the row did not change)", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET updated_at = NOW() - INTERVAL '1 day' WHERE certificate_number = 'MV1'`);
    const before = await readCert();
    const { status } = await put(id, { cardName: before.cardName, year: before.year });
    expect(status).toBe(200);
    expect((await readCert()).updatedAt).toEqual(before.updatedAt);
  });

  it("14c. a REAL change still writes exactly one audit row and does bump updated_at", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET updated_at = NOW() - INTERVAL '1 day' WHERE certificate_number = 'MV1'`);
    const before = await readCert();
    const { status } = await put(id, { cardName: "Genuinely Different" });
    expect(status).toBe(200);
    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("update");
    expect((audits[0].details.changes as any[]).map((c) => c.field)).toEqual(["cardName"]);
    expect(new Date((await readCert()).updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
  });

  it("14d. a tolerated grading echo alongside a no-op stays a no-op", async () => {
    const id = await certId();
    const before = await readCert();
    const { status } = await put(id, {
      cardName: before.cardName,
      gradeOverall: String(before.gradeOverall),
      grade_corners: String(before.gradeCorners),
    });
    expect(status).toBe(200);
    expect(await readAudits()).toHaveLength(0);
    expect((await readCert()).gradeOverall).toBe(before.gradeOverall);
  });

  it("16. a rejected grading write is audited with the certificate-number identity", async () => {
    const id = await certId();
    await put(id, { gradeOverall: "1.0" });
    const audits = await readAudits();
    const rejected = audits.filter((a: any) => a.action === "metadata_grading_field_rejected");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[rejected.length - 1].entityId).toBe("MV1");   // cert number, not numeric id
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR A — ALIAS COVERAGE through the real multipart route
//
// The metadata route builds its update object from the metadata allowlist, so an
// unrecognised key can never be written whatever it is called. The risk closed
// here is different: a caller submitting a grading value under an uncovered
// alias used to receive 200 and believe its grading write landed.
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A: every real grading alias is rejected, none can write", () => {
  /** [alias, a value that DIFFERS from the STORED fixture value] */
  const CHANGING_ALIASES: Array<[string, string]> = [
    ["gradeOverall", "3.0"],
    ["grade", "3.0"],
    ["grade_overall", "3.0"],
    ["overallGrade", "3.0"],
    ["overall_grade", "3.0"],
    ["gradeType", "NO"],
    ["grade_type", "AA"],
    ["labelType", "black"],
    ["label_type", "black"],
    ["gradeCentering", "1.0"],
    ["grade_centering", "1.0"],
    ["centeringScore", "1.0"],
    ["centering_score", "1.0"],
    ["gradeCorners", "1.0"],
    ["grade_corners", "1.0"],
    ["cornersScore", "1.0"],
    ["corners_score", "1.0"],
    ["gradeEdges", "1.0"],
    ["grade_edges", "1.0"],
    ["edgesScore", "1.0"],
    ["edges_score", "1.0"],
    ["gradeSurface", "1.0"],
    ["grade_surface", "1.0"],
    ["surfaceScore", "1.0"],
    ["surface_score", "1.0"],
    ["auth_status", "authentic_altered"],
    ["centeringFrontLr", "60/40"],
    ["centering_front_lr", "60/40"],
    ["centering_method", "manual"],
    ["eye_appeal_modifier", "2"],
    ["dark_border", "true"],
    ["dark_border_front", "true"],
    ["whitening_lines", "3"],
    ["crease_span_pct", "40"],
    ["wrinkle_severity", "small_front"],
    ["tear_severity", "major"],
    ["grade_strength_score", "100"],
    ["grade_explanation", "smuggled"],
    ["ai_draft_grade", "10"],
    ["grade_approved_at", "2026-01-01T00:00:00.000Z"],
    ["grade_approved_by", "attacker@example.test"],
    ["graded_by", "attacker@example.test"],
    ["grader_status", "approved"],
    ["operator_grade", "10"],
  ];

  for (const [alias, value] of CHANGING_ALIASES) {
    it(`alias "${alias}" is rejected with 409 and writes nothing`, async () => {
      const id = await certId();
      const before = await readCert();
      const { status, json } = await put(id, { [alias]: value });
      expect(status, `${alias} must be rejected`).toBe(409);
      expect(json.rejectedFields).toContain(alias);

      const after = await readCert();
      for (const col of GRADE_COLUMNS) {
        expect(after[col], `${col} must be untouched by a rejected ${alias}`).toEqual(before[col]);
      }
      expect(after.updatedAt).toEqual(before.updatedAt); // no write at all
      // no successful metadata audit for a rejected request
      const audits = await readAudits();
      expect(audits.map((a: any) => a.action)).not.toContain("update");
      expect(audits.map((a: any) => a.action)).toContain("metadata_grading_field_rejected");
    });
  }

  it("an alias smuggled ALONGSIDE a legitimate metadata edit rejects the whole request", async () => {
    const id = await certId();
    const before = await readCert();
    const { status } = await put(id, { cardName: "Should Not Land", corners_score: "1.0" });
    expect(status).toBe(409);
    const after = await readCert();
    expect(after.cardName, "the metadata half must not sneak through").toBe(before.cardName);
    expect(after.gradeCorners).toEqual(before.gradeCorners);
  });

  it("every rejected alias is named in the error message", async () => {
    const id = await certId();
    const { json } = await put(id, { overall_grade: "3.0", corners_score: "1.0" });
    expect(json.rejectedFields.sort()).toEqual(["corners_score", "overall_grade"]);
    expect(json.error).toContain("corners_score");
    expect(json.error).toContain("overall_grade");
    expect(json.error).toMatch(/\/grade/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR A — LIFECYCLE SAFETY through the real routes and real PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

/** A sparse, image-less, never-graded record — the shape that got a phantom 10. */
const SPARSE = {
  certId: "MV1",
  cardGame: "pokemon",
  cardName: "Unknown Card",
  setName: "Unknown Set",
  cardNumber: "1/1",
  year: "2024",
  status: "draft",
  gradeType: "numeric",
  gradeOverall: null,
  gradeCentering: null,
  gradeCorners: null,
  gradeEdges: null,
  gradeSurface: null,
  labelType: "Standard",
};

/** An Authentic-Only record: non-numeric kind, no numeric grade at all. */
const AUTHENTIC_ONLY = {
  ...SPARSE,
  cardName: "Authenticated Only",
  gradeType: "NO",
};

describe("PR A: lifecycle safety — opening or saving metadata never grades a card", () => {
  it("null grading data stays null across a metadata edit", async () => {
    const id = await reseed(SPARSE);
    const { status } = await put(id, { cardName: "Now Identified" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.cardName).toBe("Now Identified");
    for (const col of ["gradeOverall", "gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"] as const) {
      expect(after[col], `${col} must stay null`).toBeNull();
    }
  });

  it("a sparse, image-less record remains UNGRADED — zero-valued defaults are not perfect evidence", async () => {
    const id = await reseed(SPARSE);
    // Everything Card Details can legitimately send, in one full-state save.
    const { status } = await put(id, {
      cardGame: "pokemon",
      setName: "Base Set",
      cardName: "Charizard",
      cardNumber: "4/102",
      year: "1999",
      language: "English",
      notes: "identified from the scan",
      designations: [],
    });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall, "an identity edit must never manufacture a grade").toBeNull();
    expect(after.labelType, "and must never manufacture a black label").toBe("Standard");
    for (const col of ["gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"] as const) {
      expect(after[col]).toBeNull();
    }
  });

  it("an Authentic-Only certificate stays non-numeric across a metadata edit", async () => {
    const id = await reseed(AUTHENTIC_ONLY);
    const { status } = await put(id, { cardName: "Renamed", notes: "checked" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeType).toBe("NO");
    expect(after.gradeOverall).toBeNull();
    expect(after.labelType).toBe("Standard");
  });

  it("an Authentic-Only certificate cannot be converted to numeric by the metadata route", async () => {
    const id = await reseed(AUTHENTIC_ONLY);
    for (const body of [{ gradeType: "numeric" }, { grade_type: "numeric" }, { overall_grade: "10" }]) {
      const { status } = await put(id, body);
      expect(status, `${JSON.stringify(body)} must be rejected`).toBe(409);
    }
    const after = await readCert();
    expect(after.gradeType).toBe("NO");
    expect(after.gradeOverall).toBeNull();
  });

  it("repeated metadata saves (the auto-save debounce firing) never accumulate grading changes", async () => {
    const id = await reseed(SPARSE);
    for (let i = 0; i < 5; i++) {
      const { status } = await put(id, { notes: `pass ${i}` });
      expect(status).toBe(200);
    }
    const after = await readCert();
    expect(after.notes).toBe("pass 4");
    expect(after.gradeOverall).toBeNull();
    const audits = await readAudits();
    expect(audits.every((a: any) => a.action === "update")).toBe(true);
    for (const a of audits) {
      const fields = (a.details.changes as Array<{ field: string }>).map((c) => c.field);
      for (const col of GRADE_COLUMNS) expect(fields).not.toContain(col);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR A — CONCURRENCY PROOF (Task 7), both directions
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A: a stale metadata form cannot revert a concurrent grading change", () => {
  it("grade 9 → grading route sets 10 → stale metadata save → grade is still 10", async () => {
    // 1. the metadata form loads while the grade is 9
    const id = await reseed({ ...STORED, gradeOverall: "9.0" });
    const loaded = await readCert();
    expect(loaded.gradeOverall).toBe("9.0");
    const staleSnapshot = snapshotOf({ ...STORED, gradeOverall: "9.0" });

    // 2. the DEDICATED grading route raises it to 10
    const graded = await putGrade(id, { overall_grade: "10" });
    expect(graded.status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");

    // 3. the STALE metadata form now saves a metadata field, still believing 9.0
    const saved = await put(id, {
      loadedSnapshot: staleSnapshot,
      cardName: "Charizard (typo fix)",
      // a stale client of the previous generation would also echo its grade:
      gradeOverall: "9.0",
    });

    // 3b. that echo is a CHANGE against the new stored value, so it is refused
    expect(saved.status).toBe(409);
    expect(saved.json.rejectedFields).toContain("gradeOverall");
    expect((await readCert()).gradeOverall, "the grader's 10 survives").toBe("10.0");

    // 4. the CURRENT client sends no grading state at all, and succeeds
    const clean = await put(id, { loadedSnapshot: staleSnapshot, cardName: "Charizard (typo fix)" });
    expect(clean.status).toBe(200);

    // 5-6. final grade is still 10 and grading state is intact
    const after = await readCert();
    expect(after.cardName).toBe("Charizard (typo fix)");
    expect(after.gradeOverall).toBe("10.0");
    expect(after.gradeType).toBe("numeric");
    for (const col of ["gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"] as const) {
      expect(after[col], `${col} intact`).toBe(String(Number((STORED as any)[col]).toFixed(1)));
    }

    // 7. the audit contains ONLY the intended metadata update (plus the honest
    //    record of the refused stale write) — no grade change is attributed to it
    const audits = await readAudits();
    const updates = audits.filter((a: any) => a.action === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0].details.changes as Array<{ field: string }>).map((c) => c.field)).toEqual(["cardName"]);
    expect(audits.map((a: any) => a.action)).toContain("metadata_grading_field_rejected");
  });

  it("the reverse: a grading update does not overwrite unrelated metadata", async () => {
    const id = await certId();
    const before = await readCert();

    // a metadata edit lands first
    expect((await put(id, { cardName: "Metadata First", notes: "hand-checked" })).status).toBe(200);

    // then the grading route writes a grade, carrying no metadata
    const graded = await putGrade(id, { overall_grade: "10", grade_corners: "10" });
    expect(graded.status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall).toBe("10.0");
    expect(after.gradeCorners).toBe("10.0");
    // every metadata column is exactly what the metadata edit left
    expect(after.cardName).toBe("Metadata First");
    expect(after.notes).toBe("hand-checked");
    expect(after.setName).toBe(before.setName);
    expect(after.variant).toBe(before.variant);
    expect(after.collectionCode).toBe(before.collectionCode);
    expect(after.language).toBe(before.language);
    expect(after.designations).toEqual(before.designations);
    expect(after.finishVariant).toBe(before.finishVariant);
    expect(after.promoType).toBe(before.promoType);
    expect(after.rarityCode).toBe(before.rarityCode);
  });
});
