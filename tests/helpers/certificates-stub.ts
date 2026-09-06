/**
 * A `certificates` table GENERATED FROM THE DRIZZLE SCHEMA, for disposable databases.
 *
 * WHY THIS EXISTS. Partner suites run against their own PostgreSQL 17 container and stub the
 * MintVault-internal tables by hand. That works while a suite only touches a handful of columns —
 * and stops working the moment it calls anything in the HQ layer, because `storage.getCertificate`
 * is `db.select().from(certificates)`, which names EVERY column in shared/schema.ts. One missing
 * column fails the whole query with `column "voided_at" does not exist`.
 *
 * Hand-listing ~150 columns in each suite is exactly the fixture rot this programme has already been
 * bitten by twice: the list is correct on the day it is written and silently wrong afterwards, and
 * the failure surfaces as an unrelated-looking error in a suite nobody changed. Deriving the DDL from
 * the SAME table definition the application queries means the stub cannot drift — a column added to
 * shared/schema.ts appears here automatically.
 *
 * THIS IS A TEST STUB, NOT A MIGRATION. It reproduces column NAMES and broad types so real queries
 * parse and run. It deliberately does NOT reproduce production's indexes, foreign keys or triggers;
 * suites that need a specific constraint apply the real migration that creates it (0035's origin
 * immutability, 0088's NFC uniqueness), which is what keeps those proofs honest.
 */
import { getTableColumns } from "drizzle-orm";
import type { Client } from "pg";
import { certificates } from "../../shared/schema";

/**
 * Map a Drizzle column to a PostgreSQL type.
 *
 * Deliberately permissive: the point is that real SQL parses and runs, not that every check
 * constraint is reproduced. `vector` degrades to text because pgvector is not installed on the
 * disposable PostgreSQL 17 image and no Partner suite exercises embeddings.
 */
function columnType(column: { columnType: string; dataType: string }): string {
  switch (column.columnType) {
    case "PgSerial":
      return "serial";
    case "PgInteger":
      return "integer";
    case "PgBigInt53":
    case "PgBigInt64":
      return "bigint";
    case "PgBoolean":
      return "boolean";
    case "PgNumeric":
      return "numeric";
    case "PgDoublePrecision":
      return "double precision";
    case "PgReal":
      return "real";
    case "PgTimestamp":
    case "PgTimestampString":
      return "timestamptz";
    case "PgDate":
      return "date";
    case "PgJsonb":
      return "jsonb";
    case "PgJson":
      return "json";
    case "PgUUID":
      return "uuid";
    default:
      break;
  }
  // Falls back on the broad dataType for anything unrecognised (vector, custom types, enums).
  switch (column.dataType) {
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamptz";
    case "json":
      return "jsonb";
    default:
      return "text";
  }
}

/**
 * Render a Drizzle JS-side default as a SQL literal, or null when it cannot be expressed.
 *
 * Only primitives are reproduced. A `sql\`now()\`` default or an object arrives here as something
 * that is not a primitive, and guessing at it would produce a stub that behaves differently from
 * production in a way nothing would notice — so those columns get no default and no NOT NULL, and
 * the suite supplies the value explicitly if it matters.
 */
function sqlLiteral(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return null;
}

/**
 * The generated `CREATE TABLE <name> (...)` statement for ANY Drizzle table.
 *
 * Same derivation as `certificatesStubDdl()` — which now delegates here — so a suite that needs a
 * companion table (`users`, `claim_verifications`, `ownership_history`) gets the same drift-proof
 * treatment instead of hand-listing columns that rot. Same caveat applies: NAMES and broad TYPES
 * only, no indexes, foreign keys or triggers.
 */
export function stubDdlForTable(table: Parameters<typeof getTableColumns>[0], tableName: string): string {
  const columns = Object.values(getTableColumns(table));
  const defs = columns.map((column) => {
    const c = column as unknown as {
      name: string;
      columnType: string;
      dataType: string;
      primary?: boolean;
      notNull?: boolean;
      hasDefault?: boolean;
    };
    const type = columnType(c);
    const parts = [`"${c.name}"`, type];
    if (c.primary) parts.push("primary key");
    /*
     * NOT NULL is honoured ONLY where the DEFAULT can be reproduced alongside it.
     *
     * Drizzle's `.default(...)` is a JS-side value, not SQL text, so a column emitted as NOT NULL
     * without its default rejects the very inserts production accepts — `marketing_featured` is
     * `.notNull().default(false)`, and NOT NULL alone made every certificate insert fail. Emitting
     * the pair keeps `print_state`, `grader_status`, `redo_count`, `grading_revision` and friends
     * behaving exactly as they do in production; emitting neither is the safe fallback, because a
     * fixture legitimately inserts partial rows (a walk-in card names no customer and no tier).
     */
    const literal = sqlLiteral((column as unknown as { default?: unknown }).default);
    if (literal !== null) parts.push(`default ${literal}`);
    if (c.notNull && (literal !== null || c.primary)) parts.push("not null");
    return parts.join(" ");
  });
  return `CREATE TABLE ${tableName} (\n  ${defs.join(",\n  ")}\n)`;
}

/** The generated `CREATE TABLE certificates (...)` statement. Exported so a suite can inspect it. */
export function certificatesStubDdl(): string {
  return stubDdlForTable(certificates, "certificates");
}

/**
 * Create the stub table, apply its defaults, and hand ownership to the migration role.
 *
 * Defaults are applied as a second pass because Drizzle's default values are JS-side and are not
 * recoverable as SQL text; the handful that behaviour genuinely depends on are stated explicitly
 * here, next to the reason each one matters.
 */
export async function createCertificatesStub(admin: Client, owner = "pn_migrator"): Promise<void> {
  await admin.query(certificatesStubDdl());
  /*
   * COLUMNS THE PRODUCTION TABLE HAS THAT shared/schema.ts DOES NOT MODEL.
   *
   * `mintPartnerCertificate` (card-job-authority.ts) inserts `source`, `scan_status` and
   * `raw_uploaded` through raw SQL, and the Drizzle table definition carries none of them — so the
   * generated DDL above cannot know about them. They are named here explicitly rather than silently
   * added, because the gap is worth seeing: the Drizzle definition is not a complete description of
   * the real `certificates` table, and anything derived from it is a floor, not a full picture.
   */
  await admin.query(`ALTER TABLE certificates
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS scan_status text,
    ADD COLUMN IF NOT EXISTS raw_uploaded boolean NOT NULL DEFAULT false`);
  await admin.query(`ALTER TABLE certificates
    ALTER COLUMN certificate_number SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'active',
    ALTER COLUMN label_type SET DEFAULT 'Standard',
    ALTER COLUMN grade_type SET DEFAULT 'numeric',
    ALTER COLUMN issued_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now(),
    -- The four the grading and print lifecycles genuinely read as defaults.
    ALTER COLUMN grader_status SET DEFAULT 'unassigned',
    ALTER COLUMN redo_count SET DEFAULT 0,
    ALTER COLUMN grading_revision SET DEFAULT 1,
    ALTER COLUMN print_state SET DEFAULT 'awaiting_approval',
    ALTER COLUMN ownership_status SET DEFAULT 'unclaimed',
    ALTER COLUMN nfc_scan_count SET DEFAULT 0`);
  // `certificate_number` is UNIQUE in production and several proofs depend on it — a duplicate MV is
  // one of the invariants under test, so this one constraint is reproduced rather than assumed.
  await admin.query(`ALTER TABLE certificates ADD CONSTRAINT certificates_certificate_number_key
    UNIQUE (certificate_number)`);
  // The PARTNER-origin completeness CHECK from 0035. Reproduced because Scanner NEW's origin snapshot
  // is written against it, so a suite that omitted it would not be exercising the real insert.
  await admin.query(`ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_partner_complete CHECK (
    origin_type IS DISTINCT FROM 'PARTNER'
    OR (origin_partner_id IS NOT NULL
        AND (btrim(coalesce(origin_partner_trading_name,'')) <> ''
             OR btrim(coalesce(origin_partner_legal_name,'')) <> '')
        AND origin_captured_at IS NOT NULL
        AND origin_snapshot_version IS NOT NULL)
  )`);
  await admin.query(`ALTER TABLE certificates OWNER TO ${owner}`);
}
