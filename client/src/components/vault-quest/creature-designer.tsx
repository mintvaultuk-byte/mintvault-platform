/**
 * AI Creature Designer (Phase 2) — founder Simple-Mode front door.
 *
 * The founder types one plain idea and gets a full, editable 3-stage family concept
 * BEFORE any artwork. No AI/provider/prompt jargon, no credits at this step (text AI
 * only). On approval the server creates the family + 3 stage characters in one
 * transaction and the parent opens Stage 1.
 *
 * Deliberately self-contained (keeps the giant admin-vault-quest page manageable).
 */
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AdminButton } from "@/components/admin";
import { Loader2, Wand2, Sparkles, Shuffle, X, Lightbulb, Dice5 } from "lucide-react";
import {
  VQ_CONCEPT_ELEMENTS,
  VQ_CONCEPT_TEMPERAMENTS,
  LORE_STYLES,
  pickRandomInspiration,
  applyConceptField,
  type CreatureIdeaInput,
  type FamilyConcept,
  type StageConcept,
  type SuggestField,
  type ConceptFieldTarget,
} from "@shared/vq-creature-concept";

const inputCls = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none";
const labelCls = "text-[11px] font-semibold uppercase tracking-wide text-slate-500";
const gold = "#D4AF37";

// Founder-friendly fields shown per stage (technical drawable fields stay editable
// behind "More detail" so the concept object keeps every field the server needs).
// `suggest` marks the creative fields that get AI Suggest + Surprise Me.
const STAGE_MAIN_FIELDS: { key: keyof StageConcept; label: string; rows: number; suggest?: SuggestField }[] = [
  { key: "name", label: "Name", rows: 1, suggest: "stage_name" },
  { key: "shortDescription", label: "Short description", rows: 2 },
  { key: "visualDescription", label: "What it looks like", rows: 3 },
  { key: "colours", label: "Colours", rows: 2, suggest: "stage_colours" },
  { key: "personality", label: "Personality", rows: 2, suggest: "stage_personality" },
  { key: "stageProgressionNotes", label: "Evolution changes from previous stage", rows: 3 },
  { key: "signatureAbility", label: "Signature ability", rows: 2, suggest: "signature_ability" },
  { key: "flavourText", label: "Flavour text", rows: 2, suggest: "flavour_text" },
];

/**
 * Per-field creative suggestions (Rev 2). Self-contained: manages its own open/loading/
 * items/style state so opening one field's suggestions never affects another. Applying
 * a choice changes ONLY the target field via applyConceptField.
 */
function SuggestBar({
  field, context, withStyle, onApply,
}: {
  field: SuggestField;
  context: Record<string, unknown>;
  withStyle?: boolean;
  onApply: (value: string) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState<"list" | "surprise" | null>(null);
  const [style, setStyle] = useState<string>(LORE_STYLES[0]);

  async function fetchList(styleOverride?: string) {
    setLoading("list");
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/creature-concept/suggest", { field, style: withStyle ? (styleOverride ?? style) : undefined, context });
      const data = (await res.json()) as { suggestions: string[] };
      setItems(data.suggestions ?? []);
      setOpen(true);
    } catch {
      toast({ title: "No suggestions right now", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }
  async function surprise() {
    setLoading("surprise");
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/creature-concept/suggest", { field, style: withStyle ? style : undefined, context, n: 3 });
      const data = (await res.json()) as { suggestions: string[] };
      const pick = data.suggestions?.[Math.floor(Math.random() * Math.min(3, data.suggestions.length))];
      if (pick) { onApply(pick); setOpen(false); }
    } catch {
      toast({ title: "Couldn't surprise you", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => fetchList()} disabled={!!loading} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-amber-500 disabled:opacity-50">{loading === "list" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lightbulb className="h-3 w-3" />}Suggest</button>
        <button type="button" onClick={surprise} disabled={!!loading} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-amber-500 disabled:opacity-50">{loading === "surprise" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Dice5 className="h-3 w-3" />}Surprise Me</button>
      </div>
      {open && (
        <div className="mt-1 rounded-lg border border-slate-800 bg-slate-950/70 p-2">
          {withStyle && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {LORE_STYLES.map((st) => (
                <button key={st} type="button" onClick={() => { setStyle(st); fetchList(st); }} className={`rounded px-1.5 py-0.5 text-[10px] ${style === st ? "bg-amber-500/20 text-amber-200" : "text-slate-400 hover:text-slate-200"}`}>{st}</button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {items.map((it, k) => (
              <button key={k} type="button" onClick={() => { onApply(it); setOpen(false); }} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-left text-[11px] text-slate-200 hover:border-amber-500 hover:bg-amber-500/10" title="Use this">{it}</button>
            ))}
            {items.length === 0 && <span className="text-[11px] text-slate-500">No suggestions.</span>}
          </div>
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={() => fetchList()} disabled={!!loading} className="text-[10px] text-amber-400 hover:underline disabled:opacity-50">{loading === "list" ? "…" : "Generate more"}</button>
            <button type="button" onClick={() => setOpen(false)} className="text-[10px] text-slate-500 hover:text-slate-300">close</button>
          </div>
        </div>
      )}
    </div>
  );
}
const STAGE_MORE_FIELDS: { key: keyof StageConcept; label: string; rows: number }[] = [
  { key: "characterDna", label: "Character DNA", rows: 3 },
  { key: "bodyShape", label: "Body shape", rows: 2 },
  { key: "markings", label: "Markings", rows: 2 },
  { key: "eyes", label: "Eyes", rows: 1 },
  { key: "tailAccessories", label: "Tail / accessories", rows: 2 },
  { key: "elementIdentity", label: "Element identity", rows: 2 },
  { key: "masterArtworkPrompt", label: "Master artwork prompt", rows: 3 },
  { key: "negativePrompt", label: "Negative prompt", rows: 2 },
];

export function CreatureDesigner({
  onCreated,
  onClose,
}: {
  onCreated: (familyId: string, stage1CharacterId: string) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [idea, setIdea] = useState("");
  const [opts, setOpts] = useState<Omit<CreatureIdeaInput, "idea">>({});
  const [concept, setConcept] = useState<FamilyConcept | null>(null);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const [busy, setBusy] = useState<null | "concept" | "create" | "alt">(null);
  const [inspireIdx, setInspireIdx] = useState(0);
  const [showMore, setShowMore] = useState<Record<number, boolean>>({});
  const [collision, setCollision] = useState<{ conflicts: string[]; suggestion: { familyName: string; stageNames: string[] } | null } | null>(null);

  function randomInspiration() {
    const i = inspireIdx + 1 + Math.floor(Math.random() * 5);
    setInspireIdx(i);
    setIdea(pickRandomInspiration(i));
  }

  async function generateConcept() {
    if (!idea.trim()) { toast({ title: "Describe a creature first", variant: "destructive" }); return; }
    if (concept && !window.confirm("Regenerate will replace the current concept. Continue?")) return;
    setBusy("concept");
    setCollision(null);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/creature-concept", { idea: idea.trim(), ...opts });
      const data = (await res.json()) as { concept: FamilyConcept; provider: string; model: string };
      setConcept(data.concept);
      setMeta({ provider: data.provider, model: data.model });
      toast({ title: "Family concept ready", description: "Review and edit, then Approve. No image credits used." });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      toast({ title: status === 503 ? "Text AI not connected" : "Concept generation failed", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  function editFamily(key: keyof FamilyConcept["family"], value: string) {
    setConcept((c) => (c ? { ...c, family: { ...c.family, [key]: value } } : c));
  }
  function editStage(i: number, key: keyof StageConcept, value: string) {
    setConcept((c) => (c ? { ...c, stages: c.stages.map((s, j) => (j === i ? { ...s, [key]: value } : s)) } : c));
  }
  // Apply a single suggested value to exactly one field (pure applyConceptField — the
  // field-isolation guarantee: no other field is ever touched).
  const applyField = (target: ConceptFieldTarget, value: string) => setConcept((c) => (c ? applyConceptField(c, target, value) : c));

  async function approveAndCreate() {
    if (!concept) return;
    setBusy("create");
    setCollision(null);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/families/from-concept", {
        concept,
        founderInput: { idea: idea.trim(), ...opts },
        provider: meta?.provider,
        model: meta?.model,
      });
      const data = (await res.json()) as { ok: true; familyId: string; stageCharacterIds: string[] };
      toast({ title: "Family created", description: `${concept.family.name} — Stage 1/2/3 created. Opening Stage 1.` });
      onCreated(data.familyId, data.stageCharacterIds[0]);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      // apiRequest attaches the PARSED response body as `.body`.
      const body = (e as { body?: { reason?: string; conflicts?: string[]; suggestion?: { familyName: string; stageNames: string[] } | null; message?: string } })?.body;
      if (status === 409 && body) {
        if (body.reason === "collision") { setCollision({ conflicts: body.conflicts ?? [], suggestion: body.suggestion ?? null }); return; }
        toast({ title: "Couldn't create", description: body.message ?? "A name or code already exists — try again.", variant: "destructive" });
        return;
      }
      toast({ title: "Create failed", description: "Nothing was created. Try again.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  function applySuggestedNames(sugg: { familyName: string; stageNames: string[] }) {
    setConcept((c) => (c ? { ...c, family: { ...c.family, name: sugg.familyName }, stages: c.stages.map((s, i) => ({ ...s, name: sugg.stageNames[i] ?? s.name })) } : c));
    setCollision(null);
    toast({ title: "Names updated", description: "Review the new names, then Approve again." });
  }

  async function generateAltNames() {
    if (!concept) return;
    setBusy("alt");
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/creature-concept/alt-names", {
        familyName: concept.family.name,
        stageNames: concept.stages.map((s) => s.name),
      });
      const sugg = (await res.json()) as { familyName: string; stageNames: string[] };
      applySuggestedNames(sugg);
    } catch {
      toast({ title: "Couldn't suggest names", description: "Edit the names manually instead.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4">
      <div className="my-6 w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-100">Create a New Creature</h2>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>

        {!concept ? (
          // ── STEP 1 · CREATURE IDEA ──
          <div className="space-y-3">
            <div>
              <label className={labelCls}>What creature would you like to create?</label>
              <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="A tiny pink fluffy cuddly monster that hides inside flowers and loves hugs." className={`${inputCls} mt-1 resize-y`} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div><label className={labelCls}>Element (optional)</label>
                <select value={opts.element ?? ""} onChange={(e) => setOpts((o) => ({ ...o, element: e.target.value || undefined }))} className={`${inputCls} mt-1`}>
                  <option value="">Let the AI choose</option>
                  {VQ_CONCEPT_ELEMENTS.map((el) => <option key={el} value={el}>{el}</option>)}
                </select>
              </div>
              <div><label className={labelCls}>Temperament</label>
                <select value={opts.temperament ?? ""} onChange={(e) => setOpts((o) => ({ ...o, temperament: e.target.value || undefined }))} className={`${inputCls} mt-1`}>
                  <option value="">Any</option>
                  {VQ_CONCEPT_TEMPERAMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div><label className={labelCls}>Main colours</label><input value={opts.colours ?? ""} onChange={(e) => setOpts((o) => ({ ...o, colours: e.target.value || undefined }))} className={`${inputCls} mt-1`} placeholder="pink & cream" /></div>
              <div><label className={labelCls}>Habitat</label><input value={opts.habitat ?? ""} onChange={(e) => setOpts((o) => ({ ...o, habitat: e.target.value || undefined }))} className={`${inputCls} mt-1`} placeholder="flower meadows" /></div>
              <div><label className={labelCls}>Size</label><input value={opts.size ?? ""} onChange={(e) => setOpts((o) => ({ ...o, size: e.target.value || undefined }))} className={`${inputCls} mt-1`} placeholder="tiny" /></div>
              <div><label className={labelCls}>Special trait</label><input value={opts.specialTrait ?? ""} onChange={(e) => setOpts((o) => ({ ...o, specialTrait: e.target.value || undefined }))} className={`${inputCls} mt-1`} placeholder="loves hugs" /></div>
            </div>
            <p className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-[11px] text-emerald-300">Creates a 3-stage family concept. No image credits will be used.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={generateConcept} disabled={busy === "concept"} className="flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-black disabled:opacity-50" style={{ background: gold }}>
                {busy === "concept" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}Generate Family Concept
              </button>
              <button type="button" onClick={randomInspiration} className="flex items-center gap-2 rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-amber-500"><Shuffle className="h-4 w-4" />Random Inspiration</button>
            </div>
          </div>
        ) : (
          // ── STEP 2 · EDITABLE CONCEPT REVIEW ──
          <div className="space-y-4">
            {collision && (
              <div className="rounded-lg border border-red-800 bg-red-950/30 p-3">
                <div className="text-sm font-semibold text-red-300">These names already exist: {collision.conflicts.join(", ")}</div>
                <p className="mt-1 text-[11px] text-slate-300">Never overwrites an existing creature. Rename below, or:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {collision.suggestion && <button type="button" onClick={() => applySuggestedNames(collision.suggestion!)} className="rounded border border-amber-600 px-3 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-900/30">Use “{collision.suggestion.familyName}”</button>}
                  <button type="button" onClick={generateAltNames} disabled={busy === "alt"} className="rounded border border-slate-600 px-3 py-1 text-[11px] text-slate-300 hover:border-amber-500 disabled:opacity-50">{busy === "alt" ? "…" : "Generate alternative names"}</button>
                  <button type="button" onClick={() => setCollision(null)} className="rounded border border-slate-600 px-3 py-1 text-[11px] text-slate-400">Edit names myself</button>
                </div>
              </div>
            )}

            {/* Family-level */}
            <div className="rounded-xl border border-sky-800/40 bg-sky-950/10 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-sky-300">Family</div>
              {(() => {
                const famCtx = { idea: idea.trim(), familyName: concept.family.name, element: concept.family.element, theme: concept.family.theme };
                return (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div><label className={labelCls}>Family name</label><input value={concept.family.name} onChange={(e) => editFamily("name", e.target.value)} className={`${inputCls} mt-1`} />
                      <SuggestBar field="family_name" context={famCtx} onApply={(v) => applyField({ scope: "family", key: "name" }, v)} /></div>
                    <div><label className={labelCls}>Element</label>
                      <select value={concept.family.element} onChange={(e) => editFamily("element", e.target.value)} className={`${inputCls} mt-1`}>
                        {[concept.family.element, ...VQ_CONCEPT_ELEMENTS.filter((el) => el !== concept.family.element)].map((el) => <option key={el} value={el}>{el}</option>)}
                      </select>
                    </div>
                    <div className="sm:col-span-2"><label className={labelCls}>Theme</label><textarea value={concept.family.theme} onChange={(e) => editFamily("theme", e.target.value)} rows={2} className={`${inputCls} mt-1 resize-y`} />
                      <SuggestBar field="family_theme" context={famCtx} onApply={(v) => applyField({ scope: "family", key: "theme" }, v)} /></div>
                    <div className="sm:col-span-2"><label className={labelCls}>Evolution direction</label><textarea value={concept.family.evolutionDirection} onChange={(e) => editFamily("evolutionDirection", e.target.value)} rows={2} className={`${inputCls} mt-1 resize-y`} />
                      <SuggestBar field="family_evolution" context={famCtx} onApply={(v) => applyField({ scope: "family", key: "evolutionDirection" }, v)} /></div>
                    <div><label className={labelCls}>Shared palette</label><textarea value={concept.family.palette} onChange={(e) => editFamily("palette", e.target.value)} rows={2} className={`${inputCls} mt-1 resize-y`} />
                      <SuggestBar field="family_palette" context={famCtx} onApply={(v) => applyField({ scope: "family", key: "palette" }, v)} /></div>
                    <div><label className={labelCls}>Shared traits</label><textarea value={concept.family.sharedTraits} onChange={(e) => editFamily("sharedTraits", e.target.value)} rows={2} className={`${inputCls} mt-1 resize-y`} />
                      <SuggestBar field="family_traits" context={famCtx} onApply={(v) => applyField({ scope: "family", key: "sharedTraits" }, v)} /></div>
                    <div className="sm:col-span-2"><label className={labelCls}>Family lore</label><textarea value={concept.family.lore} onChange={(e) => editFamily("lore", e.target.value)} rows={2} className={`${inputCls} mt-1 resize-y`} />
                      <SuggestBar field="family_lore" withStyle context={famCtx} onApply={(v) => applyField({ scope: "family", key: "lore" }, v)} /></div>
                  </div>
                );
              })()}
            </div>

            {/* Stages */}
            {concept.stages.map((s, i) => (
              <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-widest text-amber-300">Stage {i + 1}{i === 2 ? " · Final" : ""}</span>
                  <button type="button" onClick={() => setShowMore((m) => ({ ...m, [i]: !m[i] }))} className="text-[11px] text-slate-500 hover:text-slate-300">{showMore[i] ? "Hide detail" : "More detail"}</button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {STAGE_MAIN_FIELDS.map((f) => (
                    <div key={f.key} className={f.key === "name" || f.rows > 2 ? "sm:col-span-2" : ""}>
                      <label className={labelCls}>{f.label}</label>
                      {f.rows > 1
                        ? <textarea value={String(s[f.key] ?? "")} onChange={(e) => editStage(i, f.key, e.target.value)} rows={f.rows} className={`${inputCls} mt-1 resize-y`} />
                        : <input value={String(s[f.key] ?? "")} onChange={(e) => editStage(i, f.key, e.target.value)} className={`${inputCls} mt-1`} />}
                      {f.suggest && (
                        <SuggestBar
                          field={f.suggest}
                          context={{ familyName: concept.family.name, element: concept.family.element, theme: concept.family.theme, stageName: s.name, stageNumber: i + 1, previousStageName: i > 0 ? concept.stages[i - 1].name : undefined }}
                          onApply={(v) => applyField({ scope: "stage", index: i, key: f.key }, v)}
                        />
                      )}
                    </div>
                  ))}
                  {showMore[i] && STAGE_MORE_FIELDS.map((f) => (
                    <div key={f.key} className={f.rows > 2 ? "sm:col-span-2" : ""}>
                      <label className={labelCls}>{f.label}</label>
                      <textarea value={String(s[f.key] ?? "")} onChange={(e) => editStage(i, f.key, e.target.value)} rows={f.rows} className={`${inputCls} mt-1 resize-y`} />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
              <button type="button" onClick={approveAndCreate} disabled={busy === "create"} className="flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-black disabled:opacity-50" style={{ background: gold }}>
                {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Approve Family Concept
              </button>
              <AdminButton variant="ghost" onClick={generateConcept} disabled={busy === "concept"}>{busy === "concept" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}Regenerate Concept</AdminButton>
              <AdminButton variant="ghost" onClick={onClose}>Cancel</AdminButton>
              <span className="ml-auto text-[10px] text-slate-600">No image credits used yet — artwork is generated after approval, stage by stage.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
