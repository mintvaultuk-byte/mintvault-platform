/**
 * staff-edit-submission.tsx — edit a grader's OWN already-submitted
 * (pending_review) card: identity + grade. Saving NEVER publishes — the card
 * stays pending_review and still faces the admin review gate (the server
 * re-asserts review_required and re-snapshots operator_grade).
 *
 * Reuses the #135 identity editor (PokemonSetPicker + VariantPicker +
 * TcgCardSearch) so the editor matches the grader/admin identity surfaces.
 */
import { useEffect, useState } from "react";
import { PokemonSetPicker } from "@/components/certificate-form";
import { VariantPicker, TcgCardSearch, type TcgCardPick } from "@/components/identity-tools";
import { useToast } from "@/hooks/use-toast";

type Props = {
  certId: number;
  certIdStr: string;
  onSaved: () => void;
  onCancel: () => void;
};

const inputCls =
  "w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1 outline-none focus:border-[var(--admin-gold)]/60";
const lbl = "text-[9px] uppercase tracking-wider text-[var(--admin-ink-dim)]";

export function StaffEditSubmission({ certId, certIdStr, onSaved, onCancel }: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);

  const [name, setName] = useState("");
  const [cardSet, setCardSet] = useState("");
  const [setCode, setSetCode] = useState("");
  const [number, setNumber] = useState("");
  const [year, setYear] = useState("");
  const [variant, setVariant] = useState("");
  const [overall, setOverall] = useState("");
  const [centering, setCentering] = useState("");
  const [corners, setCorners] = useState("");
  const [edges, setEdges] = useState("");
  const [surface, setSurface] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/grader/certificates/${certId}/grading`, { credentials: "include" });
        if (!r.ok) throw new Error("Couldn't load card");
        const d = await r.json();
        if (!alive) return;
        setName(d.cardName || "");
        setCardSet(d.setName || "");
        setNumber(d.cardNumber || "");
        setYear(d.year || "");
        setVariant(d.variant || "");
        setOverall(d.grade != null ? String(d.grade) : "");
        setCentering(d.centeringScore != null ? String(d.centeringScore) : "");
        setCorners(d.cornersScore != null ? String(d.cornersScore) : "");
        setEdges(d.edgesScore != null ? String(d.edgesScore) : "");
        setSurface(d.surfaceScore != null ? String(d.surfaceScore) : "");
      } catch (e: any) {
        toast({ title: "Load failed", description: e.message, variant: "destructive" });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [certId, toast]);

  function applyCardPick(c: TcgCardPick) {
    if (c.name) setName(c.name.toUpperCase());
    if (c.setName) setCardSet(c.setName);
    if (c.setCode) setSetCode(c.setCode);
    if (c.number) setNumber(c.number);
    if (c.year) setYear(c.year);
    toast({ title: `Filled from ${c.name}`, description: c.setName || undefined });
  }

  async function rerunIdentify() {
    setRerunBusy(true);
    try {
      const r = await fetch(`/api/grader/certificates/${certId}/identify`, { method: "POST", credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Re-identify failed");
      const ident = d.identification || {};
      const n = ident.officialName || ident.detected_name || "";
      const sn = ident.officialSet || ident.detected_set || "";
      const num = ident.officialNumber || ident.detected_number || "";
      const yr = ident.detected_year || ident.copyright_year || "";
      if (n && !name.trim()) setName(String(n).toUpperCase());
      if (sn && !cardSet.trim()) setCardSet(String(sn));
      if (ident.set_code && !setCode.trim()) setSetCode(String(ident.set_code));
      if (num && !number.trim()) setNumber(String(num));
      if (yr && !year.trim()) setYear(String(yr));
      toast({ title: "Re-ran identification", description: n ? `TCGdex: ${n}` : "Status updated." });
    } catch (e: any) {
      toast({ title: "Re-identify failed", description: e.message, variant: "destructive" });
    } finally {
      setRerunBusy(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Card name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/grader/certificates/${certId}/edit-submission`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card_name: name.trim(),
          set_name: cardSet.trim() || null,
          card_number_display: number.trim() || null,
          year_text: year.trim() || null,
          variant: variant.trim() || null,
          overall_grade: overall.trim() || null,
          grade_centering: centering.trim() || null,
          grade_corners: corners.trim() || null,
          grade_edges: edges.trim() || null,
          grade_surface: surface.trim() || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Save failed");
      toast({ title: `Saved ${certIdStr}`, description: "Still pending review — sent back for approval." });
      onSaved();
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-[var(--admin-ink-faint)] text-xs px-1 py-3">Loading {certIdStr}…</div>;
  }

  return (
    <div
      className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] p-3 space-y-3"
      data-testid="staff-edit-submission"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-[var(--admin-gold)]">{certIdStr}</span>
        <span className="text-[9px] uppercase tracking-wider text-amber-300">Submitted · editing (stays pending review)</span>
      </div>

      {/* Identity */}
      <PokemonSetPicker
        value={cardSet}
        onChange={(n, id) => {
          setCardSet(n);
          setSetCode(id || "");
        }}
        allowAddSet
        createEndpoint="/api/staff/custom-sets"
        prefill={{ setName: cardSet, setCode }}
        testId="edit-sub-set"
      />
      <div className="grid grid-cols-4 gap-2">
        <label className="flex flex-col gap-0.5 col-span-2">
          <span className={lbl}>Card name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} data-testid="edit-sub-name" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Number</span>
          <input value={number} onChange={(e) => setNumber(e.target.value)} className={inputCls} data-testid="edit-sub-number" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Year</span>
          <input value={year} onChange={(e) => setYear(e.target.value)} className={inputCls} data-testid="edit-sub-year" />
        </label>
        <label className="flex flex-col gap-0.5 col-span-4">
          <span className={lbl}>Variant</span>
          <VariantPicker value={variant} onChange={setVariant} testId="edit-sub-variant" inputClassName={inputCls} />
        </label>
      </div>

      {/* Identify tools */}
      <div className="space-y-2 pt-1 border-t border-[var(--admin-line)]">
        <div className="flex items-center justify-between gap-2">
          <span className={lbl}>Identify tools</span>
          <button
            type="button"
            onClick={rerunIdentify}
            disabled={rerunBusy}
            className="border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] text-[10px] font-bold uppercase px-2 py-1 rounded hover:bg-[var(--admin-gold)]/10 disabled:opacity-40"
            data-testid="edit-sub-rerun"
          >
            {rerunBusy ? "Re-running…" : "Re-run TCGdex"}
          </button>
        </div>
        <TcgCardSearch onPick={applyCardPick} initialQuery={name} testId="edit-sub-card-search" />
      </div>

      {/* Grade */}
      <div className="grid grid-cols-5 gap-2 pt-1 border-t border-[var(--admin-line)]">
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Overall</span>
          <input value={overall} onChange={(e) => setOverall(e.target.value)} className={inputCls} data-testid="edit-sub-overall" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Centering</span>
          <input value={centering} onChange={(e) => setCentering(e.target.value)} className={inputCls} data-testid="edit-sub-centering" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Corners</span>
          <input value={corners} onChange={(e) => setCorners(e.target.value)} className={inputCls} data-testid="edit-sub-corners" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Edges</span>
          <input value={edges} onChange={(e) => setEdges(e.target.value)} className={inputCls} data-testid="edit-sub-edges" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lbl}>Surface</span>
          <input value={surface} onChange={(e) => setSurface(e.target.value)} className={inputCls} data-testid="edit-sub-surface" />
        </label>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-[var(--admin-gold)] text-[#1A1400] text-xs font-bold px-4 py-1.5 rounded hover:opacity-90 disabled:opacity-50"
          data-testid="edit-sub-save"
        >
          {saving ? "Saving…" : "Save edits"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="border border-[var(--admin-gold)]/40 text-[var(--admin-ink)] text-xs px-4 py-1.5 rounded hover:bg-[var(--admin-gold)]/10"
          data-testid="edit-sub-cancel"
        >
          Cancel
        </button>
      </div>
      <p className="text-[10px] text-[var(--admin-ink-faint)]">
        Saving keeps this card <span className="text-amber-300">pending review</span> — it never publishes; an admin still approves it.
      </p>
    </div>
  );
}
