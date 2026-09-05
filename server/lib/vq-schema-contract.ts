import { createHash } from "node:crypto";

/** Structural evidence only: never records execution or grants migration authority. */
export const VQ_BASELINE_ID = "vq-0000-0015-v1";
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
