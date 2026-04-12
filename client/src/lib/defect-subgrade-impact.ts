/**
 * Calculates suggested subgrades based on defect list.
 * Starts at 10 for each subgrade and deducts based on defect type, severity, and position.
 * These are advisory suggestions — admin can override.
 */

export interface DefectForImpact {
  type: string;
  severity: string;
  x_percent: number;
  y_percent: number;
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

export function calculateSubgradesFromDefects(defects: DefectForImpact[]): {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
} {
  const subs = { centering: 10, corners: 10, edges: 10, surface: 10 };

  for (const d of defects) {
    const typeLower = d.type.toLowerCase().replace(/_/g, " ");
    let target = TYPE_TO_SUBGRADE[typeLower] || "surface";

    // Whitening: position-aware — near corners vs near edges vs on surface
    if (typeLower === "whitening") {
      const nearEdge = d.y_percent < 10 || d.y_percent > 90 ||
                       d.x_percent < 10 || d.x_percent > 90;
      const nearCorner = (d.y_percent < 15 || d.y_percent > 85) &&
                         (d.x_percent < 15 || d.x_percent > 85);
      target = nearCorner ? "corners" : (nearEdge ? "edges" : "surface");
    }

    const deduction = SEVERITY_DEDUCTION[d.severity.toLowerCase()] || 1.0;
    subs[target] = Math.max(1, subs[target] - deduction);
  }

  return {
    centering: Math.floor(subs.centering),
    corners: Math.floor(subs.corners),
    edges: Math.floor(subs.edges),
    surface: Math.floor(subs.surface),
  };
}
