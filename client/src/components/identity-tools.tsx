/**
 * identity-tools.tsx — reusable identity-editor controls shared by BOTH the
 * grader grading panel and the admin review override form, so the two editors
 * stay at parity:
 *
 *   • VariantPicker  — a managed combobox of the canonical VARIANT_OPTIONS
 *     merged with the custom_variants table, plus inline "add new variant"
 *     (POSTs /api/staff/custom-variants — admin OR grader, dedup + audit on the
 *     server). Variants print on the slab, so this is a proper picker, not a
 *     free-text box.
 *   • TcgCardSearch  — search cards BY NAME (pokemontcg.io / Scryfall /
 *     YGOPRODeck via /api/staff/card-search) and show the matches in a pop-down
 *     with LARGE images so the operator can visually compare while scrolling.
 *     Selecting a card fills the identity fields.
 *
 * Both call the shared /api/staff/* endpoints, which accept an admin OR a staff
 * grader, so the exact same controls work on every screen.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Loader2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { adminFetch } from "@/lib/queryClient";
import { VARIANT_OPTIONS } from "@/lib/variantOptions";

// ── VariantPicker ───────────────────────────────────────────────────────────

type VariantPickerProps = {
  value: string;
  onChange: (label: string) => void;
  testId?: string;
  disabled?: boolean;
  /** Tailwind classes for the text input (so it matches the host screen). */
  inputClassName?: string;
};

export function VariantPicker({ value, onChange, testId, disabled, inputClassName }: VariantPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Custom variants from the managed table (merged with the canonical list).
  const { data: customData } = useQuery<{ variants: string[] }>({
    queryKey: ["/api/staff/custom-variants"],
    staleTime: 60_000,
  });

  // Full option list = canonical labels + custom labels, deduped case-insensitively.
  const seen = new Set<string>();
  const options: { label: string; abbreviation?: string; custom?: boolean }[] = [];
  for (const v of VARIANT_OPTIONS) {
    const key = v.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ label: v.label, abbreviation: v.abbreviation });
  }
  for (const label of customData?.variants || []) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ label, custom: true });
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const exactMatch = options.some((o) => o.label.toLowerCase() === q);
  const canAdd = q.length >= 1 && !exactMatch;

  async function addVariant() {
    const label = query.trim();
    if (!label) return;
    setSaving(true);
    try {
      const r = await adminFetch("/api/staff/custom-variants", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to add variant");
      const finalLabel = d.label || label;
      if (d.duplicate) toast({ title: "Existing variant selected", description: d.message || `Using "${finalLabel}".` });
      else toast({ title: `Variant added: ${finalLabel}` });
      queryClient.invalidateQueries({ queryKey: ["/api/staff/custom-variants"] });
      onChange(finalLabel);
      setQuery(finalLabel);
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Couldn't add variant", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder="Variant / finish (e.g. Holo)"
        data-testid={testId}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className={inputClassName}
      />
      {open && !disabled && (
        <div className="absolute z-40 left-0 right-0 mt-1 bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {filtered.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => {
                onChange(o.label);
                setQuery(o.label);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--admin-gold)]/5 border-b border-[var(--admin-line)] last:border-0 flex items-center gap-2"
            >
              <span className="text-[var(--admin-ink)]">{o.label}</span>
              {o.abbreviation && <span className="text-[var(--admin-ink-faint)] text-[10px]">({o.abbreviation})</span>}
              {o.custom && (
                <span className="text-[8px] bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] text-[var(--admin-green)] px-1 py-0.5 rounded font-bold uppercase ml-auto">
                  Custom
                </span>
              )}
            </button>
          ))}
          {canAdd && (
            <button
              type="button"
              onClick={addVariant}
              disabled={saving}
              className="w-full text-left px-3 py-2 text-xs text-[var(--admin-gold)] font-bold hover:bg-[var(--admin-gold)]/5 border-t border-[var(--admin-line)] flex items-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add new variant &ldquo;{query.trim()}&rdquo;
            </button>
          )}
          {!filtered.length && !canAdd && (
            <div className="px-3 py-2 text-xs text-[var(--admin-ink-faint)]">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TcgCardSearch ───────────────────────────────────────────────────────────

export type TcgCardPick = {
  name: string;
  setName: string;
  setCode: string | null;
  number: string | null;
  year: string | null;
  imageUrl: string | null;
};

type TcgCardSearchProps = {
  /** "pokemon" | "mtg" | "yugioh" — defaults to pokemon. */
  game?: string;
  onPick: (card: TcgCardPick) => void;
  /** Seed the search box (e.g. with the current card name). */
  initialQuery?: string;
  testId?: string;
};

export function TcgCardSearch({ game = "pokemon", onPick, initialQuery, testId }: TcgCardSearchProps) {
  const { toast } = useToast();
  const [query, setQuery] = useState(initialQuery || "");
  const [results, setResults] = useState<TcgCardPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function run() {
    const qq = query.trim();
    if (qq.length < 2) {
      toast({ title: "Type at least 2 characters", variant: "destructive" });
      return;
    }
    setLoading(true);
    setResults([]);
    setOpen(true);
    try {
      const params = new URLSearchParams({ game, query: qq, mode: "wildcard" });
      const r = await adminFetch(`/api/staff/card-search?${params}`, { credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Search failed");
      const list: TcgCardPick[] = (Array.isArray(d) ? d : []).map((c: any) => ({
        name: c.name,
        setName: c.setName || "",
        setCode: c.setCode ?? null,
        number: c.number ?? null,
        year: c.year ?? null,
        imageUrl: c.imageUrl ?? null,
      }));
      setResults(list);
      if (!list.length) toast({ title: "No cards found", description: `No ${game} cards match “${qq}”.` });
    } catch (e: any) {
      toast({ title: "Card search failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex gap-1">
        <input
          type="text"
          value={query}
          placeholder="Search TCG cards by name…"
          data-testid={testId}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          className="flex-1 bg-[var(--admin-panel)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1 outline-none focus:border-[var(--admin-gold)]/60"
        />
        <button
          type="button"
          onClick={run}
          disabled={loading}
          data-testid={testId ? `${testId}-go` : undefined}
          className="shrink-0 border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] text-[10px] font-bold uppercase px-2 rounded hover:bg-[var(--admin-gold)]/10 disabled:opacity-40 flex items-center gap-1"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Search
        </button>
      </div>
      {open && (results.length > 0 || loading) && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg shadow-xl max-h-[28rem] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--admin-line)] sticky top-0 bg-[var(--admin-panel)]">
            <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">
              {loading ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </span>
            <button type="button" onClick={() => setOpen(false)} className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)]">
              <X size={13} />
            </button>
          </div>
          {results.map((c, i) => (
            <button
              key={`${c.name}-${c.setCode}-${c.number}-${i}`}
              type="button"
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-[var(--admin-gold)]/5 border-b border-[var(--admin-line)] last:border-0 flex items-center gap-3"
            >
              {/* Large image so finishes/art are comparable while scrolling. */}
              {c.imageUrl ? (
                <img
                  src={c.imageUrl}
                  alt={c.name}
                  loading="lazy"
                  className="w-24 h-auto rounded shadow shrink-0 bg-black/20"
                />
              ) : (
                <div className="w-24 h-32 rounded bg-black/20 shrink-0 flex items-center justify-center text-[9px] text-[var(--admin-ink-faint)]">
                  No image
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--admin-ink)] truncate">{c.name}</div>
                <div className="text-xs text-[var(--admin-ink-dim)] truncate">{c.setName}</div>
                <div className="text-[10px] text-[var(--admin-ink-faint)] mt-0.5">
                  {c.number ? `#${c.number}` : ""}
                  {c.setCode ? ` · ${c.setCode}` : ""}
                  {c.year ? ` · ${c.year}` : ""}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
