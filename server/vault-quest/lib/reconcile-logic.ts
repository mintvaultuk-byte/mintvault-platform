/**
 * Pure, dependency-free VQ orphan-reconciliation diff logic (R3-CON-01), Phase 7E.
 * No DB / R2 imports — the CLI wrapper (scripts/vq-reconcile-orphans.ts) feeds it
 * DB rows + R2 keys and it computes the findings. DETECTION ONLY; deletion is a
 * separate, owner-gated, unbuilt step (Category C).
 */

export interface ReconcileCandidateRow {
  id: number;
  r2Key: string;
  status: string; // candidate | approved | rejected | auto_rejected | deleted
  characterId: string | null;
  cardId: string | null;
  referenceType: string | null;
  updatedAtMs: number;
}
export interface ReconcileR2Object {
  key: string;
  sizeBytes?: number | null;
  lastModifiedMs?: number | null;
}
export interface ReconcilePackRef {
  characterId: string;
  referenceType: string;
  candidateId: number | null;
  r2Key: string | null;
}
export interface ReconcileInput {
  candidates: ReconcileCandidateRow[];
  objects: ReconcileR2Object[]; // every vq/ key
  referencedKeys: Set<string>; // all live NON-candidate DB keys (card art, approved/reference, pack.r2Key, release/export/asset keys)
  packRefs: ReconcilePackRef[];
  nowMs: number;
  retentionTtlMs: number;
  minAgeMs?: number; // objects/rows newer than this are never SAFE_ORPHAN
  graceMs?: number; // a candidate row younger than this with no object is not yet an integrity failure
}

export type ReconcileClass =
  | "MISSING_DB"
  | "MISSING_OBJECT"
  | "SAFE_ORPHAN"
  | "UNSAFE_REFERENCED"
  | "WRONG_PREFIX"
  | "INTEGRITY_FAILURE";
export type ReconcileCategory =
  | "candidate_missing_object"
  | "object_missing_row"
  | "retention_expired"
  | "referenced_by_pack"
  | "dangling_pack_ref"
  | "duplicate_approved_slot"
  | "wrong_prefix"
  | "hash_mismatch" // SPECULATIVE — no hash column yet
  | "temp_export_expired" // SPECULATIVE — no R2 export producer yet
  | "provider_completed_unpersisted"; // DEPENDENT — needs vq_generation_requests
export interface ReconcileFinding {
  category: ReconcileCategory;
  klass: ReconcileClass;
  candidateId?: number | null;
  keyTrunc?: string;
  characterId?: string | null;
  cardId?: string | null;
  status?: string | null;
  ageMs?: number | null;
  detail?: string;
}

const ALL_CATEGORIES: ReconcileCategory[] = [
  "candidate_missing_object", "object_missing_row", "retention_expired", "referenced_by_pack",
  "dangling_pack_ref", "duplicate_approved_slot", "wrong_prefix", "hash_mismatch",
  "temp_export_expired", "provider_completed_unpersisted",
];
const ALL_CLASSES: ReconcileClass[] = [
  "MISSING_DB", "MISSING_OBJECT", "SAFE_ORPHAN", "UNSAFE_REFERENCED", "WRONG_PREFIX", "INTEGRITY_FAILURE",
];

export function truncateKey(key: string, n = 48): string {
  return key.length <= n ? key : `${key.slice(0, n)}…`;
}

/** Boolean mirror of assertVqReadKey — inside vq/, no traversal/control chars. */
export function isVqKey(key: string): boolean {
  return (
    key.startsWith("vq/") &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    !/[\x00-\x1f]/.test(key) // eslint-disable-line no-control-regex
  );
}

export function classifyKeyShape(key: string): "candidate" | "approved" | "art" | "unknown" {
  if (/^vq\/art-candidates\/[^/]+\//.test(key) || /^vq\/characters\/[^/]+\/candidates\//.test(key)) return "candidate";
  if (/^vq\/characters\/[^/]+\/approved\//.test(key) || /^vq\/characters\/[^/]+\/(reference|approved)\.png$/.test(key)) return "approved";
  if (/^vq\/art\/[^/]+\//.test(key)) return "art";
  return "unknown";
}

/** The candidate ids a reference pack still points at — the protected set. */
export function referencedCandidateIdsFromPacks(packRefs: ReconcilePackRef[]): Set<number> {
  const s = new Set<number>();
  for (const p of packRefs) if (p.candidateId != null) s.add(p.candidateId);
  return s;
}

export interface ReconcileReport {
  counts: Record<ReconcileCategory, number>;
  classCounts: Record<ReconcileClass, number>;
  findings: ReconcileFinding[];
  integrityFailures: number;
  safeOrphanCount: number;
  notes: string[];
}

export function reconcile(input: ReconcileInput): ReconcileReport {
  const graceMs = input.graceMs ?? 10 * 60 * 1000; // 10 min: upload precedes insert, so a fresh gap is a mid-write, not an anomaly
  const minAgeMs = input.minAgeMs ?? 0;
  const findings: ReconcileFinding[] = [];
  const notes: string[] = [];

  const objectKeys = new Set(input.objects.map((o) => o.key));
  const candidateKeys = new Set(input.candidates.map((c) => c.r2Key));
  const candidateById = new Map(input.candidates.map((c) => [c.id, c] as const));
  const referencedCandidateIds = referencedCandidateIdsFromPacks(input.packRefs);

  // 1. candidate rows whose object is missing
  for (const c of input.candidates) {
    if (!objectKeys.has(c.r2Key)) {
      const ageMs = input.nowMs - c.updatedAtMs;
      const klass: ReconcileClass = ageMs > graceMs ? "INTEGRITY_FAILURE" : "MISSING_OBJECT";
      findings.push({ category: "candidate_missing_object", klass, candidateId: c.id, keyTrunc: truncateKey(c.r2Key), status: c.status, ageMs, detail: klass === "INTEGRITY_FAILURE" ? "row with no object, past grace" : "row with no object (possibly mid-write)" });
    }
  }

  // 2. objects with no DB row
  for (const o of input.objects) {
    if (!isVqKey(o.key)) continue; // scoped to vq/
    const shape = classifyKeyShape(o.key);
    if (shape === "unknown") {
      findings.push({ category: "wrong_prefix", klass: "WRONG_PREFIX", keyTrunc: truncateKey(o.key), detail: "vq/ object matching no known VQ shape" });
      continue;
    }
    if (candidateKeys.has(o.key) || input.referencedKeys.has(o.key)) continue; // has a row / is referenced
    const ageMs = input.nowMs - (o.lastModifiedMs ?? input.nowMs);
    if (shape === "candidate") {
      const safe = ageMs > input.retentionTtlMs && ageMs > minAgeMs;
      findings.push({ category: "object_missing_row", klass: safe ? "SAFE_ORPHAN" : "UNSAFE_REFERENCED", keyTrunc: truncateKey(o.key), ageMs, detail: safe ? "candidate object, no row, > ttl" : "candidate object, no row, too new (possible mid-write)" });
    } else {
      // approved/art object not referenced anywhere → conservative, never auto-safe
      findings.push({ category: "object_missing_row", klass: "UNSAFE_REFERENCED", keyTrunc: truncateKey(o.key), ageMs, detail: "approved/art object not referenced by DB (manual review)" });
    }
  }

  // 3. retention-expired safe orphans (rejected/deleted candidates past ttl, not referenced, object present)
  for (const c of input.candidates) {
    const disposed = c.status === "rejected" || c.status === "auto_rejected" || c.status === "deleted";
    if (!disposed) continue;
    const ageMs = input.nowMs - c.updatedAtMs;
    if (referencedCandidateIds.has(c.id)) {
      // still pointed at by a pack — NEVER safe (guards the real staging case)
      findings.push({ category: "referenced_by_pack", klass: "UNSAFE_REFERENCED", candidateId: c.id, status: c.status, detail: "disposed candidate still referenced by a reference pack" });
      continue;
    }
    if (ageMs > input.retentionTtlMs && objectKeys.has(c.r2Key)) {
      findings.push({ category: "retention_expired", klass: "SAFE_ORPHAN", candidateId: c.id, keyTrunc: truncateKey(c.r2Key), status: c.status, ageMs, detail: "disposed > ttl, unreferenced, object present" });
    }
  }

  // 4. dangling pack refs (pack points at a missing/rejected candidate, or a missing object)
  for (const p of input.packRefs) {
    if (p.candidateId != null) {
      const row = candidateById.get(p.candidateId);
      if (!row) {
        findings.push({ category: "dangling_pack_ref", klass: "INTEGRITY_FAILURE", characterId: p.characterId, candidateId: p.candidateId, detail: `pack ${p.referenceType} → missing candidate` });
        continue;
      }
      if (row.status === "rejected" || row.status === "auto_rejected") {
        findings.push({ category: "dangling_pack_ref", klass: "INTEGRITY_FAILURE", characterId: p.characterId, candidateId: p.candidateId, status: row.status, detail: `pack ${p.referenceType} → rejected candidate` });
      }
    }
    if (p.r2Key && !objectKeys.has(p.r2Key)) {
      findings.push({ category: "dangling_pack_ref", klass: "INTEGRITY_FAILURE", characterId: p.characterId, keyTrunc: truncateKey(p.r2Key), detail: `pack ${p.referenceType} → missing object` });
    }
  }

  // 5. duplicate approved candidates for the same (character, referenceType)
  const approvedBySlot = new Map<string, ReconcileCandidateRow[]>();
  for (const c of input.candidates) {
    if (c.status !== "approved" || !c.characterId || !c.referenceType) continue;
    const slot = `${c.characterId}|${c.referenceType}`;
    (approvedBySlot.get(slot) ?? approvedBySlot.set(slot, []).get(slot)!).push(c);
  }
  for (const [slot, rows] of approvedBySlot) {
    if (rows.length > 1) {
      const [characterId, referenceType] = slot.split("|");
      findings.push({ category: "duplicate_approved_slot", klass: "INTEGRITY_FAILURE", characterId, status: "approved", detail: `${rows.length} approved candidates for ${referenceType}` });
    }
  }

  // Blocked-on-infra categories: report as notes so callers know they weren't run.
  notes.push("hash_mismatch: SPECULATIVE — no sha/size column on vq_artwork_candidates yet");
  notes.push("temp_export_expired: SPECULATIVE — no R2-persisting export producer yet");
  notes.push("provider_completed_unpersisted: DEPENDENT — needs the vq_generation_requests table");

  const counts = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])) as Record<ReconcileCategory, number>;
  const classCounts = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<ReconcileClass, number>;
  for (const f of findings) {
    counts[f.category]++;
    classCounts[f.klass]++;
  }
  return {
    counts,
    classCounts,
    findings,
    integrityFailures: classCounts.INTEGRITY_FAILURE,
    safeOrphanCount: classCounts.SAFE_ORPHAN,
    notes,
  };
}
