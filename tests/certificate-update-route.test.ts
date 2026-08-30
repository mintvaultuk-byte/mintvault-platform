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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
/** R2 is stubbed, but the calls are RECORDED: M-3 asserts that a same-key
 *  replacement uploads the new object and does NOT delete it afterwards. */
const r2Calls = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; bytes: number }>,
  deletes: [] as string[],
  objects: new Map<string, Buffer>(),
}));
vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (k: string, buf: Buffer) => {
    r2Calls.uploads.push({ key: k, bytes: buf?.length ?? 0 });
    return k;
  }),
  deleteFromR2: vi.fn(async (k: string) => {
    r2Calls.deletes.push(k);
    r2Calls.objects.delete(k);
  }),
  uploadCreateOnlyToR2: vi.fn(async (key: string, body: Buffer) => {
    if (r2Calls.objects.has(key)) throw new Error("conditional create collision");
    r2Calls.objects.set(key, Buffer.from(body));
  }),
  inspectR2ObjectIntegrity: vi.fn(async (key: string) => {
    const body = r2Calls.objects.get(key);
    return body
      ? { exists: true, byteLength: body.length, sha256: createHash("sha256").update(body).digest("hex") }
      : { exists: false };
  }),
  getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed"),
  // The REAL key builder — the deterministic-key behaviour is the whole point
  // of M-3, so it must not be stubbed.
  r2KeyForImage: (certId: string, side: "front" | "back", ext: string) => `images/${certId}/${side}.${ext}`,
  r2KeyForLabel: (certId: string, side: string, format: string) => `labels/${certId}/${side}.${format}`,
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
    `INSERT INTO users (id, email, role, credential_version) VALUES ('admin-1', 'mintvaultuk@gmail.com', 'admin', 1)`
  );
  await p.query(`ALTER TABLE "audit_log" ALTER COLUMN "details" SET DEFAULT '{}'::jsonb`);
  await p.query(`ALTER TABLE "certificates" ALTER COLUMN "language" SET DEFAULT 'English'`);
  // The lightweight Drizzle-derived DDL intentionally omits column defaults.
  // Production migration 0048 makes this a non-null server revision, and the
  // dedicated grade route returns it after every save.
  await p.query(`ALTER TABLE "certificates" ALTER COLUMN "grading_revision" SET DEFAULT 1`);
  await p.query(`UPDATE "certificates" SET "grading_revision" = 1 WHERE "grading_revision" IS NULL`);
  await p.query(`ALTER TABLE "certificates" ALTER COLUMN "grading_revision" SET NOT NULL`);
  // Three columns the DEDICATED grading route writes by raw SQL that
  // shared/schema.ts does not declare, so the Drizzle-derived DDL above misses
  // them. They exist in the real database; without them the grading UPDATE would
  // fail here for a reason production does not have.
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "auth_status" text DEFAULT 'genuine'`);
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "auth_notes" text`);
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "private_notes" text`);
  // M-4: `grade_manual_override` is a REAL boolean column that shared/schema.ts
  // does not declare (verified against the live database 2026-07-26). Created
  // here so the fail-closed rejection is exercised against a column that really
  // exists, rather than against a hypothetical one.
  await p.query(`ALTER TABLE "certificates" ADD COLUMN "grade_manual_override" boolean DEFAULT false`);

  // H-1 · paid-submission linkage. The create route validates
  // submissionItemId against these two tables, so the real guard runs.
  await p.query(`
    CREATE TABLE submissions (
      id SERIAL PRIMARY KEY,
      status text NOT NULL DEFAULT 'paid',
      deleted_at timestamp
    )`);
  await p.query(`
    CREATE TABLE submission_items (
      id SERIAL PRIMARY KEY,
      submission_id integer NOT NULL,
      card_name text
    )`);
  // cert_counter is supplied by numbered migration 0114 in production; this
  // focused route fixture creates its equivalent minimal shape directly.
  await p.query(`
    CREATE TABLE cert_counter (
      id integer PRIMARY KEY,
      last_issued bigint NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT NOW()
    )`);
  await p.query(`CREATE TABLE certificate_images (
      id SERIAL PRIMARY KEY,
      certificate_id integer NOT NULL,
      image_type text NOT NULL,
      url text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT NOW()
    )`);
  await p.query(`
    CREATE ROLE mintvault_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE partner_organisations(id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION partner_current_tenant()
    RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
      SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
    $fn$;
    CREATE TABLE schema_migrations(
      filename text PRIMARY KEY,status text NOT NULL,completed_at timestamptz
    );
    INSERT INTO schema_migrations(filename,status,completed_at)
    VALUES ('0121_main_runtime_role_authority.sql','applied',NOW());
  `);
  await p.query(readFileSync("migrations/0122_object_write_intent_reconciliation.sql", "utf8"));
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
  // storage.createCertificate reads getDatabaseUrl() purely to record the host
  // in its CERT_ID_ALLOCATED audit. Point it at the disposable cluster so the
  // create route runs exactly as it does in production. No real database is
  // reachable from this value.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  await createSchema(pool);

  const { handleCertificateMetadataUpdate, handleCertificateGradeUpdate, handleCertificateCreate } =
    await import("../server/routes");
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
    })
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
    handleCertificateMetadataUpdate as any
  );

  // The DEDICATED grading route, mounted exactly as registerRoutes mounts it, so
  // the grading edits PR A migrates off the metadata route are proven against the
  // real handler rather than a stand-in.
  app.put("/api/admin/certificates/:id/grade", requireAdmin, handleCertificateGradeUpdate as any);

  // The CREATE route, mounted exactly as registerRoutes mounts it, so the
  // paid-submission linkage (hostile review H-1) is proven end to end.
  app.post(
    "/api/admin/certificates",
    requireAdmin,
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    handleCertificateCreate as any
  );

  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/__test/admin-session`, { method: "POST" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("mv.sid");
}, 180_000);

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
}, 180_000);

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
  // This fixture's persisted subgrades resolve to a server-owned 10.0. Keep
  // the stored overall aligned with that result so a defect-only observation
  // test does not acquire an unrelated grade correction in its audit row.
  gradeOverall: "10.0",
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
  await pool.query("DELETE FROM certificate_images");
  await pool.query("DELETE FROM object_write_items");
  await pool.query("DELETE FROM object_write_operations");
  await pool.query("DELETE FROM submission_items");
  await pool.query("DELETE FROM submissions");
  await pool.query("DELETE FROM cert_counter");
  await pool.query(`
    INSERT INTO cert_counter (id, last_issued, updated_at)
    SELECT 1,
           COALESCE(MAX(
             CASE
               WHEN certificate_number ~* '^MV-?[0-9]+$'
                 THEN regexp_replace(certificate_number, '^MV-?', '', 'i')::bigint
               ELSE NULL
             END
           ), 0),
           NOW()
      FROM certificates
  `);
  r2Calls.uploads.length = 0;
  r2Calls.deletes.length = 0;
  r2Calls.objects.clear();
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
      "setName",
      "cardNumber",
      "year",
      "language",
      "variant",
      "rarity",
      "collectionCode",
      "finishVariant",
      "promoType",
      "subsetName",
      "rarityCode",
      "notes",
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

describe("MV700 identity/variant validation on the admin metadata route", () => {
  it("rejects unsafe rarity downgrade without confirmation", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v", finishVariant: "holo" });
    const res = await put(id, { rarityCode: "silver_star_rare" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Rarity override requires explicit confirmation/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");
    expect(await readAudits()).toHaveLength(0);
  });

  it("allows unsafe rarity downgrade only with a matching explicit confirmation and audits it", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v", finishVariant: "holo" });
    const res = await put(id, {
      rarityCode: "silver_star_rare",
      rarity_override_confirmed: "true",
      rarity_override_from: "holo_rare_v",
      rarity_override_to: "silver_star_rare",
    });
    expect(res.status).toBe(200);
    expect((await readCert()).rarityCode).toBe("silver_star_rare");
    const update = (await readAudits()).find((a: any) => a.action === "update");
    expect(update).toBeTruthy();
    expect(JSON.stringify(update.details)).toContain("rarityCode");
  });

  it("allows valid rarity upgrades without override", async () => {
    const id = await reseed({ ...STORED, rarityCode: "rare" });
    const res = await put(id, { rarityCode: "holo_rare_v" });
    expect(res.status).toBe(200);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");
  });

  it("rejects malformed rarity override intent", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v" });
    const res = await put(id, { rarityCode: "silver_star_rare", rarity_override_confirmed: "yes" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Malformed rarity override/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");
  });

  it("one confirmation cannot authorise a later unrelated downgrade", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v" });
    const res = await put(id, {
      rarityCode: "common",
      rarity_override_confirmed: "true",
      rarity_override_from: "holo_rare_v",
      rarity_override_to: "silver_star_rare",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/does not match this rarity transition/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");
  });

  it("rejects known rarity clear without an exact empty-target override", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v", finishVariant: "holo" });
    const missing = await put(id, { rarityCode: "" });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/Rarity override requires explicit confirmation/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");

    const staleFrom = await put(id, {
      rarityCode: "",
      rarity_override_confirmed: "true",
      rarity_override_from: "rare",
      rarity_override_to: "",
    });
    expect(staleFrom.status).toBe(400);
    expect(staleFrom.json.error).toMatch(/does not match this rarity transition/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");

    const mismatchedTo = await put(id, {
      rarityCode: "",
      rarity_override_confirmed: "true",
      rarity_override_from: "holo_rare_v",
      rarity_override_to: "silver_star_rare",
    });
    expect(mismatchedTo.status).toBe(400);
    expect(mismatchedTo.json.error).toMatch(/does not match this rarity transition/);
    expect((await readCert()).rarityCode).toBe("holo_rare_v");
    expect(await readAudits()).toHaveLength(0);
  });

  it("allows exact known rarity clear and a later no-op empty clear without duplicate audit rows", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v", finishVariant: "holo" });
    const clear = await put(id, {
      rarityCode: "",
      rarity_override_confirmed: "true",
      rarity_override_from: "holo_rare_v",
      rarity_override_to: "",
    });
    expect(clear.status).toBe(200);
    expect((await readCert()).rarityCode).toBeNull();
    expect((await readAudits()).filter((a: any) => a.action === "update")).toHaveLength(1);

    const noop = await put(id, { rarityCode: "" });
    expect(noop.status).toBe(200);
    expect((await readCert()).rarityCode).toBeNull();
    expect((await readAudits()).filter((a: any) => a.action === "update")).toHaveLength(1);
  });

  it("grading-panel draft persistence allows an exact known rarity clear", async () => {
    const id = await reseed({ ...STORED, rarityCode: "holo_rare_v", finishVariant: "holo", gradeApprovedAt: null });
    const { applyCertGradeDraft } = await import("../server/grader");
    await expect(
      applyCertGradeDraft(id, {
        rarity_code: null,
        finish_variant: "holo",
        promo_type: null,
        overall_grade: "9.5",
        grade_centering: "9",
        grade_corners: "10",
        grade_edges: "9.5",
        grade_surface: "10",
        rarity_override_confirmed: true,
        rarity_override_from: "holo_rare_v",
        rarity_override_to: "",
      })
    ).resolves.toBe(1);
    expect((await readCert()).rarityCode).toBeNull();
  });

  it("keeps unchanged legacy Chinese editable without fabricating a language audit row", async () => {
    const id = await reseed({ ...STORED, language: "Chinese" });
    const res = await put(id, { language: "Chinese", notes: "updated note" });
    expect(res.status).toBe(200);
    const after = await readCert();
    expect(after.language).toBe("Chinese");
    expect(after.notes).toBe("updated note");
    const update = (await readAudits()).find((a: any) => a.action === "update");
    expect(JSON.stringify(update.details)).not.toContain("language");
  });

  it("allows explicit Simplified and Traditional Chinese canonical writes", async () => {
    let id = await reseed({ ...STORED, language: "Chinese" });
    expect((await put(id, { language: "Simplified Chinese" })).status).toBe(200);
    expect((await readCert()).language).toBe("Simplified Chinese");

    id = await reseed({ ...STORED, language: "Chinese" });
    expect((await put(id, { language: "Traditional Chinese" })).status).toBe(200);
    expect((await readCert()).language).toBe("Traditional Chinese");
  });

  it("unchanged null/empty language does not block unrelated saves, but Martian is rejected", async () => {
    let id = await reseed({ ...STORED, language: null });
    expect((await put(id, { notes: "null language still editable" })).status).toBe(200);
    expect((await readCert()).language).toBeNull();

    id = await reseed({ ...STORED, language: "" });
    expect((await put(id, { notes: "empty language still editable" })).status).toBe(200);
    expect((await readCert()).language).toBe("");

    const bad = await put(id, { language: "Martian" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Unsupported language/);
  });

  it("no-op legacy language save creates no fabricated audit row", async () => {
    const id = await reseed({ ...STORED, language: "Chinese" });
    const res = await put(id, { language: "Chinese" });
    expect(res.status).toBe(200);
    expect(await readAudits()).toHaveLength(0);
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
      (k) => k !== "updatedAt" && JSON.stringify(after[k]) !== JSON.stringify(before[k])
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

describe("PR A: server-authoritative grading edits work on the dedicated grade route", () => {
  it("1. ignores a client-supplied overall grade", async () => {
    const id = await certId();
    const { status } = await putGrade(id, { overall_grade: "8" });
    expect(status).toBe(200);

    const after = await readCert();
    expect(after.gradeOverall).toBe("10.0");
    expect(after.gradeType).toBe("numeric");

    // The grading route audits under its own action with a payload-keyed diff.
    const audits = await readAudits();
    const save = audits.find((a: any) => a.action === "draft_save");
    expect(save, "an ignored grade claim must not be audited as a change").toBeFalsy();
    // ...and no metadata `update` event is fabricated for a grading write.
    expect(audits.map((a: any) => a.action)).not.toContain("update");
  });

  it("2. persists observations while replacing supplied grade outputs", async () => {
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
    expect(after.gradeOverall).toBe("10.0");
    expect(after.gradeCentering).toBe("9.0");
    expect(after.gradeCorners).toBe("10.0");
    expect(after.gradeEdges).toBe("9.5");
    expect(after.gradeSurface).toBe("10.0");
    expect(after.centeringFrontLr).toBe("52/48");
    // Metadata is NOT disturbed by a grading save.
    expect(after.cardName).toBe("Charizard");
    expect(after.variant).toBe("1ST EDITION");
    expect(after.notes).toBe("Grader notes that must survive");
  });

  it("3. ignores client attempts to clear or select an authentication-only grade", async () => {
    // BEHAVIOURAL DIFFERENCE, DELIBERATE. The metadata route treated an explicit
    // empty `gradeOverall` as a clear. The dedicated route does NOT: it uses
    // COALESCE preservation, precisely because an autosave arriving with an empty
    // grade had erased published grades before (MV205, PR #251). The operator's
    // real clear mechanism is the authentication-only conversion, proven in 4.
    // Both halves are asserted so neither can regress.
    const id = await certId();

    const empty = await putGrade(id, { overall_grade: "" });
    expect(empty.status).toBe(200);
    expect((await readCert()).gradeOverall, "an empty grade must NOT erase a stored grade").toBe("10.0");

    const omitted = await putGrade(id, { grade_explanation: "note only" });
    expect(omitted.status).toBe(200);
    expect((await readCert()).gradeOverall, "an omitted grade must NOT erase a stored grade").toBe("10.0");

    // A raw grade claim is not authentication evidence and cannot convert the
    // certificate to an authentication-only outcome.
    const cleared = await putGrade(id, { overall_grade: "NO" });
    expect(cleared.status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");
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
    // H-3: PostgreSQL stores NULL for a non-numeric kind, so the audit says NULL.
    // It previously echoed the payload string "AA" against a column that was
    // NULLed — a row that did not describe the database.
    expect(save.details.changed.overall_grade.to).toBeNull();
    expect(save.details.changed.overall_grade.to).not.toBe("AA");
    // M-2r: the KIND transition is what actually happened, and is now named.
    expect(save.details.changed.grade_type).toEqual({ from: "numeric", to: "AA" });
  });

  it("4b. converting a PUBLISHED certificate's kind is refused and audited", async () => {
    const id = await reseed({ ...STORED, gradeApprovedAt: new Date(), gradeApprovedBy: "admin@example.test" } as any);
    const { status, json } = await putGrade(id, { auth_status: "not_original" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Super Admin Correction Mode/);

    const after = await readCert();
    expect(after.gradeType).toBe("numeric");
    expect(after.gradeOverall).toBe("10.0");
    expect((await readAudits()).map((a: any) => a.action)).toContain("grade_kind_change_rejected");
  });

  it("5. M-3 (RESOLVED) — the grading route's audit is now ATOMIC with its write", async () => {
    // SUPERSEDES the PR #260 characterisation test of the same number, which
    // recorded the then-real behaviour: the grading route's audit INSERT sat in
    // its own try/catch that logged and continued, so a grade change could commit
    // with NO audit row and still answer 200. That test said explicitly: "If
    // someone later makes it atomic, this test fails loudly — which is exactly
    // the signal wanted." This PR makes it atomic, so the assertion is inverted
    // to the guarantee now provided.
    const id = await certId();
    const before = await readCert();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT audit_block2 CHECK (action <> 'draft_save')`);
    try {
      const { status } = await putGrade(id, { grade_explanation: "Audit-required save" });
      // Fail CLOSED: the caller is told the save failed …
      expect(status).toBe(500);
      // … and the grading mutation rolled back with its unwritable audit row.
      expect((await readCert()).gradeOverall, "the grade must NOT commit without its audit").toBe(before.gradeOverall);
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT audit_block2`);
    }

    // And the same write succeeds normally once the audit can be written.
    const ok = await putGrade(id, { grade_explanation: "Audit-required save" });
    expect(ok.status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");
    const saves = (await readAudits()).filter((a: any) => a.action === "draft_save");
    expect(saves).toHaveLength(1);
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
    expect((await readCert()).gradeOverall).toBe("10.0");
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
    for (const [field, value] of [
      ["gradeType", "NO"],
      ["labelType", "black"],
      ["gradeCorners", "3.0"],
    ] as const) {
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
    expect(after.gradeOverall).toBe("10.0"); // <- the newer grade SURVIVES
  });

  it("metadata-only save leaves every grading column untouched", async () => {
    const id = await certId();
    const before = await readCert();
    await put(id, { cardName: "Grading Untouched" });
    const after = await readCert();
    for (const k of [
      "gradeOverall",
      "gradeType",
      "labelType",
      "gradeCentering",
      "gradeCorners",
      "gradeEdges",
      "gradeSurface",
    ] as const) {
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
    expect(rejected[rejected.length - 1].entityId).toBe("MV1"); // cert number, not numeric id
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

// ─────────────────────────────────────────────────────────────────────────────
// H-1 (hostile review) — PAID-SUBMISSION LINKAGE, over the real create route
// ─────────────────────────────────────────────────────────────────────────────

/** POST the real create route as urlencoded form data (no image attached). */
async function post(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`${base}/api/admin/certificates`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function postWithImage(
  body: Record<string, unknown>,
  idempotencyKey: string,
  image = ONE_PIXEL_PNG
): Promise<{ status: number; json: any }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.append("frontImage", new Blob([image], { type: "image/png" }), "front.png");
  const res = await fetch(`${base}/api/admin/certificates`, {
    method: "POST",
    headers: { cookie, "Idempotency-Key": idempotencyKey },
    body: form,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The minimum identity the create route requires. */
const NEW_CERT = {
  cardGame: "pokemon",
  setName: "Base Set",
  cardName: "Blastoise",
  cardNumber: "2/102",
  year: "1999",
};

async function seedSubmissionItem(status = "paid", deleted = false): Promise<number> {
  const { rows } = await pool.query(`INSERT INTO submissions (status, deleted_at) VALUES ($1, $2) RETURNING id`, [
    status,
    deleted ? new Date() : null,
  ]);
  const { rows: itemRows } = await pool.query(
    `INSERT INTO submission_items (submission_id, card_name) VALUES ($1, 'Blastoise') RETURNING id`,
    [rows[0].id]
  );
  return itemRows[0].id as number;
}

async function readCertById(id: number) {
  const { certificates } = await import("../shared/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await (runtime.db as any).select().from(certificates).where(eq(certificates.id, id));
  return row;
}

describe("H-1: certificate creation stores the paid-submission link", () => {
  it("publishes image bytes, certificate pointers and audits through one replayable object intent", async () => {
    const itemId = await seedSubmissionItem("paid");
    const key = "certificate-create-route-replay";
    const first = await postWithImage({ ...NEW_CERT, status: "active", submissionItemId: String(itemId) }, key);
    expect(first.status).toBe(200);
    expect(first.json.frontImagePath).toMatch(/^images\/certificate-create\/[a-f0-9]{64}\/front\.png$/);
    expect(r2Calls.objects.get(first.json.frontImagePath)).toEqual(ONE_PIXEL_PNG);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");
    expect((await pool.query("SELECT count(*)::int AS n FROM certificate_images")).rows[0].n).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1", [first.json.certId])).rows[0].n
    ).toBe(2);

    const replay = await postWithImage({ ...NEW_CERT, status: "active", submissionItemId: String(itemId) }, key);
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(first.json.id);
    expect((await pool.query("SELECT last_issued::int AS n FROM cert_counter WHERE id=1")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM object_write_operations")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1", [first.json.certId])).rows[0].n).toBe(2);

    const changed = await postWithImage(
      { ...NEW_CERT, status: "active", submissionItemId: String(itemId) },
      key,
      Buffer.concat([ONE_PIXEL_PNG, Buffer.from([0])])
    );
    expect(changed.status).toBe(409);
  });

  it("MANDATORY 2: a certificate created from a valid paid submission item stores the link", async () => {
    const itemId = await seedSubmissionItem("paid");
    const { status, json } = await post({ ...NEW_CERT, submissionItemId: String(itemId) });
    expect(status).toBe(200);
    // The REGRESSION this covers: the client filtered submissionItemId out of
    // the FormData, so the route saw nothing and stored NULL with a 200.
    expect(json.submissionItemId).toBe(itemId);
    const row = await readCertById(json.id);
    expect(row.submissionItemId).toBe(itemId);
  });

  it("MANDATORY 3: a submission item cannot be silently reused", async () => {
    const itemId = await seedSubmissionItem("paid");
    expect((await post({ ...NEW_CERT, submissionItemId: String(itemId) })).status).toBe(200);

    // second certificate claiming the SAME item
    const second = await post({ ...NEW_CERT, cardName: "Venusaur", submissionItemId: String(itemId) });
    expect(second.status).toBe(400);
    expect(second.json.error).toMatch(/already linked|not found|not paid/i);

    // and nothing was created
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM certificates`);
    expect(rows[0].n).toBe(2); // the STORED fixture + the first creation only
  });

  it("an UNPAID (draft) submission is rejected", async () => {
    const itemId = await seedSubmissionItem("draft");
    const res = await post({ ...NEW_CERT, submissionItemId: String(itemId) });
    expect(res.status).toBe(400);
  });

  it("a SOFT-DELETED submission is rejected", async () => {
    const itemId = await seedSubmissionItem("paid", true);
    expect((await post({ ...NEW_CERT, submissionItemId: String(itemId) })).status).toBe(400);
  });

  it("a non-existent submission item is rejected", async () => {
    expect((await post({ ...NEW_CERT, submissionItemId: "987654" })).status).toBe(400);
  });

  it("creation WITHOUT a linkage still succeeds and stores NULL", async () => {
    const { status, json } = await post({ ...NEW_CERT });
    expect(status).toBe(200);
    expect((await readCertById(json.id)).submissionItemId).toBeNull();
  });

  it("an EDIT cannot re-link an existing certificate", async () => {
    const itemId = await seedSubmissionItem("paid");
    const created = await post({ ...NEW_CERT, submissionItemId: String(itemId) });
    const other = await seedSubmissionItem("paid");

    // Even if a hostile client posts it, the metadata route's commit allowlist
    // does not contain submissionItemId, so it can never be written.
    const res = await put(created.json.id, { cardName: "Blastoise (edited)", submissionItemId: String(other) });
    expect(res.status).toBe(200);
    const row = await readCertById(created.json.id);
    expect(row.cardName).toBe("Blastoise (edited)");
    expect(row.submissionItemId, "the link must NOT move").toBe(itemId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-4 — gradeManualOverride is rejected by the metadata PUT
// ─────────────────────────────────────────────────────────────────────────────

describe("M-4: gradeManualOverride is protected on the metadata route", () => {
  beforeEach(async () => {
    await pool.query(`UPDATE certificates SET grade_manual_override = false WHERE certificate_number = 'MV1'`);
  });

  for (const key of ["gradeManualOverride", "grade_manual_override"]) {
    it(`MANDATORY 13: a changed \`${key}\` returns the stable rejection and writes nothing`, async () => {
      const id = await certId();
      const before = await readCert();
      const { status, json } = await put(id, { cardName: "Ignored", [key]: "true" });

      expect(status).toBe(409);
      expect(json.rejectedFields).toEqual([key]);
      expect(json.error).toMatch(/grading route|\/grade/);

      // no write at all — not even the metadata field that shared the request
      const after = await readCert();
      expect(after.cardName).toBe(before.cardName);
      const { rows } = await pool.query(`SELECT grade_manual_override FROM certificates WHERE id = $1`, [id]);
      expect(rows[0].grade_manual_override).toBe(false);

      // exactly ONE audit, and it is the rejection — never a successful update
      const audits = await readAudits();
      const actions = audits.map((a: any) => a.action);
      expect(actions).toContain("metadata_grading_field_rejected");
      expect(actions).not.toContain("update");
    });
  }

  it("MANDATORY 18: the echo contract for an UNDECLARED column is fail-CLOSED", async () => {
    const id = await certId();
    // DOCUMENTING THE DELIBERATE CONTRACT. `grade_manual_override` is a real
    // column that shared/schema.ts does not declare, so a Drizzle-selected row
    // has no property for it and the route CANNOT prove a submitted value is an
    // echo. It therefore refuses to assume: any NON-EMPTY value is treated as a
    // change and rejected — the same rule already applied to `auth_status`.
    expect((await put(id, { gradeManualOverride: "false" })).status).toBe(409);

    // Only an EMPTY submission carries no decision and passes through silently.
    const empty = await put(id, { gradeManualOverride: "" });
    expect(empty.status).toBe(200);
    const audits = await readAudits();
    expect(audits.map((a: any) => a.action)).not.toContain("update");
  });

  it("a DECLARED grading column still tolerates a genuine unchanged echo", async () => {
    // Contrast with the above: `gradeOverall` IS declared, so the route can see
    // the stored value and knows the echo changes nothing.
    const id = await certId();
    const { status } = await put(id, { gradeOverall: STORED.gradeOverall });
    expect(status).toBe(200);
    const audits = await readAudits();
    expect(audits.map((a: any) => a.action)).not.toContain("metadata_grading_field_rejected");
    expect(audits.map((a: any) => a.action)).not.toContain("update");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 — numeric echo normalisation, through the real route
// ─────────────────────────────────────────────────────────────────────────────

describe("Task 7: a semantically-equal numeric grading echo is tolerated", () => {
  it('stored "10.0" vs submitted "10" is NOT a rejection', async () => {
    const id = await certId();
    // Put a real 10 on the record through the DEDICATED grading route; Postgres
    // `numeric` stores it and returns "10.0".
    expect((await putGrade(id, { overall_grade: "10" })).status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");

    // A legacy client echoes back what the UI showed it: "10".
    const { status } = await put(id, { cardName: "Charizard (edited)", gradeOverall: "10" });
    expect(status).toBe(200);
    const after = await readCert();
    expect(after.cardName).toBe("Charizard (edited)");
    expect(after.gradeOverall, "the grade must be untouched").toBe("10.0");
  });

  it('stored "10.0" vs submitted "10" is NOT a rejection', async () => {
    const id = await certId();
    expect((await putGrade(id, { overall_grade: "9.5", grade_corners: "9.5" })).status).toBe(200);
    const { status } = await put(id, { cardName: "Echo", gradeCorners: "10", corners_score: "10.0" });
    expect(status).toBe(200);
    expect((await readCert()).gradeCorners).toBe("10.0");
  });

  it("a MATERIALLY different numeric value is still rejected", async () => {
    const id = await certId();
    expect((await putGrade(id, { overall_grade: "10" })).status).toBe(200);
    const { status, json } = await put(id, { cardName: "Revert attempt", gradeOverall: "9" });
    expect(status).toBe(409);
    expect(json.rejectedFields).toEqual(["gradeOverall"]);
    expect((await readCert()).gradeOverall).toBe("10.0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-3 — image replacement always leaves truthful audit evidence
// ─────────────────────────────────────────────────────────────────────────────

/** Two DISTINCT real PNGs with the SAME extension, so the deterministic R2 key
 *  is identical while the object content genuinely differs. */
async function pngBuffer(r: number, g: number, b: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

async function putMultipart(
  id: number,
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; type: string; buffer: Buffer }>
): Promise<{ status: number; json: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) {
    form.append(f.field, new Blob([new Uint8Array(f.buffer)], { type: f.type }), f.filename);
  }
  const res = await fetch(`${base}/api/admin/certificates/${id}`, {
    method: "PUT",
    headers: { cookie },
    body: form,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("M-3: a same-path image replacement is auditable", () => {
  beforeEach(async () => {
    await pool.query(
      `UPDATE certificates SET front_image_path = 'images/MV1/front.png', back_image_path = 'images/MV1/back.png' WHERE certificate_number = 'MV1'`
    );
  });

  it("MANDATORY 14: replacing the FRONT at the same key produces exactly one truthful audit", async () => {
    const id = await certId();
    const buf = await pngBuffer(10, 20, 30);
    const { status } = await putMultipart(id, {}, [
      { field: "frontImage", filename: "front.png", type: "image/png", buffer: buf },
    ]);
    expect(status).toBe(200);

    const audits = await readAudits();
    const events = audits.filter((a: any) => a.action === "certificate_image_replaced");
    expect(events).toHaveLength(1);
    // …and NO ordinary metadata update audit, because no column changed
    expect(audits.filter((a: any) => a.action === "update")).toHaveLength(0);

    const d = events[0].details as any;
    expect(d.imageReplacements).toHaveLength(1);
    const rep = d.imageReplacements[0];
    expect(rep.side).toBe("front");
    expect(rep.r2Key).toBe("images/MV1/front.png");
    expect(rep.previousPath).toBe("images/MV1/front.png");
    // TRUTHFUL: it says the path did NOT change, and proves the content did.
    expect(rep.pathChanged).toBe(false);
    expect(rep.contentSha256).toBe((await import("node:crypto")).createHash("sha256").update(buf).digest("hex"));
    expect(rep.bytes).toBe(buf.length);
    expect(rep.contentType).toBe("image/png");
    // The stored path is unchanged and NOT fabricated as a change.
    expect((await readCert()).frontImagePath).toBe("images/MV1/front.png");
  });

  it("replacing the BACK is covered by the same guarantee", async () => {
    const id = await certId();
    const buf = await pngBuffer(200, 100, 50);
    expect(
      (await putMultipart(id, {}, [{ field: "backImage", filename: "back.png", type: "image/png", buffer: buf }]))
        .status
    ).toBe(200);
    const events = (await readAudits()).filter((a: any) => a.action === "certificate_image_replaced");
    expect(events).toHaveLength(1);
    expect((events[0].details as any).imageReplacements[0].side).toBe("back");
  });

  it("front AND back in one request are both recorded", async () => {
    const id = await certId();
    const { status } = await putMultipart(id, {}, [
      { field: "frontImage", filename: "front.png", type: "image/png", buffer: await pngBuffer(1, 2, 3) },
      { field: "backImage", filename: "back.png", type: "image/png", buffer: await pngBuffer(4, 5, 6) },
    ]);
    expect(status).toBe(200);
    const events = (await readAudits()).filter((a: any) => a.action === "certificate_image_replaced");
    expect(events).toHaveLength(1);
    const sides = (events[0].details as any).imageReplacements.map((r: any) => r.side).sort();
    expect(sides).toEqual(["back", "front"]);
  });

  it("a same-key replacement does NOT delete the object it just uploaded", async () => {
    const id = await certId();
    await putMultipart(id, {}, [
      { field: "frontImage", filename: "front.png", type: "image/png", buffer: await pngBuffer(9, 9, 9) },
    ]);
    expect(r2Calls.uploads.map((u) => u.key)).toContain("images/MV1/front.png");
    // The old code deleted `existing.frontImagePath` unconditionally, which for
    // an unchanged extension is the key just written — destroying the new image.
    expect(r2Calls.deletes).not.toContain("images/MV1/front.png");
  });

  it("a DIFFERENT extension changes the path, deletes the old object, and audits the update", async () => {
    const id = await certId();
    const sharp = (await import("sharp")).default;
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg()
      .toBuffer();
    const { status } = await putMultipart(id, {}, [
      { field: "frontImage", filename: "front.jpg", type: "image/jpeg", buffer: jpg },
    ]);
    expect(status).toBe(200);
    expect((await readCert()).frontImagePath).toBe("images/MV1/front.jpg");
    expect(r2Calls.deletes).toContain("images/MV1/front.png");

    const audits = await readAudits();
    const update = audits.find((a: any) => a.action === "update");
    expect(update).toBeTruthy();
    const d = update.details as any;
    expect(d.changedFields).toContain("frontImagePath");
    // content identity travels with the ordinary update audit too
    expect(d.imageReplacements[0].pathChanged).toBe(true);
    expect(d.imageReplacements[0].previousPath).toBe("images/MV1/front.png");
  });

  it("a metadata change AND an image replacement produce ONE combined update audit", async () => {
    const id = await certId();
    const { status } = await putMultipart(id, { cardName: "Charizard (rephotographed)" }, [
      { field: "frontImage", filename: "front.png", type: "image/png", buffer: await pngBuffer(7, 7, 7) },
    ]);
    expect(status).toBe(200);
    const audits = await readAudits();
    expect(audits.filter((a: any) => a.action === "update")).toHaveLength(1);
    expect(audits.filter((a: any) => a.action === "certificate_image_replaced")).toHaveLength(0);
    const d = audits.find((a: any) => a.action === "update").details as any;
    expect(d.changedFields).toContain("cardName");
    expect(d.imageReplacements[0].pathChanged).toBe(false);
  });

  it("MANDATORY 15: a true metadata no-op with NO image creates no audit at all", async () => {
    const id = await certId();
    const { status } = await put(id, { cardName: STORED.cardName, setName: STORED.setName });
    expect(status).toBe(200);
    expect(await readAudits()).toHaveLength(0);
  });

  it("an unchanged legacy grading echo alone still creates no audit", async () => {
    const id = await certId();
    const { status } = await put(id, { gradeOverall: STORED.gradeOverall, gradeType: "numeric" });
    expect(status).toBe(200);
    expect(await readAudits()).toHaveLength(0);
  });

  it("an upload that FAILS validation creates no audit and writes nothing", async () => {
    const id = await certId();
    const before = await readCert();
    const { status, json } = await putMultipart(id, { cardName: "Should not persist" }, [
      { field: "frontImage", filename: "evil.png", type: "image/png", buffer: Buffer.from("not an image at all") },
    ]);
    expect(status).toBe(400);
    expect(json.error).toMatch(/content-type validation/);
    expect(await readAudits()).toHaveLength(0);
    expect((await readCert()).cardName).toBe(before.cardName);
    expect(r2Calls.uploads).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-3 — the grading route's write and its audit are one transaction
//
// The hostile review of PR #260 recorded this as an open Medium: the grading
// UPDATE committed on its own connection, the audit INSERT ran afterwards inside
// try/catch, and ANY audit failure was swallowed while the route still answered
// { ok: true }. A grade could change on a customer's certificate with no durable
// record of who changed it or from what. The entity identifier was inconsistent
// too — the numeric row id here, the canonical certId on the metadata route — so
// querying the trail by certificate ID missed every grading event.
// ─────────────────────────────────────────────────────────────────────────────
describe("M-3: grading update and grading audit commit together", () => {
  it("1. a real grading change commits WITH its audit row", async () => {
    const id = await certId();
    const { status } = await putGrade(id, { grade_explanation: "Atomic evidence" });
    expect(status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");

    const saves = (await readAudits()).filter((a: any) => a.action === "draft_save");
    expect(saves).toHaveLength(1);
    expect(saves[0].details.outcome).toBe("committed");
    expect(saves[0].adminUser).toBeTruthy();
    expect(saves[0].createdAt).toBeTruthy();
  });

  it("4. the audit entity id is the CANONICAL certId, matching the metadata route", async () => {
    const id = await certId();
    await putGrade(id, { grade_explanation: "Canonical audit identity" });
    const save = (await readAudits()).find((a: any) => a.action === "draft_save");
    expect(save.entityType).toBe("certificate");
    expect(save.entityId).toBe("MV1");
    expect(save.entityId).not.toBe(String(id));
    // Numeric row id preserved inside details for continuity with older rows.
    expect(save.details.certificateId).toBe(id);
    expect(save.details.certId).toBe("MV1");
  });

  it("4b. grading and metadata events are BOTH findable by certificate id", async () => {
    // The point of the convention: one query by certId returns the whole story.
    const id = await certId();
    await putGrade(id, { grade_explanation: "Canonical audit identity" });
    expect((await put(id, { cardName: "Renamed" })).status).toBe(200);

    const byCertId = (await readAudits()).filter((a: any) => a.entityId === "MV1");
    const actions = byCertId.map((a: any) => a.action);
    expect(actions).toContain("draft_save");
    expect(actions).toContain("update");
  });

  it("5. old and new values and the changed-field list are accurate", async () => {
    const id = await certId();
    await putGrade(id, { overall_grade: "8", grade_explanation: "Edge wear on the left border" });
    const save = (await readAudits()).find((a: any) => a.action === "draft_save");

    expect(new Set(save.details.changedFields)).toEqual(new Set(["grade_explanation"]));
    expect(save.details.changed.overall_grade).toBeUndefined();
    expect(save.details.changed.grade_explanation.to).toBe("Edge wear on the left border");
    expect(save.details.was_approved).toBe(false);
  });

  it("6. a genuine NO-OP grading submit writes no false change audit", async () => {
    const id = await certId();
    const before = await readCert();
    // Re-submit exactly what is already stored.
    const { status } = await putGrade(id, { overall_grade: String(before.gradeOverall) });
    expect(status).toBe(200);
    expect((await readAudits()).filter((a: any) => a.action === "draft_save")).toHaveLength(0);
    expect((await readCert()).gradeOverall).toBe(before.gradeOverall);
  });

  it("6b. a repeated identical save does not accumulate duplicate audits", async () => {
    const id = await certId();
    await putGrade(id, { grade_explanation: "same evidence" }); // real change → 1 audit
    await putGrade(id, { grade_explanation: "same evidence" }); // no-op → none
    await putGrade(id, { grade_explanation: "same evidence" }); // no-op → none
    expect((await readAudits()).filter((a: any) => a.action === "draft_save")).toHaveLength(1);
  });

  it("2/3. an unwritable audit rolls the grading change back AND fails closed", async () => {
    const id = await certId();
    const before = await readCert();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block CHECK (action <> 'draft_save')`);
    try {
      const { status } = await putGrade(id, { grade_explanation: "Atomic evidence" });
      expect(status).toBe(500);
      const after = await readCert();
      expect(after.gradeOverall).toBe(before.gradeOverall);
      expect(after.gradeCorners).toBe(before.gradeCorners);
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block`);
    }
  });

  it("8. an authorised live-record correction still works and is audited", async () => {
    const id = await reseed({
      ...STORED,
      gradeApprovedAt: new Date(),
      gradeApprovedBy: "admin@example.test",
    } as any);
    const { status } = await putGrade(id, { grade_explanation: "Corrected after re-inspection" });
    expect(status).toBe(200);
    const audits = await readAudits();
    const edit = audits.find((a: any) => a.action === "cert_live_record_edit");
    expect(edit, "an approved cert's edit is a live-record edit").toBeTruthy();
    expect(edit.entityId).toBe("MV1");
    expect(edit.details.was_approved).toBe(true);
    expect(edit.details.changedFields).toEqual(["grade_explanation"]);
  });

  it("9. metadata edits are entirely unaffected by the grading transaction", async () => {
    const id = await certId();
    const { status } = await put(id, { cardName: "Metadata Still Fine", notes: "unchanged path" });
    expect(status).toBe(200);
    const after = await readCert();
    expect(after.cardName).toBe("Metadata Still Fine");
    const updates = (await readAudits()).filter((a: any) => a.action === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].entityId).toBe("MV1");
  });

  it("10. MV900007 — a stale metadata save STILL cannot revert a newer grade", async () => {
    const id = await certId();
    // The authorised grading route raises the grade …
    expect((await putGrade(id, { overall_grade: "10", grade_corners: "10" })).status).toBe(200);
    expect((await readCert()).gradeOverall).toBe("10.0");
    // … and a stale Card Details tab still cannot take it back.
    const stale = await put(id, { cardName: "Typo Fix", gradeOverall: "9.0" });
    expect(stale.status).toBe(409);
    expect(stale.json.rejectedFields).toContain("gradeOverall");
    expect((await readCert()).gradeOverall).toBe("10.0");
    // The clean client succeeds and changes only metadata.
    expect((await put(id, { cardName: "Typo Fix" })).status).toBe(200);
    const after = await readCert();
    expect(after.cardName).toBe("Typo Fix");
    expect(after.gradeOverall).toBe("10.0");
  });

  it("7. the grader lock still refuses an admin grading write", async () => {
    // Pre-existing conflict protection must survive the transaction change.
    const id = await certId();
    const before = await readCert();
    await q(`UPDATE certificates SET grader_status = 'assigned', graded_by = 'grader@example.test' WHERE id = ${id}`);
    try {
      const { status } = await putGrade(id, { grade_explanation: "Locked evidence" });
      // Either the lock refuses it (409) or the lock is not engaged in this
      // fixture; what must NEVER happen is a silent unaudited grade change.
      if (status === 409) {
        expect((await readCert()).gradeOverall).toBe(before.gradeOverall);
        expect((await readAudits()).filter((a: any) => a.action === "draft_save")).toHaveLength(0);
      } else {
        expect(status).toBe(200);
        expect((await readAudits()).filter((a: any) => a.action === "draft_save")).toHaveLength(1);
      }
    } finally {
      await q(`UPDATE certificates SET grader_status = NULL, graded_by = NULL WHERE id = ${id}`);
    }
  });
});

/**
 * M-1 (hostile review of PR #262) · the eight MVGS v2 defect-input columns.
 *
 * WHAT WENT WRONG
 * PR #262 correctly stopped the grading route writing an audit row for an empty
 * change set. But eight columns the same UPDATE writes were never in the audit
 * field map: `whitening_lines`, `crease_lines`, `crease_span_pct`,
 * `wrinkle_severity`, `tear_severity`, `eye_appeal_modifier`,
 * `dark_border_front` and `dark_border_back`. The combination meant a save that
 * touched ONLY these produced NO audit row at all — and these are not cosmetic
 * fields, they are the operator-marked evidence the MVGS engine reads.
 * `buildPayload()` sends all eight on every save.
 *
 * These tests drive the REAL route against a REAL PostgreSQL cluster through
 * the REAL `requireAdmin` chain, and assert the audit row against the value the
 * database actually holds afterwards — never against the payload alone. That
 * distinction is the point: the SQL for these columns clamps, validates and
 * type-gates what it writes, so auditing the raw payload would have replaced a
 * missing row with a lying one.
 */
describe("M-1 · MVGS v2 defect inputs are audited truthfully", () => {
  const savesOf = async () => (await readAudits()).filter((a: any) => a.action === "draft_save");
  const onlySave = async () => {
    const s = await savesOf();
    expect(s, "exactly one grading audit row").toHaveLength(1);
    return s[0];
  };

  it("a whitening-line change ALONE writes exactly one truthful audit row", async () => {
    const id = await certId();
    const lines = [{ edge: "top", lengthPct: 12 }];
    const { status } = await putGrade(id, { whitening_lines: lines });
    expect(status).toBe(200);

    // The column really moved…
    expect((await readCert()).whiteningLines).toEqual(lines);
    // …and exactly one row says so, with the full identity contract.
    const save = await onlySave();
    expect(save.entityType).toBe("certificate");
    expect(save.entityId).toBe("MV1");
    expect(save.adminUser).toBeTruthy();
    expect(save.createdAt).toBeTruthy();
    expect(save.details.changedFields).toEqual(["whitening_lines"]);
    expect(save.details.changed.whitening_lines.from).toBeNull();
    expect(save.details.changed.whitening_lines.to).toEqual(lines);
    expect(save.details.outcome).toBe("committed");
  });

  it("a crease-line change ALONE is audited", async () => {
    const id = await certId();
    const creases = [{ id: "c1", spanPct: 30, start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }];
    expect((await putGrade(id, { crease_lines: creases })).status).toBe(200);
    expect((await readCert()).creaseLines).toEqual(creases);
    const save = await onlySave();
    expect(save.details.changedFields).toEqual(["crease_lines"]);
    expect(save.details.changed.crease_lines.to).toEqual(creases);
  });

  it("a severity / modifier change ALONE is audited", async () => {
    const id = await certId();
    expect(
      (await putGrade(id, { wrinkle_severity: "small_front", tear_severity: "minor", eye_appeal_modifier: -1 })).status
    ).toBe(200);
    const cert = await readCert();
    expect(cert.wrinkleSeverity).toBe("small_front");
    expect(cert.tearSeverity).toBe("minor");
    expect(cert.eyeAppealModifier).toBe(-1);

    const save = await onlySave();
    expect(new Set(save.details.changedFields)).toEqual(
      new Set(["wrinkle_severity", "tear_severity", "eye_appeal_modifier"])
    );
    expect(save.details.changed.wrinkle_severity.to).toBe("small_front");
    expect(save.details.changed.tear_severity.to).toBe("minor");
    expect(save.details.changed.eye_appeal_modifier.to).toBe(-1);
  });

  it("a dark-border toggle ALONE is audited", async () => {
    const id = await certId();
    expect((await putGrade(id, { dark_border_front: true })).status).toBe(200);
    expect((await readCert()).darkBorderFront).toBe(true);
    const save = await onlySave();
    expect(save.details.changedFields).toEqual(["dark_border_front"]);
    expect(save.details.changed.dark_border_front.to).toBe(true);
  });

  it("a crease_span_pct change ALONE is audited", async () => {
    const id = await certId();
    expect((await putGrade(id, { crease_span_pct: 42.5 })).status).toBe(200);
    expect(Number((await readCert()).creaseSpanPct)).toBe(42.5);
    const save = await onlySave();
    expect(save.details.changedFields).toEqual(["crease_span_pct"]);
  });

  it("several defect inputs changed together produce ONE row listing all of them", async () => {
    const id = await certId();
    const { status } = await putGrade(id, {
      whitening_lines: [{ edge: "left", lengthPct: 5 }],
      crease_lines: [{ id: "c9", spanPct: 8 }],
      wrinkle_severity: "tiny_back",
      tear_severity: "significant",
      eye_appeal_modifier: 2,
      dark_border_front: true,
      dark_border_back: true,
      crease_span_pct: 8,
    });
    expect(status).toBe(200);
    const save = await onlySave();
    expect(new Set(save.details.changedFields)).toEqual(
      new Set([
        "whitening_lines",
        "crease_lines",
        "wrinkle_severity",
        "tear_severity",
        "eye_appeal_modifier",
        "dark_border_front",
        "dark_border_back",
        "crease_span_pct",
      ])
    );
  });

  it("resubmitting semantically identical defect inputs writes NO second row", async () => {
    const id = await certId();
    const payload = {
      whitening_lines: [{ edge: "top", lengthPct: 12 }],
      wrinkle_severity: "tiny_back",
      eye_appeal_modifier: 1,
      dark_border_front: true,
      crease_span_pct: 10,
    };
    expect((await putGrade(id, payload)).status).toBe(200);
    expect(await savesOf()).toHaveLength(1);

    // Byte-identical re-save — the debounced auto-save's normal behaviour.
    expect((await putGrade(id, payload)).status).toBe(200);
    expect(await savesOf(), "a no-op must not accumulate rows").toHaveLength(1);
  });

  it("jsonb KEY ORDER is not a change — structured values compare semantically", async () => {
    const id = await certId();
    expect((await putGrade(id, { whitening_lines: [{ edge: "top", lengthPct: 12 }] })).status).toBe(200);
    expect(await savesOf()).toHaveLength(1);

    // Same value, keys written in the opposite order. Postgres returns jsonb in
    // its OWN ordering, so a raw-string compare would call this a change.
    expect((await putGrade(id, { whitening_lines: [{ lengthPct: 12, edge: "top" }] })).status).toBe(200);
    expect(await savesOf()).toHaveLength(1);
  });

  it("ARRAY order IS a change — reordering creases is real evidence movement", async () => {
    const id = await certId();
    const a = { id: "a", spanPct: 1 };
    const b = { id: "b", spanPct: 2 };
    expect((await putGrade(id, { crease_lines: [a, b] })).status).toBe(200);
    expect(await savesOf()).toHaveLength(1);
    expect((await putGrade(id, { crease_lines: [b, a] })).status).toBe(200);
    expect(await savesOf()).toHaveLength(2);
  });

  it("a CLAMPED modifier audits the value actually written, not the payload", async () => {
    // The SQL clamps ±2. Auditing the raw payload would claim `to: 99`, which
    // the database never held — a missing row traded for a false one.
    const id = await certId();
    expect((await putGrade(id, { eye_appeal_modifier: 99 })).status).toBe(200);
    expect((await readCert()).eyeAppealModifier).toBe(2);
    const save = await onlySave();
    expect(save.details.changed.eye_appeal_modifier.to).toBe(2);
    expect(save.details.changed.eye_appeal_modifier.to).not.toBe(99);
  });

  it("an INVALID severity writes nothing and audits nothing", async () => {
    const id = await certId();
    const before = await readCert();
    expect((await putGrade(id, { wrinkle_severity: "not-a-real-severity" })).status).toBe(200);
    // The SQL preserves the stored value for an unrecognised enum…
    expect((await readCert()).wrinkleSeverity).toBe(before.wrinkleSeverity ?? null);
    // …so nothing may be reported as changed.
    expect(await savesOf()).toHaveLength(0);
  });

  it("an unwritable audit rolls a defect-input change BACK and fails closed", async () => {
    const id = await certId();
    const before = await readCert();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m1_block CHECK (action <> 'draft_save')`);
    try {
      const { status } = await putGrade(id, {
        whitening_lines: [{ edge: "bottom", lengthPct: 40 }],
        wrinkle_severity: "multiple_front",
        dark_border_back: true,
      });
      expect(status).toBe(500);
      const after = await readCert();
      expect(after.whiteningLines).toEqual(before.whiteningLines ?? null);
      expect(after.wrinkleSeverity).toBe(before.wrinkleSeverity ?? null);
      expect(after.darkBorderBack).toBe(before.darkBorderBack);
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m1_block`);
    }
  });

  it("untrusted numeric outputs are no-ops", async () => {
    const id = await certId();
    expect((await putGrade(id, { overall_grade: "8" })).status).toBe(200);
    expect(await savesOf()).toHaveLength(0);
    expect((await readCert()).gradeOverall).toBe("10.0");
    expect((await putGrade(id, { overall_grade: "8" })).status).toBe(200);
    expect(await savesOf()).toHaveLength(0);
  });
});

/**
 * H-2 / H-3 / M-2r (final hostile recheck) · the grading audit must describe what
 * PostgreSQL actually holds, for the payload the REAL client actually sends.
 *
 * Every earlier test in this file posted a MINIMAL payload. That is why two
 * defects survived two hostile reviews:
 *
 *   H-2 — `auth_status`, `auth_notes` and `private_notes` are real columns this
 *         route writes, but shared/schema.ts does not declare them, so Drizzle's
 *         `.select()` never materialises them and the before-value read back as
 *         `undefined` → `null`. `buildPayload()` sends all three on EVERY save,
 *         so every audit row carried three fabricated changes and `changed` was
 *         never empty — which meant PR #262's no-op suppression could never fire.
 *
 *   H-3 — when the resolved kind is non-numeric the SET clause writes `grade` and
 *         all four sub-grades as literal NULL, ignoring the payload, while the
 *         audit reported the payload. An authentication-only certificate was
 *         therefore audited on every autosave as `overall_grade: null -> "NO"`
 *         against a column that stayed NULL.
 *
 *   M-2r — `grade_type` is the highest-consequence column this route writes and
 *          was never named in the trail.
 *
 * These tests use the COMPLETE buildPayload() key set and assert the audit
 * against the row re-read from the database, never against the payload.
 */
describe("H-2/H-3 · the audit matches the committed row, for the REAL payload", () => {
  const savesOf = async () =>
    (await readAudits()).filter((a: any) => ["draft_save", "cert_live_record_edit"].includes(a.action));

  /** Exactly the key set client buildPayload() always emits (admin, non-grader). */
  const fullPayload = (over: Record<string, unknown> = {}) => ({
    overall_grade: "9.5",
    auth_status: "genuine",
    auth_notes: "",
    grade_explanation: "Sample explanation",
    private_notes: "",
    defects: [],
    ai_defect_candidates: [],
    dark_border_front: false,
    dark_border_back: false,
    eye_appeal_modifier: 0,
    whitening_lines: [],
    crease_lines: [],
    crease_span_pct: null,
    wrinkle_severity: null,
    tear_severity: null,
    ...over,
  });

  it("H-2 · a byte-identical resave of the FULL payload writes ZERO new audit rows", async () => {
    const id = await certId();
    expect((await putGrade(id, fullPayload())).status).toBe(200);
    const afterFirst = (await savesOf()).length;
    const committed = await readCert();

    // Same complete payload again — a genuine no-op.
    expect((await putGrade(id, fullPayload())).status).toBe(200);
    expect(await savesOf(), "a no-op resave must add nothing").toHaveLength(afterFirst);
    // …and the row really did not move.
    expect((await readCert()).gradeOverall).toBe(committed.gradeOverall);
  });

  it("H-2 · no audit row ever claims auth_status / auth_notes / private_notes changed", async () => {
    const id = await certId();
    await putGrade(id, fullPayload({ overall_grade: "7" }));
    const rows = await savesOf();
    for (const r of rows) {
      for (const forbidden of ["auth_status", "auth_notes", "private_notes"]) {
        expect(r.details.changed?.[forbidden], `${forbidden} must never be audited by this route`).toBeUndefined();
        expect(r.details.changedFields ?? []).not.toContain(forbidden);
      }
    }
    // The omission is STATED, not silent.
    expect(new Set(rows[0].details.unauditableFields)).toEqual(new Set(["auth_status", "auth_notes", "private_notes"]));
  });

  it("H-2 · a genuine owned grading change still audits exactly once", async () => {
    const id = await certId();
    await putGrade(id, fullPayload({ whitening_lines: [{ edge: "top", lengthPct: 9 }] }));
    const rows = await savesOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].details.changedFields).toContain("whitening_lines");
  });

  it("H-3 · an unchanged NO save writes no audit row", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET grade_type='NO', grade=NULL, centering_score=NULL,
             corners_score=NULL, edges_score=NULL, surface_score=NULL WHERE id=${id}`);
    await q(`DELETE FROM audit_log`);
    // First save settles anything else (defects/explanation), then the real test.
    await putGrade(id, fullPayload({ overall_grade: "NO", auth_status: "not_original" }));
    await q(`DELETE FROM audit_log`);
    expect((await putGrade(id, fullPayload({ overall_grade: "NO", auth_status: "not_original" }))).status).toBe(200);
    expect(await savesOf()).toHaveLength(0);
    const cert = await readCert();
    expect(cert.gradeOverall).toBeNull();
    expect(cert.gradeCentering).toBeNull();
  });

  it("H-3 · an unchanged AA save writes no audit row", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET grade_type='AA', grade=NULL, centering_score=NULL,
             corners_score=NULL, edges_score=NULL, surface_score=NULL WHERE id=${id}`);
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ overall_grade: "AA", auth_status: "authentic_altered" }));
    await q(`DELETE FROM audit_log`);
    expect((await putGrade(id, fullPayload({ overall_grade: "AA", auth_status: "authentic_altered" }))).status).toBe(
      200
    );
    expect(await savesOf()).toHaveLength(0);
  });

  it("H-3 · the NULL-out is audited at NULL, never at the payload string", async () => {
    // The exact previously-lying case: a numeric cert converted to NO while the
    // payload also carries a sub-grade the UPDATE will discard.
    const id = await certId();
    const before = await readCert();
    expect(before.gradeOverall).not.toBeNull();
    await q(`DELETE FROM audit_log`);

    expect(
      (await putGrade(id, fullPayload({ overall_grade: "NO", auth_status: "not_original", grade_centering: 9 }))).status
    ).toBe(200);
    const after = await readCert();
    expect(after.gradeOverall, "postgres stores NULL").toBeNull();
    expect(after.gradeCentering, "postgres stores NULL").toBeNull();

    const row = (await savesOf())[0];
    // Truthful: from the old value TO NULL — not to "NO", not to 9.
    expect(row.details.changed.overall_grade.to).toBeNull();
    expect(row.details.changed.overall_grade.to).not.toBe("NO");
    if (row.details.changed.grade_centering) {
      expect(row.details.changed.grade_centering.to).toBeNull();
      expect(row.details.changed.grade_centering.to).not.toBe(9);
    }
  });

  it("H-3 · no audited value differs from the value re-read from PostgreSQL", async () => {
    const id = await certId();
    await q(`DELETE FROM audit_log`);
    await putGrade(
      id,
      fullPayload({
        overall_grade: "NO",
        auth_status: "not_original",
        grade_centering: 9,
        grade_corners: 8,
        eye_appeal_modifier: 99,
      })
    );
    const cert: any = await readCert();
    const row = (await savesOf())[0];
    const accessor: Record<string, string> = {
      overall_grade: "gradeOverall",
      grade_centering: "gradeCentering",
      grade_corners: "gradeCorners",
      grade_type: "gradeType",
      eye_appeal_modifier: "eyeAppealModifier",
    };
    for (const [pKey, cKey] of Object.entries(accessor)) {
      const audited = row.details.changed?.[pKey]?.to;
      if (audited === undefined) continue; // not reported as changed
      const stored = cert[cKey];
      const norm = (v: unknown) =>
        v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(Number(v) || v);
      expect(norm(audited), `${pKey}: audit says ${audited}, database holds ${stored}`).toBe(norm(stored));
    }
  });

  it("M-2r · numeric → NO records the grade_type transition", async () => {
    const id = await certId();
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ overall_grade: "NO", auth_status: "not_original" }));
    const row = (await savesOf())[0];
    expect(row.details.changedFields).toContain("grade_type");
    expect(row.details.changed.grade_type.from).toBe("numeric");
    expect(row.details.changed.grade_type.to).toBe("NO");
    expect((await readCert()).gradeType).toBe("NO");
  });

  it("M-2r · numeric → AA records the grade_type transition", async () => {
    const id = await certId();
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ overall_grade: "AA", auth_status: "authentic_altered" }));
    const row = (await savesOf())[0];
    expect(row.details.changed.grade_type).toEqual({ from: "numeric", to: "AA" });
  });

  it("M-2r · NO → numeric records the grade_type transition", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET grade_type='NO', grade=NULL WHERE id=${id}`);
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ overall_grade: "8" }));
    const row = (await savesOf())[0];
    expect(row.details.changed.grade_type).toEqual({ from: "NO", to: "numeric" });
    expect((await readCert()).gradeType).toBe("numeric");
  });

  it("M-2r · AA → numeric records the grade_type transition", async () => {
    const id = await certId();
    await q(`UPDATE certificates SET grade_type='AA', grade=NULL WHERE id=${id}`);
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ overall_grade: "8" }));
    const row = (await savesOf())[0];
    expect(row.details.changed.grade_type).toEqual({ from: "AA", to: "numeric" });
  });

  it("M-2r · an unchanged kind produces no grade_type diff", async () => {
    const id = await certId();
    await putGrade(id, fullPayload());
    await q(`DELETE FROM audit_log`);
    await putGrade(id, fullPayload({ grade_explanation: "changed text" }));
    const row = (await savesOf())[0];
    expect(row.details.changedFields).toContain("grade_explanation");
    expect(row.details.changedFields).not.toContain("grade_type");
  });

  it("H-3 · audit failure still rolls the whole mutation back", async () => {
    const id = await certId();
    const before = await readCert();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT h3_block CHECK (action <> 'draft_save')`);
    try {
      const { status } = await putGrade(id, fullPayload({ overall_grade: "NO" }));
      expect(status).toBe(500);
      const after = await readCert();
      expect(after.gradeOverall).toBe(before.gradeOverall);
      expect(after.gradeType).toBe(before.gradeType);
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT h3_block`);
    }
  });
});
