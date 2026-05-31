import { X } from "lucide-react";

export interface Defect {
  id: number;
  type: string;
  severity: "minor" | "moderate" | "significant";
  description: string;
  location: string;
  image_side: string;
  x_percent: number;
  y_percent: number;
  // MVGS classification — optional so legacy pins (auto-promoted from
  // ai_defects on grade approval) keep validating. The scoring engine
  // ignores pins where any of these are missing.
  tier?: "D1" | "D2" | "D3";
  mvgsCode?: MvgsCode;
  zone?: MvgsZone;
}

export type MvgsCode =
  | "WH"
  | "CH"
  | "FR"
  | "SC"
  | "SP"
  | "PI"
  | "PL"
  | "PS"
  | "SV"
  | "ST"
  | "GL"
  | "CR"
  | "RD"
  | "DG"
  | "OC";

export type MvgsZone =
  | "FA"
  | "FH"
  | "FB"
  | "FC1"
  | "FC2"
  | "FC3"
  | "FC4"
  | "FE1"
  | "FE2"
  | "FE3"
  | "FE4"
  | "BA"
  | "BB"
  | "BC1"
  | "BC2"
  | "BC3"
  | "BC4"
  | "BE1"
  | "BE2"
  | "BE3"
  | "BE4";

/** MVGS defect-type catalogue with codes + display labels. The picker in
 *  image-viewer.tsx renders this; the scoring engine in
 *  server/mvgs-scoring.ts deducts based on the code. */
export const MVGS_DEFECT_TYPES: Array<{ code: MvgsCode; label: string }> = [
  { code: "WH", label: "Whitening" },
  { code: "CH", label: "Chip" },
  { code: "FR", label: "Fray" },
  { code: "SC", label: "Scratch (surface)" },
  { code: "SP", label: "Scratch (gloss-penetrating)" },
  { code: "PI", label: "Pit / Dent" },
  { code: "PL", label: "Print Line" },
  { code: "PS", label: "Print Spot" },
  { code: "SV", label: "Silvering (holo)" },
  { code: "ST", label: "Stain" },
  { code: "GL", label: "Gloss Loss" },
  { code: "CR", label: "Crease" },
  { code: "RD", label: "Corner Rounding" },
  { code: "DG", label: "Corner Ding" },
  { code: "OC", label: "Off-centre (noted)" },
];

/** Pure helper — derive the zone code from pin coordinates + image side per
 *  the MVGS spec: corner if two edge bands intersect, edge if one, art
 *  zone otherwise. Holo (FH) and border-surface (FB / BB) zones aren't
 *  auto-derivable from coords alone; admin can correct manually. */
export function deriveZone(opts: { xPercent: number; yPercent: number; imageSide: string }): MvgsZone {
  const isFront = String(opts.imageSide).toLowerCase() !== "back";
  const x = opts.xPercent;
  const y = opts.yPercent;
  // Edge bands match the actual printed border on a Pokémon-card-sized scan
  // (~3-4 mm out of 63 mm width / 88 mm height). A pin must land inside the
  // physical border to register as an edge.
  const leftEdge = x < 7;
  const rightEdge = x > 93;
  const topEdge = y < 5;
  const bottomEdge = y > 95;
  // Corner bands are intentionally WIDER than the edge bands so a pin placed
  // visually "on a corner" but slightly inside the corner intersection
  // (e.g. x=8, y=4) still maps to FC/BC rather than dropping into FE/BE.
  // Pre-fix corner intersection was a 7%×5% rectangle (~0.35% of the image);
  // the wider 10%×8% rectangle (~0.8%, 2.3× larger) tolerates the usual
  // touch-zoom imprecision without bleeding into the edge or art zones.
  const leftCorner = x < 10;
  const rightCorner = x > 90;
  const topCorner = y < 8;
  const bottomCorner = y > 92;
  // Corners — both corner-band axes hit.
  if (topCorner && leftCorner) return isFront ? "FC1" : "BC1";
  if (topCorner && rightCorner) return isFront ? "FC2" : "BC2";
  if (bottomCorner && rightCorner) return isFront ? "FC3" : "BC3";
  if (bottomCorner && leftCorner) return isFront ? "FC4" : "BC4";
  // Edges — single edge-band axis hit. Narrower than the corner bands so
  // pins genuinely inside the card body (e.g. x=8, y=15) stay in the art
  // zone rather than getting pulled into FE/BE.
  if (topEdge) return isFront ? "FE1" : "BE1";
  if (rightEdge) return isFront ? "FE2" : "BE2";
  if (bottomEdge) return isFront ? "FE3" : "BE3";
  if (leftEdge) return isFront ? "FE4" : "BE4";
  // Interior — art zone by default.
  return isFront ? "FA" : "BA";
}

/** AI-suggested defect candidate. Same field shape as Defect but unconfirmed
 *  and id-less; admin promotes to Defect on confirm. */
export type DefectCandidate = Omit<Defect, "id">;

interface Props {
  defects: Defect[];
  onChange: (defects: Defect[]) => void;
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
  /** Unconfirmed AI candidates surfaced from scan-ingest's Haiku defect pass.
   *  Optional — undefined/empty = legacy / no candidates. */
  candidates?: DefectCandidate[];
  onCandidatesChange?: (next: DefectCandidate[]) => void;
}

const DEFECT_TYPES = [
  "Scratch",
  "Print Line",
  "Whitening",
  "Silvering",
  "Corner Softness",
  "Corner Rounding",
  "Edge Chip",
  "Edge Roughness",
  "Indentation",
  "Stain",
  "Crease",
  "Ink Spot",
  "Foil Peel",
  "Roller Mark",
  "Colour Fade",
  "Registration Error",
  "Holo Scratch",
  "Missing Ink",
  "Other",
];

const SEV_COLOR: Record<string, string> = {
  minor:
    "bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] text-[var(--admin-amber)] border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)]",
  moderate:
    "bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] text-[var(--admin-amber)] border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)]",
  significant:
    "bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] text-[var(--admin-red)] border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)]",
};

/** Defect type list — used by image-viewer.tsx's anchored dropdown so admin
 *  can place + tag in two clicks. Keep this export in sync with severity
 *  cycling logic below. */
export { DEFECT_TYPES };

const SEVERITY_CYCLE: Defect["severity"][] = ["minor", "moderate", "significant"];

export default function DefectAnnotation({ defects, onChange, highlightId, onHighlight, candidates }: Props) {
  function removeDefect(id: number) {
    onChange(defects.filter((d) => d.id !== id));
    if (highlightId === id) onHighlight(null);
  }

  function cycleSeverity(id: number) {
    onChange(
      defects.map((d) => {
        if (d.id !== id) return d;
        const i = SEVERITY_CYCLE.indexOf(d.severity);
        const next = SEVERITY_CYCLE[(i + 1) % SEVERITY_CYCLE.length];
        return { ...d, severity: next };
      })
    );
  }

  return (
    <div className="space-y-3">
      {/* Defect list — admin-placed only. Click body to highlight on image,
          MVGS tier badge shown if set, X to remove. */}
      {defects.length > 0 && (
        <div className="space-y-1.5">
          {defects.map((d) => (
            <div
              key={d.id}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 border cursor-pointer transition-all ${
                highlightId === d.id
                  ? "border-[var(--admin-gold)]/60 bg-[var(--admin-gold)]/5"
                  : "border-[var(--admin-line)] bg-[var(--admin-panel)] hover:border-[var(--admin-line)]"
              }`}
              onClick={() => onHighlight(highlightId === d.id ? null : d.id)}
            >
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--admin-red)] flex items-center justify-center text-white text-[9px] font-bold mt-0.5">
                {d.id}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[var(--admin-ink)] text-[10px] font-bold">{d.type}</span>
                  {d.mvgsCode && d.tier && (
                    <span className="text-[9px] uppercase px-1.5 py-0.5 rounded-full border bg-[var(--admin-bg2)] text-[var(--admin-ink-dim)] border-[var(--admin-line)] font-bold">
                      {d.tier}
                    </span>
                  )}
                  <span className="text-[var(--admin-ink-dim)] text-[9px]">{d.location}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeDefect(d.id);
                }}
                className="flex-shrink-0 text-[var(--admin-ink-faint)] hover:text-[var(--admin-red)] transition-colors p-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* AI-suggested candidates — read-only decorative info. Admin places
          their own defects via image clicks; AI suggestions are not promoted
          automatically and have no confirm/reject UI here. */}
      {candidates && candidates.length > 0 && (
        <div className="space-y-1.5 border-t border-dashed border-[var(--admin-gold)]/30 pt-2">
          <p className="text-[var(--admin-gold)]/70 text-[9px] uppercase tracking-widest font-bold">
            AI suggestions ({candidates.length}) — info only
          </p>
          {candidates.map((c, i) => (
            <div
              key={`cand-${i}`}
              className="flex items-start gap-2 rounded-lg px-3 py-2 border border-dashed border-[var(--admin-gold)]/40 bg-[var(--admin-panel3)]"
            >
              <span className="flex-shrink-0 w-5 h-5 rounded-full border border-dashed border-[var(--admin-gold)] bg-[var(--admin-panel)] flex items-center justify-center text-[var(--admin-gold)] text-[9px] font-bold mt-0.5">
                ?
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[var(--admin-ink)] text-[10px] font-bold">{c.type}</span>
                  {c.mvgsCode && c.tier && (
                    <span className="text-[9px] uppercase px-1.5 py-0.5 rounded-full border bg-[var(--admin-bg2)] text-[var(--admin-ink-dim)] border-[var(--admin-line)] font-bold">
                      {c.tier}
                    </span>
                  )}
                  <span className="text-[var(--admin-ink-dim)] text-[9px]">{c.location}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {defects.length === 0 && (!candidates || candidates.length === 0) && (
        <p className="text-[var(--admin-ink-dim)] text-xs text-center py-2">
          No defects marked. Click "Mark Defects" and tap the image to start.
        </p>
      )}
    </div>
  );
}
