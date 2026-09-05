import { createHash } from "node:crypto";
import { lintSql, unapprovedBlockingFindings } from "./lint-destructive-sql";
import type { PgClientLike, MigrationFile, JournalRow } from "./migrate";
import {
  VQ_BASELINE_ID,
  VQ_BASELINE_AUTHORITY_FILE,
  VQ_BASELINE_FINGERPRINT,
  VQ_BASELINE_MIGRATION_SET_SHA256,
  VQ_BASELINE_RELATIONS,
  VQ_SCHEMA_CATALOG_SQL,
  vqSchemaFingerprint,
} from "../../server/lib/vq-schema-contract";

export async function assertFreshVq(client: PgClientLike): Promise<void> {
  const objects = await client.query(`SELECT
    to_regclass('drizzle.vq_schema_baselines') AS receipt,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND left(c.relname,3)='vq_' AND c.relkind IN ('r','p','v','m','f')) AS business`);
  if (objects.rows[0]?.receipt != null || objects.rows[0]?.business !== false) {
    throw new Error(
      "Vault Quest has unjournalled business/control state; use verified historical-baseline-v1, never replay old SQL."
    );
  }
}

function vqBaselineFiles(files: MigrationFile[]): MigrationFile[] {
  const base = files.filter((file) => Number(file.number) <= 15);
  const digest = createHash("sha256")
    .update(base.map((file) => `${file.filename}:${file.checksum}`).join("\n"))
    .digest("hex");
  if (base.length !== 16 || digest !== VQ_BASELINE_MIGRATION_SET_SHA256) {
    throw new Error("Vault Quest historical source inventory differs from the pinned immutable baseline.");
  }
  return base;
}

async function assertVqBaselineShape(
  client: PgClientLike
): Promise<Array<{ name: string; sequences: Array<{ name: string }> }>> {
  const result = await client.query(VQ_SCHEMA_CATALOG_SQL);
  if (vqSchemaFingerprint(result.rows[0]?.catalog) !== VQ_BASELINE_FINGERPRINT) {
    throw new Error("Vault Quest schema does not match the verified historical baseline; no adoption is permitted.");
  }
  return result.rows[0].catalog as Array<{ name: string; sequences: Array<{ name: string }> }>;
}

export async function attestedVqFiles(
  client: PgClientLike,
  files: MigrationFile[],
  journal: Map<string, JournalRow>
): Promise<string[]> {
  const existence = await client.query("SELECT to_regclass('drizzle.vq_schema_baselines') AS receipt");
  const authority = files.find((file) => file.filename === VQ_BASELINE_AUTHORITY_FILE);
  const authorityRow = journal.get(VQ_BASELINE_AUTHORITY_FILE);
  if (existence.rows[0]?.receipt == null) {
    if (authorityRow) throw new Error("Vault Quest authority journal is missing its receipt table.");
    return [];
  }
  const receipt = await client.query(
    "SELECT baseline_id, evidence_kind, source_sha256, schema_sha256 FROM drizzle.vq_schema_baselines"
  );
  if (receipt.rows.length === 0) {
    if (
      !authority ||
      authorityRow?.status !== "applied" ||
      authorityRow.checksum !== authority.checksum ||
      vqBaselineFiles(files).some(
        (file) =>
          journal.get(file.filename)?.status !== "applied" || journal.get(file.filename)?.checksum !== file.checksum
      )
    ) {
      throw new Error("Vault Quest empty receipt requires the complete executed fresh baseline.");
    }
    return [];
  }
  const row = receipt.rows[0];
  if (
    receipt.rows.length !== 1 ||
    row.baseline_id !== VQ_BASELINE_ID ||
    row.evidence_kind !== "observed_schema-v1" ||
    row.source_sha256 !== VQ_BASELINE_MIGRATION_SET_SHA256 ||
    row.schema_sha256 !== VQ_BASELINE_FINGERPRINT ||
    !authority ||
    journal.get(authority.filename)?.status !== "applied" ||
    journal.get(authority.filename)?.checksum !== authority.checksum
  ) {
    throw new Error("Vault Quest historical receipt or authority journal is inconsistent.");
  }
  const base = vqBaselineFiles(files);
  const completion = await client.query(
    "SELECT completed_at IS NOT NULL AS complete FROM drizzle.vq_schema_migrations WHERE filename=$1",
    [VQ_BASELINE_AUTHORITY_FILE]
  );
  if (completion.rows.length !== 1 || completion.rows[0]?.complete !== true)
    throw new Error("Vault Quest historical authority journal is incomplete.");
  if (base.some((file) => journal.has(file.filename)))
    throw new Error("Vault Quest refuses mixed executed/attested baseline history.");
  const forward = files.filter((file) => Number(file.number) >= 16);
  let gap = false;
  for (const file of forward) {
    const entry = journal.get(file.filename);
    if (!entry) gap = true;
    else if (gap || entry.status !== "applied" || entry.checksum !== file.checksum)
      throw new Error("Vault Quest forward journal chain is inconsistent.");
  }
  if ([...journal.keys()].some((name) => !forward.some((file) => file.filename === name)))
    throw new Error("Vault Quest historical journal contains an unknown execution identity.");
  if (journal.size === 1) await assertVqBaselineShape(client);
  return base.map((file) => file.filename);
}

export async function applyHistoricalVq(
  client: PgClientLike,
  files: MigrationFile[],
  mechanics: {
    assertLockOwned: (stage: string) => Promise<void>;
    journalExists: () => Promise<boolean>;
    ensureJournal: () => Promise<void>;
  }
): Promise<{ applied: string[] }> {
  vqBaselineFiles(files);
  const authority = files.find((file) => file.filename === VQ_BASELINE_AUTHORITY_FILE);
  if (
    !authority ||
    authority.noTransaction ||
    unapprovedBlockingFindings(authority.filename, authority.sql, lintSql(authority.sql)).length
  ) {
    throw new Error("Vault Quest baseline authority migration is missing or unsafe.");
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    if (await mechanics.journalExists()) throw new Error("Historical baseline requires absent VQ control metadata.");
    const prerequisite = await client.query(
      "SELECT to_regclass('drizzle.vq_schema_baselines') AS receipt, EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mintvault_app') AS role"
    );
    if (prerequisite.rows[0]?.receipt != null || prerequisite.rows[0]?.role !== true)
      throw new Error("Historical baseline requires absent receipt and existing main runtime role.");
    // Closed compile-time names, not CLI/browser input. Keep DDL from changing the
    // observed base before the atomic receipt and execution record commit.
    await client.query(
      `LOCK TABLE ${VQ_BASELINE_RELATIONS.map((name) => `public.${name}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`
    );
    const catalog = await assertVqBaselineShape(client);
    for (const relation of catalog) {
      for (const sequence of relation.sequences) {
        if (!/^[a-z_][a-z0-9_]*$/.test(sequence.name)) throw new Error("Unexpected baseline sequence identifier.");
        // Parent SHARE ROW EXCLUSIVE locks prevent a table ownership transfer.
        // Owned sequences cannot transfer owners independently. Reasserting that
        // same owner takes the sequence DDL lock without changing its parameters,
        // ownership or values (SET SCHEMA is forbidden for owned sequences).
        const ownership = await client.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=to_regclass($1) AND relkind='S'",
          [`public.${sequence.name}`]
        );
        const owner = ownership.rows[0]?.owner;
        if (ownership.rows.length !== 1 || typeof owner !== "string" || !owner)
          throw new Error("Cannot prove baseline sequence owner.");
        await client.query(`ALTER SEQUENCE public.${sequence.name} OWNER TO "${owner.replaceAll('"', '""')}"`);
      }
    }
    // A parameter could have changed while a sequence lock was being acquired.
    await assertVqBaselineShape(client);
    await mechanics.assertLockOwned("historical baseline");
    await mechanics.ensureJournal();
    await client.query(authority.sql);
    await client.query(
      "INSERT INTO drizzle.vq_schema_baselines (baseline_id,evidence_kind,source_sha256,schema_sha256) VALUES ($1,'observed_schema-v1',$2,$3)",
      [VQ_BASELINE_ID, VQ_BASELINE_MIGRATION_SET_SHA256, VQ_BASELINE_FINGERPRINT]
    );
    await client.query(
      "INSERT INTO drizzle.vq_schema_migrations (filename,checksum,status,completed_at) VALUES ($1,$2,'applied',now())",
      [authority.filename, authority.checksum]
    );
    await client.query("COMMIT");
    return { applied: [authority.filename] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
