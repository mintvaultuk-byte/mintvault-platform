type ReviewDefect = { type?: string | null; mvgsCode?: string | null; tier?: string | null; zone?: string | null };

export interface RoleReviewSummaryProps {
  identity: {
    certId?: string;
    game?: string;
    name: string;
    set: string;
    number: string;
    year: string;
    language: string;
  };
  classification: { rarity?: string; finish?: string; promo?: string; variant?: string; serviceTier?: string | null };
  grade: {
    overall: string;
    centering: number | null;
    corners: number | null;
    edges: number | null;
    surface: number | null;
  };
  authentication: { status: string; notes?: string };
  defects: ReviewDefect[];
  publicNotes: string;
  privateNotes: string;
}

const valueClass = "mt-0.5 text-xs text-[var(--admin-ink)]";

function Item({ label, children }: { label: string; children: string | number | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">{label}</div>
      <div className={`${valueClass} truncate`} title={String(children || "—")}>
        {children || "—"}
      </div>
    </div>
  );
}

/** Read-only Review-stage projection of the current in-memory grading draft. */
export function RoleReviewSummary(props: RoleReviewSummaryProps) {
  const defectText = props.defects.length
    ? props.defects.map((d) => [d.mvgsCode || d.type, d.tier, d.zone].filter(Boolean).join(" · ")).join(", ")
    : "None recorded";
  return (
    <section
      className="space-y-3 rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] p-3"
      data-canonical-section="review-summary"
      data-testid="role-review-summary"
    >
      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]">Review grading</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Item label="Certificate">{props.identity.certId}</Item>
        <Item label="Card">{props.identity.name}</Item>
        <Item label="Set">{props.identity.set}</Item>
        <Item label="Number">{props.identity.number}</Item>
        <Item label="Year">{props.identity.year}</Item>
        <Item label="Language">{props.identity.language}</Item>
        <Item label="Game">{props.identity.game}</Item>
        <Item label="Service">{props.classification.serviceTier}</Item>
        <Item label="Variant">{props.classification.variant}</Item>
        <Item label="Rarity">{props.classification.rarity}</Item>
        <Item label="Finish">{props.classification.finish}</Item>
        <Item label="Promo">{props.classification.promo}</Item>
      </div>
      <div className="grid grid-cols-5 gap-2 rounded border border-[var(--admin-line)] p-2">
        <Item label="Overall">{props.grade.overall}</Item>
        <Item label="Centering">{props.grade.centering}</Item>
        <Item label="Corners">{props.grade.corners}</Item>
        <Item label="Edges">{props.grade.edges}</Item>
        <Item label="Surface">{props.grade.surface}</Item>
      </div>
      <Item label="Authentication">
        {[props.authentication.status, props.authentication.notes].filter(Boolean).join(" · ")}
      </Item>
      <Item label={`Defects (${props.defects.length})`}>{defectText}</Item>
      <Item label="Public grade explanation">{props.publicNotes}</Item>
      <Item label="Private notes">{props.privateNotes}</Item>
    </section>
  );
}

export default RoleReviewSummary;
