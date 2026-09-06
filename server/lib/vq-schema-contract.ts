import { createHash } from "node:crypto";

/** Structural evidence only: never records execution or grants migration authority. */
export const VQ_BASELINE_ID = "vq-0000-0015-v1";
export const VQ_BASELINE_AUTHORITY_FILE = "0016_schema_baseline_authority.sql";
// Observed identically from immutable SQL on owned PostgreSQL16.13 and17.10.
export const VQ_BASELINE_FINGERPRINT = "9aeaa1c206ffd26372274b4e223a609b801e459e89282a77a41a2d6d8b82cf52";
export const VQ_BASELINE_MIGRATION_SET_SHA256 = "d92f083e1f119dc89724e08e6b36143256be627ba533be414146414c963aa90a";
export const VQ_BASELINE_RELATIONS = Object.freeze([
  "vq_ai_generations",
  "vq_artwork_candidates",
  "vq_artwork_revision_events",
  "vq_artwork_revisions",
  "vq_asset_library",
  "vq_card_revisions",
  "vq_cards",
  "vq_character_revisions",
  "vq_characters",
  "vq_config",
  "vq_elements",
  "vq_export_jobs",
  "vq_families",
  "vq_family_rules",
  "vq_feature_flags",
  "vq_game_config",
  "vq_generation_requests",
  "vq_pack_config",
  "vq_packaging_items",
  "vq_print_exports",
  "vq_production_stages",
  "vq_qa_checks",
  "vq_release_state",
  "vq_releases",
  "vq_set_settings",
  "vq_sets",
] as const);

// No row contents, sequence current values, role names, credentials or relation OIDs.
// Stable object names and ordered structural arrays make the evidence portable.
// VQ control metadata lives outside public; an unexpected public table must differ.
export const VQ_SCHEMA_CATALOG_SQL = `
WITH relations AS (
  SELECT c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND left(c.relname, 3) = 'vq_'
     AND c.relkind IN ('r','p','v','m','f')
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'name', r.relname, 'kind', r.relkind, 'persistence', r.relpersistence,
  'rls', r.relrowsecurity, 'forceRls', r.relforcerowsecurity,
  'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', a.attname, 'position', a.attnum, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
    'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
    'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
    'collation', CASE WHEN co.oid IS NULL THEN NULL ELSE cn.nspname || '.' || co.collname END
  ) ORDER BY a.attnum), '[]'::jsonb)
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
   WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', k.conname, 'type', k.contype, 'definition', pg_catalog.pg_get_constraintdef(k.oid),
    'validated', k.convalidated, 'deferrable', k.condeferrable, 'deferred', k.condeferred
  ) ORDER BY k.conname), '[]'::jsonb) FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
  'indexes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', ic.relname, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid),
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive, 'unique', i.indisunique, 'primary', i.indisprimary
  ) ORDER BY ic.relname), '[]'::jsonb)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
  'sequences', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', sc.relname, 'column', a.attname, 'type', pg_catalog.format_type(s.seqtypid,NULL),
    'start', s.seqstart, 'increment', s.seqincrement, 'minimum', s.seqmin,
    'maximum', s.seqmax, 'cache', s.seqcache, 'cycle', s.seqcycle
  ) ORDER BY sc.relname), '[]'::jsonb)
    FROM pg_catalog.pg_depend dep JOIN pg_catalog.pg_class sc ON sc.oid=dep.objid
    JOIN pg_catalog.pg_namespace sn ON sn.oid=sc.relnamespace
    JOIN pg_catalog.pg_sequence s ON s.seqrelid=sc.oid
    JOIN pg_catalog.pg_attribute a ON a.attrelid=dep.refobjid AND a.attnum=dep.refobjsubid
   WHERE dep.classid='pg_catalog.pg_class'::regclass AND dep.refclassid='pg_catalog.pg_class'::regclass
     AND dep.refobjid=r.oid AND dep.deptype IN ('a','i') AND sn.nspname='public'),
  'triggers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', t.tgname, 'definition', pg_catalog.pg_get_triggerdef(t.oid), 'enabled', t.tgenabled
  ) ORDER BY t.tgname), '[]'::jsonb) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid AND NOT t.tgisinternal),
  'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', p.polname, 'command', p.polcmd, 'permissive', p.polpermissive,
    'using', pg_catalog.pg_get_expr(p.polqual,p.polrelid),
    'check', pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
  ) ORDER BY p.polname), '[]'::jsonb) FROM pg_catalog.pg_policy p WHERE p.polrelid=r.oid)
) ORDER BY r.relname), '[]'::jsonb) AS catalog FROM relations r`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Invalid VQ schema catalog value");
  }
  return JSON.stringify(value);
}

export function vqSchemaFingerprint(catalog: unknown): string {
  if (!Array.isArray(catalog)) throw new Error("VQ schema catalog must be an array");
  return createHash("sha256").update(canonical(catalog)).digest("hex");
}

/** Release expectations from shipped SQL, not evidence that a database executed it.
 * The source-binding regression requires deliberate review of any future inventory change. */
export const VQ_RUNTIME_MIGRATIONS = Object.freeze(
  [
    ["0000_next_mister_fear.sql", "60f8f33892af3ac17bf655abedfa738640fb533e26a85b2dc59678cc9e5a116b"],
    ["0001_equal_iron_fist.sql", "fe8593c6892a96b1c23eddd301ebbc34a1fb93acd079e4329128bc584625b83a"],
    ["0002_blushing_overlord.sql", "349768bc6fbec8ec985ed45d63fa61a6089c816612f5fb9c7a09b32b120d9794"],
    ["0003_character_bible.sql", "1f5dbbfa88a3b6bb1988869c0eefba94663f72d601c4b8e7feba376709a0d06d"],
    ["0004_reference_pack.sql", "77819cf686d6aae4cdc92a22cc87b50cb40e6fc082142fde71893c0db7e3aa26"],
    ["0005_identity_score.sql", "6630614731470e46850d62155c6da7e00f47c1be8e40296afec6cd0173eb0479"],
    ["0006_description_status.sql", "10181eb21e268cba90abe2238a8a52282c897e02a071cbbaaa3bbb6141ba7562"],
    ["0007_production_studio.sql", "15e584b05face7df6be3f913b6691b14eab5758fa4fa059746f43b2e7ebfa321"],
    ["0008_export_jobs.sql", "cd4f2bb1667c75865a499fde9c28f8e80e24752e135540c2b6ea0517ba987808"],
    ["0009_generation_requests.sql", "a17116bf4172b5f10c15a7e4ecf62edb5421d9560802eb65e1348e4a42e2f3f0"],
    ["0010_artwork_revisions.sql", "7c76b3f2d9d6f77482d348e8b18733d6f2d7255bf4f37fe3ac19db8f0176810d"],
    ["0011_feature_flags.sql", "25c0bdc2824d3a032c34bbd180a9b43ce37760a8f32f8e5a2d612ec98ac915c1"],
    ["0012_export_job_payload.sql", "e580371eab1414f52ebf1ba0a0094d5422b60d8671c0d37b35dd8ffd4f18a488"],
    ["0013_vq_config.sql", "592fa277248dd596915b6ce438bc157be53c742483b4a74a8020a33d0a755ac1"],
    ["0014_artwork_revision_events.sql", "98ac4d21adb8b6ae59349ae4d4cf1a15c76f70ed48448a4d31bfffa5c83d4244"],
    ["0015_feature_flags_generation_types.sql", "f5eb672c08938969ad1fc2ded107d3aeb76c6c7176ebad3d29dcdd2b5a79995f"],
    ["0016_schema_baseline_authority.sql", "fbc741ee9356f7c30f44bee7d4e99ce8f0a1048d5522aa2be7130349abc175c6"],
  ].map(([filename, checksum]) => Object.freeze({ filename, checksum }))
);

function evidenceRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Pure, unused admission predicate. Observation must come from one real runtime
 * query, never migration credentials, inferred history, cached success or defaults.
 * `completed`/`observed` are explicit SQL non-null predicates, not coerced timestamps. */
export function evaluateVqRuntimeEvidence(evidence: unknown): {
  readonly ready: boolean;
  readonly lineage: "fresh" | "historical" | null;
} {
  const denied = { ready: false, lineage: null } as const;
  if (
    !evidenceRecord(evidence, [
      "journalPresent",
      "receiptPresent",
      "catalogFingerprint",
      "runtimeAuthorityReady",
      "journal",
      "receipts",
    ]) ||
    evidence.journalPresent !== true ||
    evidence.receiptPresent !== true ||
    evidence.catalogFingerprint !== VQ_BASELINE_FINGERPRINT ||
    evidence.runtimeAuthorityReady !== true ||
    !Array.isArray(evidence.journal) ||
    !Array.isArray(evidence.receipts)
  )
    return denied;

  const journal = new Map<string, string>();
  for (const row of evidence.journal) {
    if (
      !evidenceRecord(row, ["filename", "checksum", "status", "completed"]) ||
      typeof row.filename !== "string" ||
      typeof row.checksum !== "string" ||
      row.status !== "applied" ||
      row.completed !== true ||
      journal.has(row.filename)
    )
      return denied;
    journal.set(row.filename, row.checksum);
  }

  if (evidence.receipts.length === 0) {
    return journal.size === VQ_RUNTIME_MIGRATIONS.length &&
      VQ_RUNTIME_MIGRATIONS.every((file) => journal.get(file.filename) === file.checksum)
      ? { ready: true, lineage: "fresh" }
      : denied;
  }
  if (evidence.receipts.length !== 1) return denied;
  const receipt = evidence.receipts[0];
  if (
    !evidenceRecord(receipt, [
      "baseline_id",
      "evidence_kind",
      "source_sha256",
      "schema_sha256",
      "observed",
      "observer",
    ]) ||
    receipt.baseline_id !== VQ_BASELINE_ID ||
    receipt.evidence_kind !== "observed_schema-v1" ||
    receipt.source_sha256 !== VQ_BASELINE_MIGRATION_SET_SHA256 ||
    receipt.schema_sha256 !== VQ_BASELINE_FINGERPRINT ||
    receipt.observed !== true ||
    typeof receipt.observer !== "string" ||
    receipt.observer.trim() === ""
  )
    return denied;
  const forward = VQ_RUNTIME_MIGRATIONS.filter((file) => Number(file.filename.slice(0, 4)) >= 16);
  return journal.size === forward.length && forward.every((file) => journal.get(file.filename) === file.checksum)
    ? { ready: true, lineage: "historical" }
    : denied;
}

export const VQ_APPEND_ONLY_RELATIONS = Object.freeze([
  "vq_artwork_revision_events",
  "vq_card_revisions",
  "vq_character_revisions",
] as const);

/** One coherent read-only observation. Missing/unreadable metadata throws; callers
 * must fail closed. LIMITs retain one excess row, never truncate excess into PASS.
 * Privilege arrays use actual ACL vocabulary, including unknown future privileges. */
export const VQ_RUNTIME_EVIDENCE_SQL = `
WITH catalog_evidence AS (${VQ_SCHEMA_CATALOG_SQL}), app_role AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname='mintvault_app'
), login_role AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname=current_user
), business AS (
  SELECT name, to_regclass('public.' || name) AS oid,
    CASE WHEN name=ANY(ARRAY[${VQ_APPEND_ONLY_RELATIONS.map((name) => `'${name}'`).join(",")}])
      THEN ARRAY['INSERT','SELECT']::text[] ELSE ARRAY['INSERT','SELECT','UPDATE']::text[] END AS privileges
  FROM unnest(ARRAY[${VQ_BASELINE_RELATIONS.map((name) => `'${name}'`).join(",")}]) AS wanted(name)
), owned_sequences AS (
  SELECT DISTINCT s.oid FROM pg_catalog.pg_class s
  JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
  JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
    AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')
  JOIN business b ON b.oid=d.refobjid WHERE n.nspname='public' AND s.relkind='S'
), wanted_objects AS (
  SELECT oid, 'r'::"char" AS kind, privileges FROM business
  UNION ALL SELECT oid, 'S'::"char", ARRAY['SELECT','USAGE']::text[] FROM owned_sequences
  UNION ALL SELECT to_regclass('drizzle.vq_schema_migrations'), 'r'::"char", ARRAY['SELECT']::text[]
  UNION ALL SELECT to_regclass('drizzle.vq_schema_baselines'), 'r'::"char", ARRAY['SELECT']::text[]
  UNION ALL SELECT to_regclass('drizzle.vq_schema_migrations_id_seq'), 'S'::"char", ARRAY[]::text[]
), objects AS (
  SELECT w.oid, w.kind, w.privileges, c.relacl, c.relkind FROM wanted_objects w
  LEFT JOIN pg_catalog.pg_class c ON c.oid=w.oid
), journal AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum,
    'status',status,'completed',completed_at IS NOT NULL) ORDER BY filename),'[]'::jsonb) AS value
  FROM (SELECT filename,checksum,status,completed_at FROM drizzle.vq_schema_migrations ORDER BY filename LIMIT ${VQ_RUNTIME_MIGRATIONS.length + 1}) bounded
), receipts AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('baseline_id',baseline_id,'evidence_kind',evidence_kind,
    'source_sha256',source_sha256,'schema_sha256',schema_sha256,
    'observed',observed_at IS NOT NULL,'observer',observed_by) ORDER BY baseline_id),'[]'::jsonb) AS value
  FROM (SELECT baseline_id,evidence_kind,source_sha256,schema_sha256,observed_at,observed_by
    FROM drizzle.vq_schema_baselines ORDER BY baseline_id LIMIT 2) bounded
), authority AS (
  SELECT EXISTS (
    SELECT 1 FROM app_role app WHERE NOT app.rolcanlogin AND NOT app.rolinherit
      AND NOT app.rolsuper AND NOT app.rolbypassrls AND NOT app.rolcreatedb
      AND NOT app.rolcreaterole AND NOT app.rolreplication
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=app.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=app.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=app.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=app.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=app.oid)
  ) AND (SELECT bool_and(o.oid IS NOT NULL AND o.relkind=o.kind AND
    COALESCE((SELECT array_agg(a.privilege_type ORDER BY a.privilege_type)
      FROM aclexplode(o.relacl) a WHERE a.grantee=(SELECT oid FROM app_role) AND NOT a.is_grantable),ARRAY[]::text[])
      IS NOT DISTINCT FROM o.privileges
    AND NOT EXISTS(SELECT 1 FROM aclexplode(o.relacl) a WHERE a.grantee=0
      OR (a.grantee=(SELECT oid FROM app_role) AND a.is_grantable))
  ) FROM objects o) IS TRUE
  AND COALESCE(to_regclass('public.vq_schema_migrations'),to_regclass('public.vq_schema_baselines'),
    to_regclass('public.vq_schema_migrations_id_seq')) IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
    WHERE c.attrelid IN (SELECT oid FROM objects) AND c.attnum>0 AND NOT c.attisdropped
      AND a.grantee IN (0,(SELECT oid FROM app_role)))
  AND has_schema_privilege((SELECT oid FROM app_role),'drizzle','USAGE') IS TRUE
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='drizzle'
    AND (SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM aclexplode(n.nspacl) a
      WHERE a.grantee=(SELECT oid FROM app_role) AND NOT a.is_grantable)=ARRAY['USAGE']::text[]
    AND NOT EXISTS(SELECT 1 FROM aclexplode(n.nspacl) a
      WHERE a.grantee=(SELECT oid FROM app_role) AND a.is_grantable))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
    WHERE n.nspname IN ('public','drizzle') AND a.grantee IN (0,(SELECT oid FROM app_role)) AND a.privilege_type='CREATE')
  AND ($1::boolean IS NOT TRUE OR EXISTS (
    SELECT 1 FROM login_role login WHERE login.rolcanlogin AND login.rolinherit
      AND NOT login.rolsuper AND NOT login.rolbypassrls AND NOT login.rolcreatedb
      AND NOT login.rolcreaterole AND NOT login.rolreplication
      AND pg_has_role(login.oid,(SELECT oid FROM app_role),'USAGE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=login.oid
        AND (m.roleid<>(SELECT oid FROM app_role) OR m.admin_option))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=login.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=login.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=login.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=login.oid)
      AND NOT has_schema_privilege(login.oid,'public','CREATE')
      AND NOT has_schema_privilege(login.oid,'drizzle','CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        WHERE n.nspname='drizzle' AND a.grantee=login.oid)
      AND NOT EXISTS(SELECT 1 FROM objects o CROSS JOIN LATERAL aclexplode(o.relacl) a WHERE a.grantee=login.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
        WHERE c.attrelid IN (SELECT oid FROM objects) AND c.attnum>0 AND NOT c.attisdropped AND a.grantee=login.oid)
      AND (SELECT bool_and(CASE WHEN o.kind='S'
        THEN has_sequence_privilege(login.oid,o.oid,p.name) IS NOT DISTINCT FROM (p.name=ANY(o.privileges))
        ELSE has_table_privilege(login.oid,o.oid,p.name) IS NOT DISTINCT FROM (p.name=ANY(o.privileges)) END)
        FROM objects o CROSS JOIN LATERAL unnest(CASE WHEN o.kind='S'
          THEN ARRAY['SELECT','USAGE','UPDATE']::text[]
          ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[] END) p(name)
      ) IS TRUE
  )) AS ready
)
SELECT catalog_evidence.catalog, journal.value AS journal, receipts.value AS receipts,
  to_regclass('drizzle.vq_schema_migrations') IS NOT NULL AS "journalPresent",
  to_regclass('drizzle.vq_schema_baselines') IS NOT NULL AS "receiptPresent",
  authority.ready AS "runtimeAuthorityReady"
FROM catalog_evidence,journal,receipts,authority`;

/** Uses only the supplied runtime connection; never falls back to migration authority. */
export async function checkVqRuntimeReadiness(
  queryable: { query: (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }> },
  production: boolean
): Promise<{ ready: boolean; queryFailed: boolean }> {
  try {
    const result = await queryable.query(VQ_RUNTIME_EVIDENCE_SQL, [production]);
    if (result.rows.length !== 1 || !result.rows[0] || typeof result.rows[0] !== "object") {
      return { ready: false, queryFailed: true };
    }
    const { catalog, ...evidence } = result.rows[0] as Record<string, unknown>;
    const observation = evaluateVqRuntimeEvidence({ ...evidence, catalogFingerprint: vqSchemaFingerprint(catalog) });
    return { ready: observation.ready, queryFailed: false };
  } catch {
    return { ready: false, queryFailed: true };
  }
}
