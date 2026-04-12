/**
 * Defect-to-subgrade impact calculator.
 * Every field access is null-guarded. If anything throws, the defect is skipped.
 */

export interface DefectLike {
  id?: number | string;
  type?: string | null;
  severity?: string | null;
  location?: string | null;
  image_side?: string | null;
  x_percent?: number | null;
  y_percent?: number | null;
  position?: { x_percent?: number; y_percent?: number } | null;
}

const TYPE_TO_SUBGRADE: Record<string, "centering" | "corners" | "edges" | "surface"> = {
  whitening: "corners",
  "corner softness": "corners",
  "corner rounding": "corners",
  "corner ding": "corners",
  "corner crease": "corners",
  "edge chip": "edges",
  "edge roughness": "edges",
  silvering: "edges",
  scratch: "surface",
  "holo scratch": "surface",
  "print line": "surface",
  dent: "surface",
  indentation: "surface",
  "roller mark": "surface",
  stain: "surface",
  "colour fade": "surface",
  "ink spot": "surface",
  "registration error": "surface",
  "foil peel": "surface",
  "missing ink": "surface",
  fingerprint: "surface",
  "surface scuff": "surface",
  crease: "surface",
  "centering issue": "centering",
};

const SEVERITY_DEDUCTION: Record<string, number> = {
  minor: 0.5,
  moderate: 1.0,
  significant: 1.5,
  major: 2.0,
  severe: 3.0,
};

export function calculateSubgradesFromDefects(
  defects: DefectLike[] | null | undefined
): { centering: number; corners: number; edges: number; surface: number } {
  const subs = { centering: 10, corners: 10, edges: 10, surface: 10 };

  if (!defects || !Array.isArray(defects)) return subs;

  for (const d of defects) {
    try {
      if (!d || typeof d !== "object") continue;

      const rawType = d.type;
      if (!rawType || typeof rawType !== "string") continue;

      const type = rawType.toLowerCase().replace(/_/g, " ");
      let target: "centering" | "corners" | "edges" | "surface" =
        TYPE_TO_SUBGRADE[type] || "surface";

      // Whitening: position-aware remap
      if (type === "whitening") {
        const x = typeof d.x_percent === "number" ? d.x_percent : d.position?.x_percent;
        const y = typeof d.y_percent === "number" ? d.y_percent : d.position?.y_percent;
        if (typeof x === "number" && typeof y === "number") {
          const nearCorner = (y < 15 || y > 85) && (x < 15 || x > 85);
          const nearEdge = y < 10 || y > 90 || x < 10 || x > 90;
          target = nearCorner ? "corners" : (nearEdge ? "edges" : "surface");
        }
      }

      const rawSev = d.severity;
      const sevKey = typeof rawSev === "string" ? rawSev.toLowerCase() : "moderate";
      const deduction = SEVERITY_DEDUCTION[sevKey] ?? 1.0;

      subs[target] = Math.max(1, subs[target] - deduction);
    } catch {
      // Skip malformed defect, never crash
    }
  }

  return {
    centering: Math.floor(subs.centering),
    corners: Math.floor(subs.corners),
    edges: Math.floor(subs.edges),
    surface: Math.floor(subs.surface),
  };
}
