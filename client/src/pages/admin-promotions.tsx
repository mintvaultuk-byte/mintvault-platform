import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Save, Tag, ToggleLeft, ToggleRight, Pencil, AlertTriangle, Trash2 } from "lucide-react";

/**
 * Admin → Promotions. Create / activate / edit / deactivate the single active
 * promotion. Built to match admin-pricing.tsx exactly (raw Tailwind + --admin-*
 * tokens, default queryFn + apiRequest, inline status — no new design system).
 *
 * TIER MAPPING (do NOT mis-key): the promo columns are keyed by the CODE tier id
 * (standard/priority/express). Customers see different names. This is the single
 * source of that mapping:
 *     Vault Queue → standard_pct,  Standard → priority_pct,  Express → express_pct
 *
 * Coupon ids: the admin API returns *_coupon_id fields, but they are NEVER read
 * or displayed here — coupon ids are not surfaced in the UI.
 */

type StackingMode = "best_of" | "stack_on_top";

const TIERS = [
  { col: "standard_pct", customer: "Vault Queue", codeId: "standard" },
  { col: "priority_pct", customer: "Standard", codeId: "priority" },
  { col: "express_pct", customer: "Express", codeId: "express" },
] as const;

const QUICK_FILL = [10, 15, 20, 25, 30];

interface Promotion {
  id: number;
  name: string;
  banner_text: string;
  standard_pct: number;
  priority_pct: number;
  express_pct: number;
  stacking_mode: StackingMode;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FormState {
  name: string;
  banner_text: string;
  standard_pct: string;
  priority_pct: string;
  express_pct: string;
  stacking_mode: StackingMode;
  expires_at: string; // datetime-local value; "" = no expiry
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  banner_text: "",
  standard_pct: "0",
  priority_pct: "0",
  express_pct: "0",
  stacking_mode: "best_of",
  expires_at: "",
  active: true,
};

function clampPct(s: string): number {
  const n = Math.trunc(Number(s));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function isExpired(p: { expires_at: string | null }): boolean {
  return !!p.expires_at && new Date(p.expires_at).getTime() <= Date.now();
}

/** ISO (UTC) → local "YYYY-MM-DDTHH:mm" for the datetime-local input. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtExpiry(iso: string | null): string {
  if (!iso) return "no expiry";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "no expiry";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

const inputClass =
  "w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]";
const labelClass = "text-[var(--admin-ink-dim)] text-xs block mb-1";

export default function AdminPromotions() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const { data: listData, isLoading } = useQuery<{ promotions: Promotion[] }>({
    queryKey: ["/api/admin/promotions"],
  });
  const promotions = listData?.promotions ?? [];
  // Singleton index guarantees at most one active row. Derive it from the list
  // (not the expiry-filtered /active endpoint) so an expired-but-still-active row
  // can still be shown with an EXPIRED flag until the next activation clears it.
  const activeRow = promotions.find((p) => p.active) ?? null;

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/promotions"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/promotions/active"] });
    queryClient.invalidateQueries({ queryKey: ["/api/promotions/active"] }); // public pricing banner
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Client guard is UX only — the server validator (prompt 1) is the source
      // of truth and re-checks all of this.
      const body = {
        name: form.name.trim(),
        banner_text: form.banner_text.trim(),
        standard_pct: clampPct(form.standard_pct),
        priority_pct: clampPct(form.priority_pct),
        express_pct: clampPct(form.express_pct),
        stacking_mode: form.stacking_mode,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        active: form.active,
      };
      if (editingId) await apiRequest("PUT", `/api/admin/promotions/${editingId}`, body);
      else await apiRequest("POST", "/api/admin/promotions", body);
    },
    onSuccess: () => {
      invalidateAll();
      setEditingId(null);
      setForm(EMPTY_FORM);
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/admin/promotions/${id}/deactivate`);
    },
    onSuccess: () => {
      invalidateAll();
      setConfirmDeactivate(null);
    },
  });

  // Soft-delete (server sets deleted_at + active=false + audit). Removing the
  // active promo also stops it running. Requires a confirm step.
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/promotions/${id}`);
    },
    onSuccess: () => {
      invalidateAll();
      setConfirmDelete(null);
    },
  });

  function startEdit(p: Promotion) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      banner_text: p.banner_text,
      standard_pct: String(p.standard_pct),
      priority_pct: String(p.priority_pct),
      express_pct: String(p.express_pct),
      stacking_mode: p.stacking_mode === "stack_on_top" ? "stack_on_top" : "best_of",
      expires_at: toLocalInput(p.expires_at),
      active: p.active,
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setAllPct(v: number) {
    setForm((f) => ({ ...f, standard_pct: String(v), priority_pct: String(v), express_pct: String(v) }));
  }

  const saveError = saveMutation.isError ? (saveMutation.error as Error)?.message : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1
          className="text-2xl font-bold text-[var(--admin-gold-hi)] tracking-widest"
          data-testid="text-promotions-title"
        >
          PROMOTIONS
        </h1>
        <p className="text-[var(--admin-ink-faint)] text-sm">
          One promotion is live at a time. Discounts apply to grading checkout and show on the pricing page.
        </p>
      </div>

      {/* ── Active promotion ─────────────────────────────────────────────── */}
      {activeRow && (
        <div className="mb-6 border rounded-lg p-4 border-[var(--admin-line)]" data-testid="card-active-promo">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] text-[var(--admin-green)] border border-[var(--admin-line-soft)]">
                  ACTIVE
                </span>
                <h3 className="text-[var(--admin-gold-hi)] font-bold text-lg tracking-wider truncate">
                  {activeRow.name}
                </h3>
                {isExpired(activeRow) && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded border flex items-center gap-1"
                    style={{
                      color: "var(--admin-red)",
                      borderColor: "color-mix(in srgb, var(--admin-red) 50%, transparent)",
                    }}
                  >
                    <AlertTriangle size={11} /> EXPIRED
                  </span>
                )}
              </div>
              <p className="text-[var(--admin-ink-dim)] text-sm mt-2 italic">“{activeRow.banner_text}”</p>
              <div className="grid grid-cols-3 gap-3 mt-3" style={{ fontFamily: "var(--admin-mono)" }}>
                {TIERS.map((t) => (
                  <div key={t.col}>
                    <span className="text-[var(--admin-ink-faint)] text-xs block">{t.customer}</span>
                    <span className="text-[var(--admin-ink)] text-sm">{(activeRow as any)[t.col]}% off</span>
                  </div>
                ))}
              </div>
              <p className="text-[var(--admin-ink-faint)] text-xs mt-3">
                Stacking:{" "}
                <span className="text-[var(--admin-ink-dim)]">
                  {activeRow.stacking_mode === "stack_on_top" ? "Stack on top" : "Best of"}
                </span>
                {"  ·  "}Expiry:{" "}
                <span style={{ color: isExpired(activeRow) ? "var(--admin-red)" : "var(--admin-ink-dim)" }}>
                  {fmtExpiry(activeRow.expires_at)}
                </span>
              </p>
            </div>
            <div className="shrink-0 flex flex-col gap-2 items-end">
              {confirmDeactivate === activeRow.id ? (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => deactivateMutation.mutate(activeRow.id)}
                    disabled={deactivateMutation.isPending}
                    className="text-sm px-3 py-1.5 rounded border font-medium disabled:opacity-50"
                    style={{
                      color: "var(--admin-red)",
                      borderColor: "color-mix(in srgb, var(--admin-red) 50%, transparent)",
                    }}
                    data-testid="button-confirm-deactivate"
                  >
                    {deactivateMutation.isPending ? "Deactivating…" : "Confirm deactivate"}
                  </button>
                  <button
                    onClick={() => setConfirmDeactivate(null)}
                    className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-xs"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setConfirmDelete(null);
                    setConfirmDeactivate(activeRow.id);
                  }}
                  className="text-sm px-3 py-1.5 rounded border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] hover:border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] transition-colors"
                  data-testid="button-deactivate"
                >
                  Deactivate
                </button>
              )}

              {confirmDelete === activeRow.id ? (
                <div className="flex flex-col gap-1.5 items-end">
                  <button
                    onClick={() => deleteMutation.mutate(activeRow.id)}
                    disabled={deleteMutation.isPending}
                    className="text-sm px-3 py-1.5 rounded border font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
                    style={{
                      color: "var(--admin-red)",
                      borderColor: "color-mix(in srgb, var(--admin-red) 60%, transparent)",
                    }}
                    data-testid="button-confirm-delete"
                  >
                    <Trash2 size={13} />
                    {deleteMutation.isPending ? "Deleting…" : "Confirm delete — kills live promo"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-xs"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setConfirmDeactivate(null);
                    setConfirmDelete(activeRow.id);
                  }}
                  className="text-xs px-3 py-1.5 rounded border border-[var(--admin-line)] inline-flex items-center gap-1 hover:border-[color-mix(in_srgb,var(--admin-red)_50%,transparent)] transition-colors"
                  style={{ color: "var(--admin-red)" }}
                  data-testid="button-delete"
                >
                  <Trash2 size={12} /> Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create / edit form ───────────────────────────────────────────── */}
      <div className="border rounded-lg p-4 border-[var(--admin-line)] space-y-4">
        <div className="flex items-center gap-2">
          <Tag size={16} className="text-[var(--admin-gold)]" />
          <h2 className="text-[var(--admin-gold-hi)] font-bold tracking-wider">
            {editingId ? "Edit promotion" : "New promotion"}
          </h2>
        </div>

        <div>
          <label className="block">
            <span className={labelClass}>Name (internal, ≤100)</span>
            <input
              type="text"
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
              placeholder="e.g. Summer Sale"
              data-testid="input-promo-name"
            />
          </label>
        </div>

        <div>
          <label className="block">
            <span className={labelClass}>Banner text (shown to customers, ≤200)</span>
            <input
              type="text"
              maxLength={200}
              value={form.banner_text}
              onChange={(e) => setForm((f) => ({ ...f, banner_text: e.target.value }))}
              className={inputClass}
              placeholder="e.g. 25% off all grading this week"
              data-testid="input-promo-banner"
            />
          </label>
          {/* Live preview in the gold banner style */}
          <div
            className="mt-2 rounded-lg px-4 py-3 text-center font-bold text-sm"
            style={{
              color: "var(--admin-gold-hi)",
              border: "1px solid color-mix(in srgb, var(--admin-gold) 40%, transparent)",
              background: "color-mix(in srgb, var(--admin-gold) 8%, transparent)",
            }}
            data-testid="preview-promo-banner"
          >
            {form.banner_text.trim() || "Your banner preview…"}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className={labelClass}>Discount per tier (% off, 0–100; 0 = no discount)</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <span className="text-[var(--admin-ink-faint)] text-xs self-center mr-1">Quick fill all:</span>
            {QUICK_FILL.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAllPct(v)}
                className="text-xs px-2 py-1 rounded border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold-hi)] hover:border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] transition-colors"
                data-testid={`button-quickfill-${v}`}
              >
                {v}%
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TIERS.map((t) => (
              <div key={t.col}>
                <label className="block">
                  <span className={labelClass}>
                    {t.customer} <span className="text-[var(--admin-ink-faint)]">({t.codeId})</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={form[t.col]}
                    onChange={(e) => setForm((f) => ({ ...f, [t.col]: e.target.value }))}
                    className={inputClass}
                    style={{ fontFamily: "var(--admin-mono)" }}
                    data-testid={`input-pct-${t.codeId}`}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div>
          <span className={labelClass}>Stacking mode</span>
          <div className="flex gap-2">
            {[
              {
                mode: "best_of" as StackingMode,
                title: "Best of",
                help: "Customer gets the single biggest discount of Vault Club / bulk / promo. Never stacked.",
              },
              {
                mode: "stack_on_top" as StackingMode,
                title: "Stack on top",
                help: "Promo applies on top of Vault Club / bulk. More generous — watch margin.",
              },
            ].map((opt) => {
              const selected = form.stacking_mode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, stacking_mode: opt.mode }))}
                  className={`flex-1 text-left rounded border px-3 py-2 transition-colors ${
                    selected
                      ? "bg-[color-mix(in_srgb,var(--admin-gold)_14%,transparent)] border-[var(--admin-gold)]"
                      : "border-[var(--admin-line)] hover:border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)]"
                  }`}
                  data-testid={`button-stacking-${opt.mode}`}
                >
                  <div className="flex items-center gap-1.5">
                    {selected ? (
                      <ToggleRight size={16} className="text-[var(--admin-gold-hi)]" />
                    ) : (
                      <ToggleLeft size={16} className="text-[var(--admin-ink-faint)]" />
                    )}
                    <span
                      className={`text-sm font-medium ${selected ? "text-[var(--admin-gold-hi)]" : "text-[var(--admin-ink-dim)]"}`}
                    >
                      {opt.title}
                    </span>
                    {opt.mode === "best_of" && (
                      <span className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-wider">
                        recommended
                      </span>
                    )}
                  </div>
                  <p className="text-[var(--admin-ink-faint)] text-xs mt-1">{opt.help}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>Expiry (optional — empty = no expiry)</span>
            <input
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
              className={inputClass}
              style={{ fontFamily: "var(--admin-mono)" }}
              data-testid="input-promo-expiry"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
              className={`flex items-center gap-1.5 text-sm pb-2 ${form.active ? "text-[var(--admin-green)]" : "text-[var(--admin-ink-faint)]"}`}
              data-testid="button-toggle-active"
            >
              {form.active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
              {form.active ? "Set active on save" : "Save as inactive"}
            </button>
          </div>
        </div>

        {saveError && (
          <p className="text-sm" style={{ color: "var(--admin-red)" }} data-testid="text-save-error">
            {saveError}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name.trim() || !form.banner_text.trim()}
            className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_12%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_22%,transparent)] disabled:opacity-50 flex items-center gap-1.5"
            data-testid="button-save-promo"
          >
            <Save size={14} /> {saveMutation.isPending ? "Saving…" : editingId ? "Save changes" : "Create promotion"}
          </button>
          {editingId && (
            <button
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-sm px-4 py-2 rounded border border-[var(--admin-line)] hover:border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] transition-colors"
              data-testid="button-cancel-edit"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── Recent promotions ────────────────────────────────────────────── */}
      <div className="mt-6">
        <h2 className="text-[var(--admin-ink-dim)] text-xs uppercase tracking-widest mb-2">Recent promotions</h2>
        {isLoading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-[var(--admin-line-soft)] rounded" />
            ))}
          </div>
        ) : promotions.length === 0 ? (
          <div className="text-center py-8 border border-[var(--admin-line-soft)] rounded-lg">
            <p className="text-[var(--admin-ink-dim)] text-sm">No promotions yet.</p>
          </div>
        ) : (
          <div className="border border-[var(--admin-line-soft)] rounded-lg overflow-x-auto">
            <table className="w-full text-sm" style={{ fontFamily: "var(--admin-mono)" }}>
              <thead>
                <tr className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider border-b border-[var(--admin-line-soft)]">
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-left py-2 px-3 font-medium">VQ/Std/Exp</th>
                  <th className="text-left py-2 px-3 font-medium">Stacking</th>
                  <th className="text-left py-2 px-3 font-medium">Status</th>
                  <th className="text-left py-2 px-3 font-medium">Expiry</th>
                  <th className="text-left py-2 px-3 font-medium">Created</th>
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map((p) => {
                  const expired = isExpired(p);
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-[var(--admin-line-soft)] last:border-0"
                      data-testid={`row-promo-${p.id}`}
                    >
                      <td className="py-2 px-3 text-[var(--admin-ink)]">{p.name}</td>
                      <td className="py-2 px-3 text-[var(--admin-ink-dim)]">
                        {p.standard_pct}/{p.priority_pct}/{p.express_pct}
                      </td>
                      <td className="py-2 px-3 text-[var(--admin-ink-dim)]">
                        {p.stacking_mode === "stack_on_top" ? "stack" : "best"}
                      </td>
                      <td className="py-2 px-3">
                        {p.active ? (
                          <span style={{ color: expired ? "var(--admin-red)" : "var(--admin-green)" }}>
                            {expired ? "active·expired" : "active"}
                          </span>
                        ) : (
                          <span className="text-[var(--admin-ink-faint)]">inactive</span>
                        )}
                      </td>
                      <td
                        className="py-2 px-3 text-[var(--admin-ink-dim)]"
                        style={{ color: expired ? "var(--admin-red)" : undefined }}
                      >
                        {fmtExpiry(p.expires_at)}
                      </td>
                      <td className="py-2 px-3 text-[var(--admin-ink-faint)]">
                        {new Date(p.created_at).toLocaleDateString("en-GB", { dateStyle: "medium" } as any)}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {confirmDelete === p.id ? (
                          <span className="inline-flex items-center gap-3">
                            <button
                              onClick={() => deleteMutation.mutate(p.id)}
                              disabled={deleteMutation.isPending}
                              className="inline-flex items-center gap-1 disabled:opacity-50"
                              style={{ color: "var(--admin-red)" }}
                              data-testid={`button-confirm-delete-${p.id}`}
                            >
                              <Trash2 size={13} /> {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)]"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-3">
                            <button
                              onClick={() => startEdit(p)}
                              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold-hi)] inline-flex items-center gap-1"
                              data-testid={`button-edit-promo-${p.id}`}
                            >
                              <Pencil size={13} /> Edit
                            </button>
                            <button
                              onClick={() => {
                                setConfirmDeactivate(null);
                                setConfirmDelete(p.id);
                              }}
                              className="inline-flex items-center gap-1 hover:opacity-80"
                              style={{ color: "var(--admin-red)" }}
                              data-testid={`button-delete-promo-${p.id}`}
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PromoCodesSection />
    </div>
  );
}

type PromoCode = {
  id: number;
  code: string;
  label: string | null;
  percent: number;
  max_uses: number | null;
  uses_count: number;
  expires_at: string | null;
  active: boolean;
  created_at: string;
};

type CodeForm = { code: string; percent: string; max_uses: string; expires_at: string; active: boolean };
const EMPTY_CODE_FORM: CodeForm = { code: "", percent: "10", max_uses: "", expires_at: "", active: true };

/**
 * Promo codes — private, customer-entered discount codes (multiple at once),
 * distinct from the singleton auto-promo above. Same admin styling + tokens.
 */
function PromoCodesSection() {
  const [form, setForm] = useState<CodeForm>(EMPTY_CODE_FORM);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const { data, isLoading } = useQuery<{ codes: PromoCode[] }>({ queryKey: ["/api/admin/promo-codes"] });
  const codes = data?.codes ?? [];

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/promo-codes"] });
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      // Client guard is UX only — the server validator is the source of truth.
      const body = {
        code: form.code.trim().toUpperCase(),
        percent: Math.max(1, Math.min(100, Math.trunc(Number(form.percent) || 0))),
        max_uses: form.max_uses.trim() === "" ? null : Math.max(1, Math.trunc(Number(form.max_uses) || 0)),
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        active: form.active,
      };
      await apiRequest("POST", "/api/admin/promo-codes", body);
    },
    onSuccess: () => {
      refetch();
      setForm(EMPTY_CODE_FORM);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/promo-codes/${id}`);
    },
    onSuccess: () => {
      refetch();
      setConfirmDelete(null);
    },
  });

  const createError = createMutation.isError ? (createMutation.error as Error)?.message : null;

  return (
    <div className="mt-10 border-t border-[var(--admin-line-soft)] pt-8">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-[var(--admin-gold-hi)] tracking-widest">PROMO CODES</h2>
        <p className="text-[var(--admin-ink-faint)] text-sm">
          Private codes customers type at checkout. Multiple can exist; a code never stacks — the single biggest
          discount (code vs Vault Club / bulk / auto-promo) wins.
        </p>
      </div>

      {/* Create */}
      <div className="border rounded-lg p-4 border-[var(--admin-line)] space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>Code</span>
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              className={inputClass}
              placeholder="FRIEND15"
              data-testid="input-code"
            />
          </label>
          <label className="block">
            <span className={labelClass}>% off (1–100)</span>
            <input
              type="number"
              min={1}
              max={100}
              value={form.percent}
              onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))}
              className={inputClass}
              style={{ fontFamily: "var(--admin-mono)" }}
              data-testid="input-code-percent"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Max uses (blank = unlimited)</span>
            <input
              type="number"
              min={1}
              value={form.max_uses}
              onChange={(e) => setForm((f) => ({ ...f, max_uses: e.target.value }))}
              className={inputClass}
              style={{ fontFamily: "var(--admin-mono)" }}
              placeholder="unlimited"
              data-testid="input-code-maxuses"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Expiry (optional)</span>
            <input
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
              className={inputClass}
              style={{ fontFamily: "var(--admin-mono)" }}
              data-testid="input-code-expiry"
            />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
            className={`flex items-center gap-1.5 text-sm ${form.active ? "text-[var(--admin-green)]" : "text-[var(--admin-ink-faint)]"}`}
            data-testid="button-code-active"
          >
            {form.active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
            {form.active ? "Active" : "Inactive"}
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !form.code.trim()}
            className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_12%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_22%,transparent)] disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="button-create-code"
          >
            <Save size={14} /> {createMutation.isPending ? "Creating…" : "Create code"}
          </button>
        </div>
        {createError && (
          <p className="text-sm" style={{ color: "var(--admin-red)" }} data-testid="text-code-error">
            {createError}
          </p>
        )}
      </div>

      {/* List */}
      <div className="mt-5">
        {isLoading ? (
          <div className="animate-pulse h-10 bg-[var(--admin-line-soft)] rounded" />
        ) : codes.length === 0 ? (
          <div className="text-center py-6 border border-[var(--admin-line-soft)] rounded-lg">
            <p className="text-[var(--admin-ink-dim)] text-sm">No promo codes yet.</p>
          </div>
        ) : (
          <div className="border border-[var(--admin-line-soft)] rounded-lg overflow-x-auto">
            <table className="w-full text-sm" style={{ fontFamily: "var(--admin-mono)" }}>
              <thead>
                <tr className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider border-b border-[var(--admin-line-soft)]">
                  <th className="text-left py-2 px-3 font-medium">Code</th>
                  <th className="text-left py-2 px-3 font-medium">% off</th>
                  <th className="text-left py-2 px-3 font-medium">Uses</th>
                  <th className="text-left py-2 px-3 font-medium">Status</th>
                  <th className="text-left py-2 px-3 font-medium">Expiry</th>
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => {
                  const expired = isExpired(c);
                  const overCap = c.max_uses !== null && c.uses_count >= c.max_uses;
                  const status = !c.active ? "inactive" : expired ? "expired" : overCap ? "used up" : "active";
                  const statusColor =
                    status === "active"
                      ? "var(--admin-green)"
                      : status === "expired" || overCap
                        ? "var(--admin-red)"
                        : "var(--admin-ink-faint)";
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-[var(--admin-line-soft)] last:border-0"
                      data-testid={`row-code-${c.id}`}
                    >
                      <td className="py-2 px-3 text-[var(--admin-ink)] font-bold">{c.code}</td>
                      <td className="py-2 px-3 text-[var(--admin-ink-dim)]">{c.percent}%</td>
                      <td className="py-2 px-3 text-[var(--admin-ink-dim)]">
                        {c.uses_count}/{c.max_uses ?? "∞"}
                      </td>
                      <td className="py-2 px-3" style={{ color: statusColor }}>
                        {status}
                      </td>
                      <td
                        className="py-2 px-3 text-[var(--admin-ink-dim)]"
                        style={{ color: expired ? "var(--admin-red)" : undefined }}
                      >
                        {fmtExpiry(c.expires_at)}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {confirmDelete === c.id ? (
                          <span className="inline-flex items-center gap-3">
                            <button
                              onClick={() => deleteMutation.mutate(c.id)}
                              disabled={deleteMutation.isPending}
                              className="inline-flex items-center gap-1 disabled:opacity-50"
                              style={{ color: "var(--admin-red)" }}
                              data-testid={`button-confirm-delete-code-${c.id}`}
                            >
                              <Trash2 size={13} /> {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)]"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(c.id)}
                            className="inline-flex items-center gap-1 hover:opacity-80"
                            style={{ color: "var(--admin-red)" }}
                            data-testid={`button-delete-code-${c.id}`}
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
