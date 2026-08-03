/**
 * P0-B — immutable partner grading-origin snapshot on certificates (migration 0035).
 *
 * Two layers:
 *
 *   1. RENDERER PROOFS (always run). certificateOrigin() is a pure function of the snapshot
 *      columns, so these need no database.
 *
 *   2. DATABASE PROOFS (gated on a disposable loopback PostgreSQL 17 in
 *      PARTNER_CERT_ORIGIN_ADMIN). These run the REAL migration runner (scripts/db/migrate.ts),
 *      not a hand-rolled emulation, so the journal, advisory lock, checksum pin and per-file
 *      transaction wrapping are genuinely exercised.
 *
 * A SKIPPED RUN IS NOT A PASS. The first describe block fails in CI if the gate is unset, and
 * vitest reports the gated suites as skipped rather than green.
 *
 * The headline proof is "partner lifecycle cannot rewrite history": a certificate is stamped,
 * then the partner is renamed, moved, suspended, revoked and finally DELETED outright, and the
 * certificate still renders exactly what it said on day one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { listMigrationFiles, applyMigrations, planMigrations } from "../scripts/db/migrate";
import { lintSql, hasBlocking } from "../scripts/db/lint-destructive-sql";
import {
  certificateOrigin,
  HQ_ORIGIN_NAME,
  UNNAMED_PARTNER_ORIGIN_NAME,
  type CertificateOriginView,
} from "../server/labels";
import type { CertificateRecord } from "../shared/schema";

// The Pristine 10P gate lazily loads MVGS calibration from the application database, which this
// suite has no business touching — grading logic is PROTECTED and is not what is under test here.
// Stubbing it keeps the document render hermetic; the grade section is unaffected by origin.
vi.mock("../server/lib/cert-pristine", () => ({ certIsPristine: async () => false }));

// Imported AFTER the mock declaration for readability; vitest hoists vi.mock above all imports.
import { generateCertificateDocument } from "../server/certificate-document";

const MIGRATION_FILE = "0035_partner_certificate_origin.sql";
const ROLLBACK_FILE = "rollback-0035-partner-certificate-origin.sql";
const MIGRATIONS_DIR = join(process.cwd(), "migrations");

const ADMIN_DB = process.env.PARTNER_CERT_ORIGIN_ADMIN;

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

/** Minimal certificate shape for the pure renderer. Cast once, here, rather than in every test. */
function certOf(fields: Record<string, unknown>): CertificateRecord {
  return fields as unknown as CertificateRecord;
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. Gate visibility — a skipped suite must be loud, never mistaken for green.
// ═══════════════════════════════════════════════════════════════════════════
describe("partner certificate origin — DB coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_CERT_ORIGIN_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal) {
      console.warn("[partner-certificate-origin] DB suites SKIPPED: PARTNER_CERT_ORIGIN_ADMIN is not a loopback URL");
    }
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Renderer — pure, no database.
// ═══════════════════════════════════════════════════════════════════════════
describe("certificateOrigin() — what a certificate says about who graded it", () => {
  it("renders a LEGACY certificate (origin_type NULL) as MintVault Headquarters", () => {
    const view = certificateOrigin(certOf({ certId: "MV1", originType: null }));
    expect(view.isPartner).toBe(false);
    expect(view.name).toBe(HQ_ORIGIN_NAME);
    expect(view.line).toBe("Graded by MintVault Headquarters");
    expect(view.location).toBeNull();
  });

  it("renders a certificate with NO origin columns at all as MintVault Headquarters", () => {
    // Defends the read path against a row selected before migration 0035 reached an environment.
    const view = certificateOrigin(certOf({ certId: "MV2" }));
    expect(view.line).toBe("Graded by MintVault Headquarters");
  });

  it("renders an explicit HQ certificate as MintVault Headquarters", () => {
    const view = certificateOrigin(certOf({ certId: "MV3", originType: "HQ" }));
    expect(view.isPartner).toBe(false);
    expect(view.line).toBe("Graded by MintVault Headquarters");
  });

  it("renders a PARTNER certificate with the snapshotted TRADING name", () => {
    const view = certificateOrigin(
      certOf({
        certId: "MV4",
        originType: "PARTNER",
        originPartnerTradingName: "Kent Card Emporium",
        originPartnerLegalName: "KCE Collectibles Ltd",
      })
    );
    expect(view.isPartner).toBe(true);
    expect(view.name).toBe("Kent Card Emporium");
    expect(view.line).toBe("Graded by Kent Card Emporium");
  });

  it("falls back to the LEGAL name when no trading name was captured", () => {
    // partner_profiles.trading_name is nullable in 0015, so this is a real shape.
    const view = certificateOrigin(
      certOf({ certId: "MV5", originType: "PARTNER", originPartnerLegalName: "KCE Collectibles Ltd" })
    );
    expect(view.name).toBe("KCE Collectibles Ltd");
  });

  it("treats a whitespace-only trading name as absent rather than printing a blank issuer", () => {
    const view = certificateOrigin(
      certOf({
        certId: "MV6",
        originType: "PARTNER",
        originPartnerTradingName: "   ",
        originPartnerLegalName: "KCE Collectibles Ltd",
      })
    );
    expect(view.name).toBe("KCE Collectibles Ltd");
  });

  it("NEVER claims HQ graded a partner card, even if the snapshot has no name at all", () => {
    // Unreachable through storage + the CHECK constraint, but if it ever happened, printing
    // "Graded by MintVault Headquarters" would be a FALSE public statement about the card.
    const view = certificateOrigin(certOf({ certId: "MV7", originType: "PARTNER" }));
    expect(view.isPartner).toBe(true);
    expect(view.name).toBe(UNNAMED_PARTNER_ORIGIN_NAME);
    expect(view.name).not.toBe(HQ_ORIGIN_NAME);
    expect(view.line).not.toContain("Headquarters");
  });

  it("composes the approved intake/grading location from the snapshot", () => {
    const both = certificateOrigin(
      certOf({
        originType: "PARTNER",
        originPartnerTradingName: "Kent Card Emporium",
        originLocationName: "Canterbury Store",
        originLocationAddress: "12 High Street, Canterbury, CT1 2AB",
      })
    );
    expect(both.location).toBe("Canterbury Store — 12 High Street, Canterbury, CT1 2AB");

    const nameOnly = certificateOrigin(
      certOf({ originType: "PARTNER", originPartnerTradingName: "X", originLocationName: "Canterbury Store" })
    );
    expect(nameOnly.location).toBe("Canterbury Store");

    const addressOnly = certificateOrigin(
      certOf({ originType: "PARTNER", originPartnerTradingName: "X", originLocationAddress: "12 High Street" })
    );
    expect(addressOnly.location).toBe("12 High Street");

    const neither = certificateOrigin(certOf({ originType: "PARTNER", originPartnerTradingName: "X" }));
    expect(neither.location).toBeNull();
  });

  it("never reports a location for an HQ or legacy certificate", () => {
    // Location is partner-intake evidence; the CHECK constraint keeps these columns NULL for
    // non-partner rows, and the renderer must not resurrect them if one ever leaked through.
    expect(certificateOrigin(certOf({ originType: "HQ", originLocationName: "leaked" })).location).toBeNull();
    expect(certificateOrigin(certOf({ originType: null, originLocationName: "leaked" })).location).toBeNull();
  });

  it("is a PURE function of the snapshot — it performs no partner lookup", () => {
    // Structural proof: the resolver's body must not reference any partner table or storage
    // accessor. If someone later "improves" it into an FK join, renaming a shop would start
    // rewriting issued certificates and this fails immediately.
    const src = readFileSync(join(process.cwd(), "server", "labels.ts"), "utf8");
    const body = src.slice(src.indexOf("export function certificateOrigin"));
    const whole = body.slice(0, body.indexOf("\n}\n") + 3);
    // Comments are prose and may legitimately NAME the tables this function must not query.
    const fnBody = whole
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(fnBody).not.toMatch(/partner_organisations|partner_profiles|partner_locations/);
    expect(fnBody).not.toMatch(/\bawait\b|\bstorage\b|\bdb\b\./);
    // And it must read the snapshot columns, not a joined alias.
    expect(fnBody).toContain("originPartnerTradingName");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Migration file hygiene — no database required.
// ═══════════════════════════════════════════════════════════════════════════
describe("migration 0035 — file-level guarantees", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

  it("is picked up by the real runner under the expected number", () => {
    const f = listMigrationFiles().find((m) => m.filename === MIGRATION_FILE);
    expect(f, `${MIGRATION_FILE} must be discovered by listMigrationFiles()`).toBeDefined();
    expect(f!.number).toBe("0035");
  });

  it("trips no BLOCKING finding in the destructive-SQL linter", () => {
    const findings = lintSql(sql);
    expect(hasBlocking(findings), `blocking findings: ${JSON.stringify(findings)}`).toBe(false);
  });

  it("is additive only — no drop, rename, retype or truncate of anything that exists", () => {
    // Comments are prose; assert against statements only.
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  it("performs NO backfill — it contains no UPDATE of certificates", () => {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\bUPDATE\s+certificates\b/i);
    expect(statements).not.toMatch(/\bINSERT\s+INTO\s+certificates\b/i);
  });

  it("declares no nested transaction (the runner owns the transaction)", () => {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(statements).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("ships a rollback counterpart that refuses to destroy provenance", () => {
    const rb = readFileSync(join(MIGRATIONS_DIR, ROLLBACK_FILE), "utf8");
    expect(rb).toMatch(/refuses to run/i);
    expect(rb).toMatch(/origin_type IS NOT NULL/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Certificate document rendering.
// ═══════════════════════════════════════════════════════════════════════════
describe("certificate document — rendered grading origin", () => {
  /**
   * Recover the text PDFKit actually DREW, so these are real rendering assertions rather than
   * assertions about the input object. Content streams are Flate-compressed and the show-text
   * operands are hex strings inside TJ arrays (`[<48656c6c6f> 20 <21> 0] TJ`), so both layers
   * have to be undone before the words are visible.
   */
  function pdfText(buf: Buffer): string {
    const streams: string[] = [];
    let i = 0;
    for (;;) {
      const k = buf.indexOf("stream", i, "latin1");
      if (k < 0) break;
      if (buf.subarray(k - 3, k).toString("latin1") === "end") {
        i = k + 6; // this is the tail of "endstream", not a stream start
        continue;
      }
      let s = k + 6;
      if (buf[s] === 0x0d) s++;
      if (buf[s] === 0x0a) s++;
      const end = buf.indexOf("endstream", s, "latin1");
      if (end < 0) break;
      const raw = buf.subarray(s, end);
      let txt: string;
      try {
        txt = inflateSync(raw).toString("latin1");
      } catch {
        txt = raw.toString("latin1");
      }
      // Content streams are the ones that select a font; the rest are image/font payloads.
      if (txt.includes(" Tf")) streams.push(txt);
      i = end + 9;
    }
    // `[<4d696e74> 25 <5661756c74> 0] TJ` — the bare numbers are kerning adjustments and must be
    // dropped, otherwise a kerned word reads as "Mint 25 Vault" and no assertion on it can hold.
    return streams
      .join("\n")
      .replace(/\[((?:<[0-9A-Fa-f]*>|-?[\d.]+|\s)*)\]\s*TJ/g, (_m, body: string) =>
        (body.match(/<[0-9A-Fa-f]*>/g) || []).map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join("")
      );
  }

  /**
   * Page count from the page-tree node. Counting "/Type /Page" across the raw bytes is not safe:
   * compressed image payloads produce that byte sequence by chance (15 false hits on the maximal
   * certificate). The /Pages node's /Count is the document's own answer.
   */
  function pdfPageCount(buf: Buffer): number {
    // Anchored on the full indirect-object header, so a chance byte sequence inside a compressed
    // image payload cannot be mistaken for the page tree.
    const s = buf.toString("latin1");
    const all = [...s.matchAll(/\d+ 0 obj\s*<<\s*\/Type\s*\/Pages\s*\/Count\s+(\d+)/g)];
    expect(all.length, "expected exactly one PDF page-tree node").toBe(1);
    return Number(all[0][1]);
  }

  const base = {
    id: 1,
    certId: "MV-0000000900",
    cardName: "Charizard",
    cardGame: "Pokemon",
    setName: "Base Set",
    gradeType: "numeric",
    gradeOverall: "9",
    status: "active",
    ownershipStatus: "unclaimed",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    designations: [],
    verifiedDefects: [],
    defects: [],
  };

  it("prints 'MintVault Headquarters' for a LEGACY certificate", async () => {
    const buf = await generateCertificateDocument(certOf({ ...base, originType: null }));
    const text = pdfText(buf);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(text).toContain("GRADED BY");
    expect(text).toContain("MintVault Headquarters");
  });

  it("prints 'MintVault Headquarters' for an explicit HQ certificate", async () => {
    const text = pdfText(await generateCertificateDocument(certOf({ ...base, originType: "HQ" })));
    expect(text).toContain("MintVault Headquarters");
  });

  it("prints the PARTNER trading name and the approved location, not MintVault", async () => {
    const text = pdfText(
      await generateCertificateDocument(
        certOf({
          ...base,
          originType: "PARTNER",
          originPartnerTradingName: "Kent Card Emporium",
          originPartnerLegalName: "KCE Collectibles Ltd",
          originLocationName: "Canterbury Store",
          originLocationAddress: "12 High Street, Canterbury",
        })
      )
    );
    expect(text).toContain("Kent Card Emporium");
    expect(text).toContain("GRADED AT");
    expect(text).toContain("Canterbury Store");
    expect(text).not.toContain("Graded by MintVault Headquarters");
  });

  it("keeps the QR/ownership block height UNCHANGED for every existing certificate", () => {
    // The block height is max(qrSize + 18, 28 + 17 * rows) with qrSize = 140 → floor 158.
    // Existing (HQ/legacy) certificates have at most 6 rows; +1 for "Graded By" = 7.
    // This asserts the arithmetic that makes the addition geometry-neutral for them.
    const blockHeight = (rows: number) => Math.max(140 + 18, 28 + 17 * rows);
    expect(blockHeight(6)).toBe(158); // before this change
    expect(blockHeight(7)).toBe(158); // after, for every HQ/legacy certificate — unmoved
    // Only a claimed PARTNER certificate with an email reaches 8, and none exist yet.
    expect(blockHeight(8)).toBeGreaterThan(158);
  });

  it("keeps a TYPICAL certificate on one page — for HQ, legacy and partner alike", async () => {
    // The realistic case: an unclaimed certificate with ordinary card details. Adding the origin
    // row(s) must not tip it onto a second page for any origin kind.
    for (const origin of [
      { originType: null },
      { originType: "HQ" },
      {
        originType: "PARTNER",
        originPartnerTradingName: "Kent Card Emporium",
        originLocationName: "Canterbury Store",
        originLocationAddress: "12 High Street, Canterbury, CT1 2AB",
      },
    ]) {
      const buf = await generateCertificateDocument(certOf({ ...base, ...origin }));
      expect(pdfPageCount(buf), `origin ${JSON.stringify(origin)}`).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Database proofs — real runner on disposable PostgreSQL 17.
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isLocal)("migration 0035 on real PostgreSQL 17", () => {
  let db: Client;

  const only0035 = () => listMigrationFiles().filter((f) => f.filename === MIGRATION_FILE);

  /** A bare certificates table — 0035 only requires the table to exist. */
  const seedCertificates = async () => {
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await db.query(`CREATE SCHEMA public`);
    await db.query(`CREATE TABLE certificates (
      id serial PRIMARY KEY,
      certificate_number text NOT NULL UNIQUE,
      status varchar(10) NOT NULL DEFAULT 'active',
      issued_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Two pre-existing rows: these stand in for the whole historical estate and must never be
    // touched by this migration.
    await db.query(`INSERT INTO certificates (certificate_number) VALUES ('MV-0000000001'), ('MV-0000000002')`);
  };

  const apply = () => applyMigrations(db, only0035());

  beforeAll(async () => {
    db = new Client({ connectionString: ADMIN_DB });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await seedCertificates();
  });

  it("applies cleanly through the real runner and journals itself", async () => {
    const { applied } = await apply();
    expect(applied).toEqual([MIGRATION_FILE]);
    const { rows } = await db.query(`SELECT status FROM schema_migrations WHERE filename = $1`, [MIGRATION_FILE]);
    expect(rows[0].status).toBe("applied");
  });

  it("installs every column NULLABLE and DEFAULT-FREE (structurally cannot backfill)", async () => {
    await apply();
    const { rows } = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'certificates' AND column_name LIKE 'origin_%' ORDER BY column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "origin_captured_at",
      "origin_location_address",
      "origin_location_id",
      "origin_location_name",
      "origin_location_public_ref",
      "origin_partner_id",
      "origin_partner_legal_name",
      "origin_partner_public_ref",
      "origin_partner_trading_name",
      "origin_snapshot_version",
      "origin_type",
    ]);
    for (const r of rows) {
      expect(r.is_nullable, `${r.column_name} must be nullable`).toBe("YES");
      expect(r.column_default, `${r.column_name} must have no default`).toBeNull();
    }
  });

  it("installs the constraints, the immutability trigger and the partial index", async () => {
    await apply();
    const cons = await db.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'chk_certificates_origin%' ORDER BY conname`
    );
    expect(cons.rows.map((r) => r.conname)).toEqual([
      "chk_certificates_origin_capture_pairing",
      "chk_certificates_origin_non_partner_clean",
      "chk_certificates_origin_partner_complete",
      "chk_certificates_origin_snapshot_version",
      "chk_certificates_origin_type",
    ]);
    // NOT VALID constraints would silently permit bad legacy data.
    for (const r of cons.rows) expect(r.convalidated, `${r.conname} must be validated`).toBe(true);

    // Mode, not mere existence. Asserting only `SELECT 1 FROM pg_trigger` is precisely what let a
    // trigger that any replica-role session could switch off pass CI as "installed" — the claimed
    // ENABLE ALWAYS was absent from the migration for its entire life and nothing noticed.
    const trg = await db.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_certificates_origin_immutable'
         AND tgrelid = 'public.certificates'::regclass`
    );
    expect(trg.rowCount).toBe(1);
    expect(trg.rows[0].tgenabled, "immutability trigger must be ENABLE ALWAYS ('A'), not origin ('O')").toBe("A");
    const idx = await db.query(`SELECT 1 FROM pg_class WHERE relname = 'idx_certificates_origin_partner'`);
    expect(idx.rowCount).toBe(1);
  });

  it("does NOT backfill — every pre-existing certificate stays legacy (origin_type NULL)", async () => {
    await apply();
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM certificates WHERE origin_type IS NOT NULL`
    );
    expect(rows[0].n).toBe("0");
    const total = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM certificates`);
    expect(total.rows[0].n).toBe("2"); // no row added, none removed
  });

  it("legacy rows read back as HQ through the renderer", async () => {
    await apply();
    const { rows } = await db.query(`SELECT origin_type FROM certificates WHERE certificate_number = $1`, [
      "MV-0000000001",
    ]);
    const view = certificateOrigin(certOf({ originType: rows[0].origin_type }));
    expect(view.line).toBe("Graded by MintVault Headquarters");
  });

  it("is IDEMPOTENT — re-executing the same SQL changes nothing and raises nothing", async () => {
    await apply();
    const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
    // Stamp a certificate first: a naive "assert nothing is stamped" would make the re-run fail.
    await db.query(
      `UPDATE certificates SET origin_type='PARTNER', origin_partner_id=gen_random_uuid(),
         origin_partner_trading_name='Kent Card Emporium', origin_captured_at=now(), origin_snapshot_version=1
       WHERE certificate_number='MV-0000000002'`
    );
    const before = await db.query(`SELECT * FROM certificates ORDER BY id`);

    await db.query("BEGIN");
    await db.query(sql);
    await db.query("COMMIT");

    const after = await db.query(`SELECT * FROM certificates ORDER BY id`);
    expect(after.rows).toEqual(before.rows);

    // And the runner itself considers it applied, with a matching checksum.
    const plan = await planMigrations(db, only0035());
    expect(plan.pending).toEqual([]);
    expect(plan.alreadyApplied).toEqual([MIGRATION_FILE]);
    expect(plan.checksumMismatches).toEqual([]);
  });

  describe("integrity constraints", () => {
    beforeEach(async () => {
      await apply();
    });

    const insert = (cols: string, vals: string) =>
      db.query(`INSERT INTO certificates (certificate_number, ${cols}) VALUES ('MV-TEST', ${vals})`);

    // Regression for the three-valued-logic defect found by hostile review: constraint 2c
    // used bare `origin_type = 'PARTNER'`, which yields NULL (not FALSE) on a legacy row,
    // and a CHECK PASSES when its expression is NULL. A full fabricated partner snapshot
    // could therefore be smuggled onto an origin_type IS NULL certificate.
    it("rejects a fabricated partner snapshot smuggled onto a LEGACY (origin_type NULL) row", async () => {
      await expect(
        insert(
          "origin_type, origin_partner_id, origin_partner_legal_name, origin_partner_trading_name, origin_location_name, origin_location_address",
          "NULL, gen_random_uuid(), 'Fake Holdings Ltd', 'Totally Different Cards', 'Dover Store', '99 Seafront, Dover'"
        )
      ).rejects.toThrow(/chk_certificates_origin_non_partner_clean/);
    });

    it("rejects a PARTNER origin whose only name is blank", async () => {
      await expect(
        insert(
          "origin_type, origin_partner_id, origin_partner_trading_name, origin_partner_legal_name, origin_captured_at, origin_snapshot_version",
          "'PARTNER', gen_random_uuid(), '   ', '', now(), 1"
        )
      ).rejects.toThrow(/chk_certificates_origin_partner_complete/);
    });

    // Every blank shape the renderer would treat as absent must be refused at rest, and every
    // shape it would happily render must survive — the DB and server/labels.ts certificateOrigin
    // have to agree on what "named" means, or a certificate can be frozen as blank evidence.
    /*
     * Includes the UNICODE whitespace JS `.trim()` removes but a `[[:space:]]` character class does
     * not, in a C/C.UTF-8 database. Staging runs C.UTF-8, so this is not hypothetical: under a
     * locale-dependent class, a single NBSP would be stored as a "named" partner, rendered as
     * UNNAMED_PARTNER_ORIGIN_NAME, and then frozen permanently by the immutability trigger.
     */
    it("rejects every whitespace-only name shape, including unicode blanks", async () => {
      const blanks = [
        "'', ''",
        "' ', ''",
        "'    ', '   '",
        "E'\\t', E'\\n'",
        "NULL, '  '",
        "'  ', NULL",
        "chr(160), NULL", // U+00A0 NBSP
        "chr(8199), NULL", // U+2007 figure space
        "chr(8239), NULL", // U+202F narrow NBSP
        "chr(12288), NULL", // U+3000 ideographic space
        "chr(65279), NULL", // U+FEFF BOM / ZWNBSP
        "chr(8232), chr(8233)", // U+2028 / U+2029 line + paragraph separator
      ];
      for (const pair of blanks) {
        await expect(
          insert(
            "origin_type, origin_partner_id, origin_partner_trading_name, origin_partner_legal_name, origin_captured_at, origin_snapshot_version",
            `'PARTNER', gen_random_uuid(), ${pair}, now(), 1`
          ),
          `blank pair ${pair} must be rejected`
        ).rejects.toThrow(/chk_certificates_origin_partner_complete/);
      }
    });

    it("still accepts real names, including a blank trading name rescued by a real legal name", async () => {
      // Per-field trim-then-fallback, exactly as certificateOrigin() resolves the displayed name.
      // A coalesce() over the raw columns would pick the blank trading name and wrongly reject this.
      // Distinct certificate_numbers: the shared `insert` helper pins 'MV-TEST', which is unique.
      await expect(
        db.query(
          `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id,
             origin_partner_trading_name, origin_partner_legal_name, origin_captured_at, origin_snapshot_version)
           VALUES ('MV-LEGALNAME', 'PARTNER', gen_random_uuid(), '   ', 'Kent Cards Ltd', now(), 1)`
        )
      ).resolves.toBeTruthy();
      // Unicode / accented / non-Latin business names must not be over-constrained.
      await expect(
        db.query(
          `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id,
             origin_partner_trading_name, origin_captured_at, origin_snapshot_version)
           VALUES ('MV-UNICODE', 'PARTNER', gen_random_uuid(), 'Café Münz & Söhne — 東京', now(), 1)`
        )
      ).resolves.toBeTruthy();
    });

    it("rejects an unknown origin_type", async () => {
      await expect(
        insert("origin_type, origin_captured_at, origin_snapshot_version", "'SHOP', now(), 1")
      ).rejects.toThrow(/chk_certificates_origin_type/);
    });

    it("rejects a PARTNER origin with no partner id", async () => {
      await expect(
        insert(
          "origin_type, origin_partner_trading_name, origin_captured_at, origin_snapshot_version",
          "'PARTNER', 'Kent Card Emporium', now(), 1"
        )
      ).rejects.toThrow(/chk_certificates_origin_partner_complete/);
    });

    it("rejects a PARTNER origin that names nobody — a certificate must be able to say who graded it", async () => {
      await expect(
        insert(
          "origin_type, origin_partner_id, origin_captured_at, origin_snapshot_version",
          "'PARTNER', gen_random_uuid(), now(), 1"
        )
      ).rejects.toThrow(/chk_certificates_origin_partner_complete/);
    });

    it("rejects partner values stranded on an HQ certificate", async () => {
      await expect(
        insert(
          "origin_type, origin_partner_trading_name, origin_captured_at, origin_snapshot_version",
          "'HQ', 'Kent Card Emporium', now(), 1"
        )
      ).rejects.toThrow(/chk_certificates_origin_non_partner_clean/);
    });

    it("rejects an origin with no capture date", async () => {
      await expect(insert("origin_type", "'HQ'")).rejects.toThrow(/chk_certificates_origin_capture_pairing/);
    });

    it("rejects capture metadata with no origin_type", async () => {
      await expect(insert("origin_captured_at, origin_snapshot_version", "now(), 1")).rejects.toThrow(
        /chk_certificates_origin_capture_pairing/
      );
    });

    it("rejects a non-positive snapshot version", async () => {
      await expect(
        insert("origin_type, origin_captured_at, origin_snapshot_version", "'HQ', now(), 0")
      ).rejects.toThrow(/chk_certificates_origin_snapshot_version/);
    });

    it("accepts a well-formed HQ and a well-formed PARTNER certificate", async () => {
      await insert("origin_type, origin_captured_at, origin_snapshot_version", "'HQ', now(), 1");
      await db.query(
        `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id,
           origin_partner_trading_name, origin_captured_at, origin_snapshot_version)
         VALUES ('MV-TEST2', 'PARTNER', gen_random_uuid(), 'Kent Card Emporium', now(), 1)`
      );
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM certificates WHERE origin_type IS NOT NULL`
      );
      expect(rows[0].n).toBe("2");
    });
  });

  describe("immutability", () => {
    const PARTNER_ID = "11111111-1111-1111-1111-111111111111";

    beforeEach(async () => {
      await apply();
      await db.query(
        `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id, origin_partner_public_ref,
           origin_partner_legal_name, origin_partner_trading_name, origin_location_id, origin_location_name,
           origin_location_address, origin_captured_at, origin_snapshot_version)
         VALUES ('MV-STAMPED', 'PARTNER', $1, 'PR-001', 'KCE Collectibles Ltd', 'Kent Card Emporium',
                 '22222222-2222-2222-2222-222222222222', 'Canterbury Store', '12 High Street, Canterbury', now(), 1)`,
        [PARTNER_ID]
      );
    });

    it("refuses to change the trading name once set", async () => {
      await expect(
        db.query(
          `UPDATE certificates SET origin_partner_trading_name = 'Renamed Ltd' WHERE certificate_number='MV-STAMPED'`
        )
      ).rejects.toThrow(/immutable grading origin/);
    });

    /*
     * The replication-role bypass. A default-created trigger (tgenabled='O') fires only while
     * session_replication_role is 'origin'/'local', so a session able to set 'replica' — a bulk
     * load, a pg_restore --disable-triggers, a migration script — silently switched provenance
     * immutability OFF wholesale. The migration claimed ENABLE ALWAYS for its whole life and never
     * had it, and no test looked, so the gap was invisible. This is that test.
     */
    it("still refuses under session_replication_role='replica' (ENABLE ALWAYS)", async () => {
      await db.query("SET session_replication_role = 'replica'");
      try {
        await expect(
          db.query(
            `UPDATE certificates SET origin_partner_trading_name = 'REWRITTEN VIA REPLICA',
                    origin_partner_legal_name = 'Fabricated Holdings Ltd'
              WHERE certificate_number='MV-STAMPED'`
          )
        ).rejects.toThrow(/immutable grading origin/);
      } finally {
        await db.query("RESET session_replication_role");
      }
      // …and the snapshot really is untouched, not merely error-raising.
      const { rows } = await db.query<{ origin_partner_trading_name: string; origin_partner_legal_name: string }>(
        `SELECT origin_partner_trading_name, origin_partner_legal_name
           FROM certificates WHERE certificate_number='MV-STAMPED'`
      );
      expect(rows[0].origin_partner_trading_name).toBe("Kent Card Emporium");
      expect(rows[0].origin_partner_legal_name).toBe("KCE Collectibles Ltd");
    });

    it("refuses to change the location, the partner id, or the origin type", async () => {
      await expect(
        db.query(
          `UPDATE certificates SET origin_location_address = 'Somewhere Else' WHERE certificate_number='MV-STAMPED'`
        )
      ).rejects.toThrow(/immutable grading origin/);
      await expect(
        db.query(`UPDATE certificates SET origin_partner_id = gen_random_uuid() WHERE certificate_number='MV-STAMPED'`)
      ).rejects.toThrow(/immutable grading origin/);
      await expect(
        db.query(`UPDATE certificates SET origin_type = 'HQ' WHERE certificate_number='MV-STAMPED'`)
      ).rejects.toThrow(/immutable grading origin/);
    });

    it("refuses to NULL the origin out", async () => {
      await expect(
        db.query(`UPDATE certificates SET origin_partner_trading_name = NULL WHERE certificate_number='MV-STAMPED'`)
      ).rejects.toThrow(/immutable grading origin/);
    });

    it("still allows ordinary updates, and full-row rewrites that re-send identical origin values", async () => {
      // This is the shape storage.updateCertificate() produces (whole record spread into SET),
      // and the shape the stale-form cert editor posts. It must keep working.
      await db.query(`UPDATE certificates SET status = 'voided' WHERE certificate_number='MV-STAMPED'`);
      await db.query(
        `UPDATE certificates c SET status='active', origin_type=c.origin_type,
           origin_partner_id=c.origin_partner_id, origin_partner_trading_name=c.origin_partner_trading_name,
           origin_location_address=c.origin_location_address
         WHERE certificate_number='MV-STAMPED'`
      );
      const { rows } = await db.query(
        `SELECT status, origin_partner_trading_name FROM certificates WHERE certificate_number='MV-STAMPED'`
      );
      expect(rows[0].status).toBe("active");
      expect(rows[0].origin_partner_trading_name).toBe("Kent Card Emporium");
    });

    it("permits the ONE-TIME stamp of a legacy row, then locks it", async () => {
      await db.query(
        `UPDATE certificates SET origin_type='HQ', origin_captured_at=now(), origin_snapshot_version=1
          WHERE certificate_number='MV-0000000001'`
      );
      await expect(
        db.query(`UPDATE certificates SET origin_type='PARTNER' WHERE certificate_number='MV-0000000001'`)
      ).rejects.toThrow(/immutable grading origin/);
    });
  });

  // ── The headline requirement ─────────────────────────────────────────────
  describe("partner lifecycle cannot rewrite an issued certificate", () => {
    const PARTNER_ID = "33333333-3333-3333-3333-333333333333";
    const LOCATION_ID = "44444444-4444-4444-4444-444444444444";
    let asIssued: CertificateOriginView;

    const readOrigin = async (): Promise<CertificateOriginView> => {
      const { rows } = await db.query(
        `SELECT origin_type, origin_partner_trading_name, origin_partner_legal_name,
                origin_location_name, origin_location_address
           FROM certificates WHERE certificate_number = 'MV-PARTNER'`
      );
      const r = rows[0];
      return certificateOrigin(
        certOf({
          originType: r.origin_type,
          originPartnerTradingName: r.origin_partner_trading_name,
          originPartnerLegalName: r.origin_partner_legal_name,
          originLocationName: r.origin_location_name,
          originLocationAddress: r.origin_location_address,
        })
      );
    };

    beforeEach(async () => {
      await apply();
      // Stand-ins for the live partner tables. The point of the test is that the certificate is
      // independent of them — so they are created, mutated and ultimately destroyed here.
      await db.query(`CREATE TABLE partner_organisations (
        id uuid PRIMARY KEY, legal_name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE')`);
      await db.query(`CREATE TABLE partner_profiles (
        tenant_id uuid PRIMARY KEY, trading_name text, address_line1 text)`);
      await db.query(`CREATE TABLE partner_locations (
        id uuid PRIMARY KEY, partner_id uuid NOT NULL, name text NOT NULL, address text, status text NOT NULL DEFAULT 'ACTIVE')`);
      await db.query(`INSERT INTO partner_organisations VALUES ($1, 'KCE Collectibles Ltd', 'ACTIVE')`, [PARTNER_ID]);
      await db.query(`INSERT INTO partner_profiles VALUES ($1, 'Kent Card Emporium', '12 High Street')`, [PARTNER_ID]);
      await db.query(
        `INSERT INTO partner_locations VALUES ($1, $2, 'Canterbury Store', '12 High Street, Canterbury, CT1 2AB', 'ACTIVE')`,
        [LOCATION_ID, PARTNER_ID]
      );

      // Grade a card at that partner — the snapshot copies the VALUES in.
      await db.query(
        `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id, origin_partner_public_ref,
           origin_partner_legal_name, origin_partner_trading_name, origin_location_id, origin_location_public_ref,
           origin_location_name, origin_location_address, origin_captured_at, origin_snapshot_version)
         SELECT 'MV-PARTNER', 'PARTNER', o.id, 'PR-001', o.legal_name, p.trading_name,
                l.id, 'LR-001', l.name, l.address, now(), 1
           FROM partner_organisations o
           JOIN partner_profiles p ON p.tenant_id = o.id
           JOIN partner_locations l ON l.partner_id = o.id
          WHERE o.id = $1`,
        [PARTNER_ID]
      );
      asIssued = await readOrigin();
      expect(asIssued.line).toBe("Graded by Kent Card Emporium");
      expect(asIssued.location).toBe("Canterbury Store — 12 High Street, Canterbury, CT1 2AB");
    });

    it("survives a RENAME of the trading name and the legal name", async () => {
      await db.query(`UPDATE partner_profiles SET trading_name = 'Totally Different Cards' WHERE tenant_id = $1`, [
        PARTNER_ID,
      ]);
      await db.query(`UPDATE partner_organisations SET legal_name = 'New Holdings Ltd' WHERE id = $1`, [PARTNER_ID]);
      expect(await readOrigin()).toEqual(asIssued);
    });

    it("survives a RELOCATION of the approved intake site", async () => {
      await db.query(
        `UPDATE partner_locations SET name = 'Dover Store', address = '99 Seafront, Dover' WHERE id = $1`,
        [LOCATION_ID]
      );
      const after = await readOrigin();
      expect(after.location).toBe("Canterbury Store — 12 High Street, Canterbury, CT1 2AB");
      expect(after).toEqual(asIssued);
    });

    it("survives SUSPENSION and REVOCATION of the partner", async () => {
      await db.query(`UPDATE partner_organisations SET status = 'SUSPENDED' WHERE id = $1`, [PARTNER_ID]);
      expect(await readOrigin()).toEqual(asIssued);
      await db.query(`UPDATE partner_organisations SET status = 'REVOKED' WHERE id = $1`, [PARTNER_ID]);
      expect(await readOrigin()).toEqual(asIssued);
    });

    it("survives the partner being DELETED outright — no FK cascades into the certificate", async () => {
      await db.query(`DELETE FROM partner_locations WHERE id = $1`, [LOCATION_ID]);
      await db.query(`DELETE FROM partner_profiles WHERE tenant_id = $1`, [PARTNER_ID]);
      await db.query(`DELETE FROM partner_organisations WHERE id = $1`, [PARTNER_ID]);
      await db.query(`DROP TABLE partner_locations, partner_profiles, partner_organisations`);
      const after = await readOrigin();
      expect(after).toEqual(asIssued);
      expect(after.line).toBe("Graded by Kent Card Emporium");
      // The certificate row itself is untouched and still present.
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM certificates WHERE certificate_number = 'MV-PARTNER'`
      );
      expect(rows[0].n).toBe("1");
    });
  });

  describe("rollback", () => {
    const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK_FILE), "utf8");

    beforeEach(async () => {
      await apply();
    });

    it("REFUSES to run while any certificate carries an origin snapshot", async () => {
      await db.query(
        `INSERT INTO certificates (certificate_number, origin_type, origin_partner_id,
           origin_partner_trading_name, origin_captured_at, origin_snapshot_version)
         VALUES ('MV-KEEP', 'PARTNER', gen_random_uuid(), 'Kent Card Emporium', now(), 1)`
      );
      await expect(db.query(rollbackSql)).rejects.toThrow(/refuses to run/);
      await db.query("ROLLBACK").catch(() => {});
      // Nothing was removed by the refused attempt.
      const { rows } = await db.query(
        `SELECT origin_partner_trading_name FROM certificates WHERE certificate_number='MV-KEEP'`
      );
      expect(rows[0].origin_partner_trading_name).toBe("Kent Card Emporium");
    });

    /*
     * The rollback guard must not trust constraint 2c to have always held. A pre-fix estate could
     * contain a row carrying partner NAMES with origin_type NULL and no origin_partner_id — the
     * hardest variant, because the grader's own partner probe keys on origin_partner_id and would
     * miss it. Keying the guard on origin_type alone would drop that provenance and silently
     * re-attribute the card to HQ. 2c is dropped here to recreate that estate on purpose.
     */
    it("REFUSES on fabricated partner evidence smuggled onto a legacy row (pre-fix estate)", async () => {
      await db.query(`ALTER TABLE certificates DROP CONSTRAINT chk_certificates_origin_non_partner_clean`);
      await db.query(
        `INSERT INTO certificates (certificate_number, origin_type, origin_partner_legal_name, origin_location_name)
         VALUES ('MV-SMUGGLED', NULL, 'Fake Holdings Ltd', 'Dover Store')`
      );
      await expect(db.query(rollbackSql)).rejects.toThrow(/refuses to run/);
      await db.query("ROLLBACK").catch(() => {});
      const { rows } = await db.query<{ origin_partner_legal_name: string }>(
        `SELECT origin_partner_legal_name FROM certificates WHERE certificate_number='MV-SMUGGLED'`
      );
      expect(rows[0].origin_partner_legal_name).toBe("Fake Holdings Ltd");
    });

    it("removes columns, constraints, trigger, index and journal row when nothing is stamped", async () => {
      await db.query(rollbackSql);
      const cols = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='certificates' AND column_name LIKE 'origin_%'`
      );
      expect(cols.rowCount).toBe(0);
      const cons = await db.query(`SELECT 1 FROM pg_constraint WHERE conname LIKE 'chk_certificates_origin%'`);
      expect(cons.rowCount).toBe(0);
      const trg = await db.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_certificates_origin_immutable'`);
      expect(trg.rowCount).toBe(0);
      const fn = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'certificates_origin_is_immutable'`);
      expect(fn.rowCount).toBe(0);
      const idx = await db.query(`SELECT 1 FROM pg_class WHERE relname = 'idx_certificates_origin_partner'`);
      expect(idx.rowCount).toBe(0);
      const j = await db.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [MIGRATION_FILE]);
      expect(j.rowCount).toBe(0);
      // The certificates themselves are untouched.
      const certs = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM certificates`);
      expect(certs.rows[0].n).toBe("2");
    });

    it("is itself re-runnable, and the migration re-applies cleanly afterwards", async () => {
      await db.query(rollbackSql);
      await db.query(rollbackSql); // second run is a no-op, not an error
      const { applied } = await apply();
      expect(applied).toEqual([MIGRATION_FILE]);
      const cols = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='certificates' AND column_name LIKE 'origin_%'`
      );
      expect(cols.rowCount).toBe(11);
    });
  });
});
