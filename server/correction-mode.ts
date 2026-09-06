import crypto from "node:crypto";
import type { Express as ExpressApp } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireSuperAdmin } from "./auth";
import { upload } from "./lib/multer-configs";
import { uploadMemoryAdmission } from "./lib/upload-memory-admission";
import { normalizeCertId } from "./lib/cert-id";
import { SUMMARIZED_AUDIT_FIELDS, CORRECTION_DISPLAY_EXCLUDED_FIELDS } from "./lib/correction-fields";
import { uploadToR2 } from "./r2";
import { isNonNumericGrade, isValidNumericGrade } from "@shared/schema";

const CORRECTION_ACTION = "cert_live_record_edit";
const MAX_AUDIT_DETAILS_BYTES = 64 * 1024;

/** Compact, bounded descriptor of a value's shape — never its contents. */
function shapeSummary(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value as Record<string, unknown>).length})`;
  const s = String(value);
  return s.length > 64 ? `${typeof value}(len ${s.length})` : s;
}
const HUMAN_FIELD_ORDER = [
  "cardName",
  "setName",
  "year",
  "cardNumber",
  "variant",
  "rarity",
  "language",
  "game",
  "collection",
  "grade",
  "centering",
  "corners",
  "edges",
  "surface",
  "defects",
  "defectCandidates",
  "authStatus",
  "authNotes",
  "gradeExplanation",
  "darkBorder",
  "frontImage",
  "backImage",
];

type UploadedSide = "front" | "back";
type CandidateValue = string | number | boolean | null | unknown[] | Record<string, unknown>;

type CorrectionInput = {
  certId: number;
  actor: string;
  expectedVersion: string;
  metadata: Record<string, unknown>;
  grading: Record<string, unknown>;
  images: Partial<Record<UploadedSide, { key: string; originalName: string; mimeType: string; size: number }>>;
};

export type CorrectionChange = { field: string; before: unknown; after: unknown };

function valueOf(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw[raw.length - 1];
  return raw;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const raw = valueOf(body[key]);
  if (raw == null) return "";
  return String(raw).trim();
}

function nullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = stringField(body, key);
  if (value === undefined) return undefined;
  return value === "" ? null : value;
}

function requiredString(body: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = stringField(body, key);
  if (value === undefined) return undefined;
  if (!value) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return value;
}

function parseJsonField(raw: unknown): unknown {
  const value = valueOf(raw);
  if (typeof value !== "string") return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    // Client-supplied malformed JSON is a 400, not a 500. Without this it surfaced as an
    // untyped SyntaxError, was logged via the >=500 branch as a server fault, and returned
    // a misleading status to the caller.
    throw Object.assign(new Error("Invalid JSON in correction payload"), { status: 400 });
  }
}

function parseBodyJson(body: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!(key in body)) return {};
  const parsed = parseJsonField(body[key]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseDesignations(raw: unknown, fallback: unknown): string[] {
  if (raw === undefined) return Array.isArray(fallback) ? fallback.map(String) : [];
  const parsed = parseJsonField(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function toVersion(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Columns backed by a Postgres numeric type. ONLY these get numeric normalisation when
 * comparing old vs new, because the driver returns numerics as strings ("8.50") while the
 * client sends "8.5" — without normalisation every save would look like a change.
 *
 * Applying that coercion to text columns (as an earlier revision did) is a data-integrity
 * bug: Number("007") === Number("7"), so correcting a card number from "7" to "007" was
 * silently classified as a no-op — the endpoint returned ok:true, wrote nothing, and
 * recorded no audit row. Text fields must compare as text.
 */
const NUMERIC_COMPARE_FIELDS = new Set([
  "grade",
  "centering",
  "corners",
  "edges",
  "surface",
  "creaseSpanPct",
  "eyeAppealModifier",
]);

function stable(value: unknown, field?: string): string {
  if (value == null) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    if (field !== undefined && !NUMERIC_COMPARE_FIELDS.has(field)) return value;
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) return String(n);
    return value;
  }
  return JSON.stringify(value);
}

function asDecimal(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  const s = String(value);
  if (s === "AA" || s === "NO") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !isValidNumericGrade(n)) throw new Error(`${field} must be a valid MVGS grade`);
  return n.toFixed(1);
}

function asOptionalDecimal(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  return asDecimal(value, field);
}

function asJson(value: unknown): CandidateValue | undefined {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value as Record<string, unknown>;
  return value as string | number | boolean;
}

function asBool(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return undefined;
}

function clampEyeAppeal(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-2, Math.min(2, Math.trunc(n)));
}

function buildMetadata(body: Record<string, unknown>, current: Record<string, unknown>) {
  const out: Record<string, CandidateValue> = {};
  const assign = (field: string, value: CandidateValue | undefined) => {
    if (value !== undefined) out[field] = value;
  };

  assign("game", requiredString(body, "cardGame", "Game"));
  assign("setName", requiredString(body, "setName", "Set"));
  assign("cardName", requiredString(body, "cardName", "Card name"));
  assign("cardNumber", requiredString(body, "cardNumber", "Card number"));
  assign("rarity", nullableString(body, "rarity"));
  assign("rarityOther", nullableString(body, "rarityOther"));
  assign("variant", nullableString(body, "variant"));
  assign("variantOther", nullableString(body, "variantOther"));
  assign("collectionCode", nullableString(body, "collectionCode"));
  assign("collectionOther", nullableString(body, "collectionOther"));
  assign("language", stringField(body, "language") || undefined);
  assign("year", requiredString(body, "year", "Year"));
  assign("notes", nullableString(body, "notes"));
  assign(
    "designations",
    "designations" in body ? parseDesignations(body.designations, current.designations) : undefined
  );

  const gradeType = stringField(body, "gradeType");
  if (gradeType !== undefined) {
    const cleanGradeType = gradeType || "numeric";
    assign("gradeType", cleanGradeType);
    if (isNonNumericGrade(cleanGradeType)) assign("grade", null);
  }
  if ("gradeOverall" in body && !isNonNumericGrade(String(out.gradeType ?? current.grade_type ?? "numeric"))) {
    assign("grade", asDecimal(valueOf(body.gradeOverall), "grade"));
  }

  const finalVariant = out.variant !== undefined ? out.variant : current.variant;
  const finalRarity = out.rarity !== undefined ? out.rarity : current.rarity;
  if (finalVariant && finalVariant !== "NONE" && finalRarity && finalRarity !== "OTHER") {
    throw Object.assign(new Error("Card cannot have both rarity and variant selected"), { status: 400 });
  }
  const finalCollectionCode = out.collectionCode !== undefined ? out.collectionCode : current.collection_code;
  const finalCollectionOther = out.collectionOther !== undefined ? out.collectionOther : current.collection_other;
  if (finalCollectionCode === "OTHER" && !finalCollectionOther) {
    throw Object.assign(new Error("Collection 'Other (manual)' requires a manual entry value"), { status: 400 });
  }

  return out;
}

function buildGrading(body: Record<string, unknown>) {
  const out: Record<string, CandidateValue> = {};
  const assign = (field: string, value: CandidateValue | undefined) => {
    if (value !== undefined) out[field] = value;
  };
  const overall = body.overall_grade;
  const nonNumeric = overall === "AA" || overall === "NO";
  if (overall !== undefined) {
    assign("gradeType", nonNumeric ? String(overall) : "numeric");
    assign("grade", nonNumeric ? null : asDecimal(overall, "overall grade"));
  }
  assign("centering", nonNumeric ? null : asOptionalDecimal(body.grade_centering, "centering"));
  assign("corners", nonNumeric ? null : asOptionalDecimal(body.grade_corners, "corners"));
  assign("edges", nonNumeric ? null : asOptionalDecimal(body.grade_edges, "edges"));
  assign("surface", nonNumeric ? null : asOptionalDecimal(body.grade_surface, "surface"));
  assign("centeringFrontLr", nullableString(body, "centering_front_lr"));
  assign("centeringFrontTb", nullableString(body, "centering_front_tb"));
  assign("centeringBackLr", nullableString(body, "centering_back_lr"));
  assign("centeringBackTb", nullableString(body, "centering_back_tb"));
  assign("cornerValues", asJson(body.corners));
  assign("edgeValues", asJson(body.edges));
  assign("surfaceValues", asJson(body.surface));
  assign("defects", asJson(body.defects));
  assign("aiDefectCandidates", asJson(body.ai_defect_candidates));
  assign("authStatus", nullableString(body, "auth_status"));
  assign("authNotes", nullableString(body, "auth_notes"));
  assign("gradeExplanation", nullableString(body, "grade_explanation"));
  assign("darkBorderFront", asBool(body.dark_border_front));
  assign("darkBorderBack", asBool(body.dark_border_back));
  assign("eyeAppealModifier", clampEyeAppeal(body.eye_appeal_modifier));
  assign("whiteningLines", asJson(body.whitening_lines));
  assign("creaseLines", asJson(body.crease_lines));
  if (body.crease_span_pct === undefined) {
    assign("creaseSpanPct", undefined);
  } else if (body.crease_span_pct === null || body.crease_span_pct === "") {
    assign("creaseSpanPct", null);
  } else {
    const creaseSpan = Number(body.crease_span_pct);
    if (Number.isFinite(creaseSpan)) assign("creaseSpanPct", Math.max(0, Math.min(100, creaseSpan)));
  }
  assign("wrinkleSeverity", nullableString(body, "wrinkle_severity"));
  assign("tearSeverity", nullableString(body, "tear_severity"));
  return out;
}

const FIELD_TO_COLUMN: Record<string, string> = {
  game: "card_game",
  setName: "set_name",
  cardName: "card_name",
  cardNumber: "card_number_display",
  rarity: "rarity",
  rarityOther: "rarity_other",
  designations: "designations",
  variant: "variant",
  variantOther: "variant_other",
  collection: "collection",
  collectionCode: "collection_code",
  collectionOther: "collection_other",
  language: "language",
  year: "year_text",
  notes: "notes",
  gradeType: "grade_type",
  grade: "grade",
  centering: "centering_score",
  corners: "corners_score",
  edges: "edges_score",
  surface: "surface_score",
  centeringFrontLr: "centering_front_lr",
  centeringFrontTb: "centering_front_tb",
  centeringBackLr: "centering_back_lr",
  centeringBackTb: "centering_back_tb",
  cornerValues: "corner_values",
  edgeValues: "edge_values",
  surfaceValues: "surface_values",
  defects: "defects",
  aiDefectCandidates: "ai_defect_candidates",
  authStatus: "auth_status",
  authNotes: "auth_notes",
  gradeExplanation: "grade_explanation",
  darkBorderFront: "dark_border_front",
  darkBorderBack: "dark_border_back",
  eyeAppealModifier: "eye_appeal_modifier",
  whiteningLines: "whitening_lines",
  creaseLines: "crease_lines",
  creaseSpanPct: "crease_span_pct",
  wrinkleSeverity: "wrinkle_severity",
  tearSeverity: "tear_severity",
  frontImage: "front_image_path",
  backImage: "back_image_path",
  darkBorder: "dark_border",
};

function sqlValue(field: string, value: CandidateValue) {
  if (
    field === "designations" ||
    field === "cornerValues" ||
    field === "edgeValues" ||
    field === "surfaceValues" ||
    field === "defects" ||
    field === "aiDefectCandidates" ||
    field === "whiteningLines" ||
    field === "creaseLines"
  ) {
    return sql`${JSON.stringify(value ?? (Array.isArray(value) ? [] : null))}::jsonb`;
  }
  if (field === "darkBorderFront" || field === "darkBorderBack") return sql`${value}::boolean`;
  if (field === "grade" || field === "centering" || field === "corners" || field === "edges" || field === "surface") {
    return value == null ? sql`NULL` : sql`${value}::numeric`;
  }
  if (field === "creaseSpanPct") return value == null ? sql`NULL` : sql`${value}::numeric`;
  return sql`${value}`;
}

function publicRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    certId: normalizeCertId(String(row.certificate_number || "")),
    updatedAt: toVersion(row.updated_at),
    cardName: row.card_name ?? null,
    setName: row.set_name ?? null,
    gradeOverall: row.grade ?? null,
  };
}

function rowField(row: Record<string, unknown>, field: string): unknown {
  return row[FIELD_TO_COLUMN[field]];
}

function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  candidates: Record<string, CandidateValue>
) {
  const changes: CorrectionChange[] = [];
  for (const field of Object.keys(candidates)) {
    // gradeType is folded into the `grade` entry when both moved together (a numeric ->
    // AA/NO transition always writes grade = null alongside), so it would otherwise be
    // reported twice for one logical change. Every other mutable field — including the
    // summarized ones — must be diffed, or the audit under-reports a real mutation.
    if (field === "gradeType" && candidates.grade !== undefined) continue;
    const prior = rowField(before, field);
    const next = rowField(after, field);
    if (stable(prior, field) !== stable(next, field)) {
      changes.push({ field, before: prior ?? null, after: next ?? null });
    }
  }
  return changes.sort((a, b) => HUMAN_FIELD_ORDER.indexOf(a.field) - HUMAN_FIELD_ORDER.indexOf(b.field));
}

function safeAuditDetails(args: {
  certificateNumber: string;
  gradedBy: unknown;
  changes: CorrectionChange[];
  idempotencyKey: string | null;
}) {
  // EVERY changed field is recorded. Large AI blobs are summarized, not omitted — an audit
  // that silently drops a field it just mutated is a false record, not a redacted one.
  const details = {
    schema: "super_admin_correction_v2",
    certificate_number: args.certificateNumber,
    canonical_entity_id: "certificates.id",
    graded_by: args.gradedBy ?? null,
    changed_fields: args.changes.map((change) => change.field),
    summarized_fields: args.changes.filter((c) => SUMMARIZED_AUDIT_FIELDS.has(c.field)).map((c) => c.field),
    changes: Object.fromEntries(
      args.changes.map((change) =>
        SUMMARIZED_AUDIT_FIELDS.has(change.field)
          ? [change.field, { before: shapeSummary(change.before), after: shapeSummary(change.after), summarized: true }]
          : [change.field, { before: change.before, after: change.after }]
      )
    ),
    image_changes: Object.fromEntries(
      args.changes
        .filter((change) => change.field === "frontImage" || change.field === "backImage")
        .map((change) => [change.field, { before_key: change.before, after_key: change.after }])
    ),
    ...(args.idempotencyKey ? { idempotency_key: args.idempotencyKey } : {}),
  };
  const json = JSON.stringify(details);
  if (Buffer.byteLength(json, "utf8") > MAX_AUDIT_DETAILS_BYTES) {
    throw Object.assign(new Error("Correction audit details are too large"), { status: 413 });
  }
  return details;
}

export async function applySuperAdminCorrection(input: CorrectionInput) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT *, EXTRACT(EPOCH FROM updated_at)::text AS correction_version
      FROM certificates
      WHERE id = ${input.certId} AND deleted_at IS NULL
      FOR UPDATE
    `);
    const before = locked.rows[0] as Record<string, unknown> | undefined;
    if (!before) throw Object.assign(new Error("Certificate not found"), { status: 404 });
    if (!before.grade_approved_at) {
      throw Object.assign(new Error("Correction Mode only applies to approved certificates"), { status: 409 });
    }
    const currentVersion =
      typeof before.correction_version === "string" ? before.correction_version : toVersion(before.updated_at);
    if (!input.expectedVersion || !currentVersion || String(input.expectedVersion) !== currentVersion) {
      throw Object.assign(new Error("Certificate changed; reload before saving corrections"), {
        status: 409,
        code: "version_conflict",
        currentVersion,
      });
    }

    const metadata = buildMetadata(input.metadata, before);
    const grading = buildGrading(input.grading);
    const candidates: Record<string, CandidateValue> = { ...metadata, ...grading };
    if (input.images.front) candidates.frontImage = input.images.front.key;
    if (input.images.back) candidates.backImage = input.images.back.key;
    if (candidates.darkBorderFront !== undefined || candidates.darkBorderBack !== undefined) {
      candidates.darkBorder =
        Boolean(candidates.darkBorderFront ?? before.dark_border_front) ||
        Boolean(candidates.darkBorderBack ?? before.dark_border_back);
    }

    const material = Object.fromEntries(
      Object.entries(candidates).filter(
        ([field, value]) => stable(rowField(before, field), field) !== stable(value, field)
      )
    );
    if (Object.keys(material).length === 0) {
      return {
        ok: true,
        noChange: true,
        auditId: null,
        changedFields: [],
        certificate: publicRow(before),
        version: currentVersion,
      };
    }

    const setParts = Object.entries(material).map(([field, value]) => {
      const column = FIELD_TO_COLUMN[field];
      if (!column) throw Object.assign(new Error(`Unsupported correction field: ${field}`), { status: 400 });
      return sql`${sql.identifier(column)} = ${sqlValue(field, value as CandidateValue)}`;
    });
    setParts.push(sql`updated_at = NOW()`);

    const updated = await tx.execute(sql`
      UPDATE certificates
      SET ${sql.join(setParts, sql`, `)}
      WHERE id = ${input.certId}
      RETURNING *, EXTRACT(EPOCH FROM updated_at)::text AS correction_version
    `);
    const after = updated.rows[0] as Record<string, unknown>;
    const changes = diffFields(before, after, material as Record<string, CandidateValue>);
    const auditDetails = safeAuditDetails({
      certificateNumber: normalizeCertId(String(after.certificate_number || before.certificate_number || "")),
      gradedBy: after.graded_by ?? before.graded_by ?? null,
      changes,
      idempotencyKey: typeof input.metadata.idempotencyKey === "string" ? input.metadata.idempotencyKey : null,
    });

    const audit = await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      VALUES ('certificate', ${String(input.certId)}, ${CORRECTION_ACTION}, ${input.actor}, ${JSON.stringify(auditDetails)}::jsonb, NOW())
      RETURNING id
    `);
    const auditId = Number((audit.rows[0] as any)?.id);
    if (!auditId) throw Object.assign(new Error("Correction audit insert failed"), { status: 500 });
    return {
      ok: true,
      noChange: false,
      auditId,
      changedFields: changes.map((change) => change.field),
      changes,
      certificate: publicRow(after),
      version: typeof after.correction_version === "string" ? after.correction_version : toVersion(after.updated_at),
    };
  });
}

/**
 * Pre-flight read of the correction target.
 *
 * Exists for two reasons:
 *  1. It yields the SERVER-DERIVED certificate number used to build R2 object keys. The
 *     key seed must never come from the request body: normalizeCertId() is pass-through
 *     for non-MV input (see server/lib/cert-id.ts — "PSA-123" is returned unchanged), so
 *     a body-supplied "../../images/MV1" would have been interpolated straight into the
 *     object key.
 *  2. It rejects the common failure cases (missing / not-approved / stale version) BEFORE
 *     any bytes are written to R2, so a rejected correction no longer strands orphaned
 *     objects in the bucket.
 *
 * This read is advisory only. applySuperAdminCorrection re-checks all three conditions
 * authoritatively under SELECT ... FOR UPDATE inside the transaction, so a race between
 * this read and the write cannot produce an incorrect result — only a wasted upload.
 */
async function loadCorrectionTarget(certId: number): Promise<{ certificateNumber: string; version: string | null }> {
  const r = await db.execute(sql`
    SELECT certificate_number, grade_approved_at,
           EXTRACT(EPOCH FROM updated_at)::text AS correction_version
    FROM certificates
    WHERE id = ${certId} AND deleted_at IS NULL
    LIMIT 1
  `);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error("Certificate not found"), { status: 404 });
  if (!row.grade_approved_at) {
    throw Object.assign(new Error("Correction Mode only applies to approved certificates"), { status: 409 });
  }
  return {
    certificateNumber: String(row.certificate_number || ""),
    version: typeof row.correction_version === "string" ? row.correction_version : null,
  };
}

/**
 * Defence-in-depth on the generated R2 key. The inputs are already server-derived, so this
 * should be unreachable — it exists so that a future change to the key seed cannot silently
 * reintroduce traversal. Mirrors the guard established in server/vault-quest/lib/vq-keys.ts.
 */
function assertSafeCorrectionKey(key: string): void {
  // Codepoint scan rather than a control-character regex (which trips no-control-regex).
  let hasControlChar = false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }
  const unsafe = key.includes("..") || key.includes("\\") || key.startsWith("/") || hasControlChar;
  if (unsafe || !key.startsWith("corrections/")) {
    throw Object.assign(new Error("Refusing to write an unsafe correction object key"), { status: 400 });
  }
}

/**
 * Restrict a certificate number to an inert path segment.
 *
 * normalizeCertId() is deliberately pass-through for non-MV input (see server/lib/cert-id.ts),
 * so it is NOT a sanitiser: normalizeCertId("../../images/MV1") === "../../images/MV1".
 * Anything that does not normalise to the exact MV<digits> shape collapses to "unknown".
 */
export function correctionKeySegment(certNumber: string): string {
  const normalised = normalizeCertId(String(certNumber ?? ""));
  return /^MV\d+$/.test(normalised) ? normalised : "unknown";
}

async function uploadCorrectionImages(certNumber: string, files: Partial<Record<string, Express.Multer.File[]>>) {
  const uploaded: CorrectionInput["images"] = {};
  const safeSegment = correctionKeySegment(certNumber);
  for (const side of ["front", "back"] as const) {
    const file = files[side === "front" ? "frontImage" : "backImage"]?.[0];
    if (!file) continue;
    const ext = (file.originalname.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const key = `corrections/${safeSegment}/${side}/${crypto.randomUUID()}.${ext}`;
    assertSafeCorrectionKey(key);
    await uploadToR2(key, file.buffer, file.mimetype);
    uploaded[side] = { key, originalName: file.originalname, mimeType: file.mimetype, size: file.size };
  }
  return uploaded;
}

export function registerCorrectionModeRoutes(app: ExpressApp): void {
  app.put(
    "/api/admin/certificates/:id/correction",
    requireSuperAdmin,
    uploadMemoryAdmission("admin_certificate_correction", 256),
    upload.fields([
      { name: "frontImage", maxCount: 1 },
      { name: "backImage", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const certId = Number.parseInt(String(req.params.id), 10);
        if (!Number.isInteger(certId) || certId <= 0) return res.status(400).json({ error: "Invalid certificate id" });
        const body = req.body || {};
        const grading = (() => {
          try {
            return parseBodyJson(body, "gradingPayload");
          } catch {
            throw Object.assign(new Error("Invalid grading payload"), { status: 400 });
          }
        })();
        const expectedVersion = String(body.expectedVersion || "");
        // Server-derived target. Also fails fast on missing / unapproved / stale-version so
        // we never upload bytes for a correction that is going to be rejected anyway.
        const target = await loadCorrectionTarget(certId);
        if (!expectedVersion || !target.version || expectedVersion !== target.version) {
          throw Object.assign(new Error("Certificate changed; reload before saving corrections"), {
            status: 409,
            code: "version_conflict",
            currentVersion: target.version,
          });
        }
        const images = await uploadCorrectionImages(
          target.certificateNumber,
          (req.files || {}) as Partial<Record<string, Express.Multer.File[]>>
        );
        const result = await applySuperAdminCorrection({
          certId,
          actor: (req.session as any)?.adminEmail,
          expectedVersion,
          metadata: body,
          grading,
          images,
        });
        return res.json(result);
      } catch (error: any) {
        const status = Number(error?.status || 500);
        if (status >= 500) console.error("[correction-mode] error:", error?.message || error);
        return res.status(status).json({
          error: error?.message || "Correction failed",
          code: error?.code,
          currentVersion: error?.currentVersion,
        });
      }
    }
  );
}

export const correctionModeInternals = {
  CORRECTION_ACTION,
  HUMAN_FIELD_ORDER,
  SUMMARIZED_AUDIT_FIELDS,
  CORRECTION_DISPLAY_EXCLUDED_FIELDS,
  safeAuditDetails,
  buildMetadata,
  buildGrading,
  shapeSummary,
  correctionKeySegment,
  assertSafeCorrectionKey,
};
