/**
 * /admin/promotions — Promotions engine admin panel.
 *
 * One active promotion at a time. Activation creates Stripe coupons
 * server-side; the pricing page banner + checkout discounts follow the
 * active promo automatically. Sections:
 *   - Active promotion card (deactivate w/ confirm)
 *   - Create / edit form (per-tier percents, quick-fill, expiry, activate)
 *   - Recent promotions history (last 20, read-only)
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Megaphone, Trash2 } from "lucide-react";
import { AdminButton, Panel } from "@/components/admin";

interface Promotion {
  id: number;
  name: string;
  bannerText: string;
  vaultQueuePct: number;
  standardPct: number;
  expressPct: number;
  blackLabelPct: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FormState {
  name: string;
  banner_text: string;
  vault_queue_pct: number;
  standard_pct: number;
  express_pct: number;
  black_label_pct: number;
  expires_at: string; // datetime-local value or ""
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  banner_text: "",
  vault_queue_pct: 0,
  standard_pct: 0,
  express_pct: 0,
  black_label_pct: 0,
  expires_at: "",
  active: false,
};

type TierPctKey = "vault_queue_pct" | "standard_pct" | "express_pct" | "black_label_pct";
const TIER_FIELDS: Array<{ key: TierPctKey; label: string }> = [
  { key: "vault_queue_pct", label: "Vault Queue" },
  { key: "standard_pct", label: "Standard" },
  { key: "express_pct", label: "Express" },
  { key: "black_label_pct", label: "Black Label" },
];
// Form key → Promotion record key (camelCase API shape)
const TIER_RECORD_KEY: Record<TierPctKey, keyof Promotion> = {
  vault_queue_pct: "vaultQueuePct",
  standard_pct: "standardPct",
  express_pct: "expressPct",
  black_label_pct: "blackLabelPct",
};

const QUICK_FILLS = [10, 15, 20, 25, 30];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminPromotionsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const { data, isLoading } = useQuery<{ promotions: Promotion[] }>({
    queryKey: ["/api/admin/promotions"],
    queryFn: async () => {
      const r = await fetch("/api/admin/promotions", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load promotions");
      return r.json();
    },
  });

  const promotions = data?.promotions ?? [];
  const active = promotions.find((p) => p.active) ?? null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/promotions"] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        name: form.name.trim(),
        banner_text: form.banner_text.trim(),
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      };
      const url = editingId != null ? `/api/admin/promotions/${editingId}` : "/api/admin/promotions";
      const r = await fetch(url, {
        method: editingId != null ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      return j;
    },
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setEditingId(null);
      setFormError(null);
      invalidate();
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/admin/promotions/${id}/deactivate`, { method: "DELETE", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Deactivate failed");
      return j;
    },
    onSuccess: () => {
      setConfirmDeactivate(false);
      invalidate();
    },
  });

  const setField = (key: keyof FormState, value: string | number | boolean) => setForm((f) => ({ ...f, [key]: value }));

  const setAllTiers = (pct: number) =>
    setForm((f) => ({ ...f, vault_queue_pct: pct, standard_pct: pct, express_pct: pct, black_label_pct: pct }));

  const startEdit = (p: Promotion) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      banner_text: p.bannerText,
      vault_queue_pct: p.vaultQueuePct,
      standard_pct: p.standardPct,
      express_pct: p.expressPct,
      black_label_pct: p.blackLabelPct,
      expires_at: p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 16) : "",
      active: p.active,
    });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white px-4 md:px-8 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Megaphone className="w-6 h-6 text-[#D4AF37]" />
          <h1 className="text-xl font-bold tracking-wide">Promotions</h1>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-[#888]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {/* ── Active promotion ── */}
        {active && (
          <Panel
            title="Active promotion"
            sub={`Live on the pricing page and applied at checkout${active.expiresAt ? ` · expires ${fmtDate(active.expiresAt)}` : ""}`}
            actions={
              confirmDeactivate ? (
                <>
                  <span className="text-xs text-[#CCCCCC]">Deactivate "{active.name}"?</span>
                  <AdminButton
                    variant="gold"
                    onClick={() => deactivateMutation.mutate(active.id)}
                    disabled={deactivateMutation.isPending}
                  >
                    {deactivateMutation.isPending ? "Deactivating…" : "Confirm"}
                  </AdminButton>
                  <AdminButton onClick={() => setConfirmDeactivate(false)}>Cancel</AdminButton>
                </>
              ) : (
                <AdminButton onClick={() => setConfirmDeactivate(true)}>
                  <Trash2 className="w-3.5 h-3.5" /> Deactivate
                </AdminButton>
              )
            }
          >
            <div className="space-y-3">
              <div>
                <div className="text-lg font-bold text-white">{active.name}</div>
                <div
                  className="mt-2 rounded px-4 py-2 text-sm font-bold text-center"
                  style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)", color: "#1A1400" }}
                >
                  {active.bannerText}
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {TIER_FIELDS.map((t) => {
                  const pct = active[TIER_RECORD_KEY[t.key]] as number;
                  return (
                    <div key={t.key} className="rounded border border-[#222222] bg-[#111111] px-3 py-2 text-center">
                      <div className="text-[10px] uppercase tracking-widest text-[#888888]">{t.label}</div>
                      <div className={`text-xl font-bold ${pct > 0 ? "text-[#D4AF37]" : "text-[#555555]"}`}>
                        {pct > 0 ? `${pct}%` : "—"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Panel>
        )}

        {/* ── Create / edit form ── */}
        <Panel
          title={editingId != null ? `Edit promotion #${editingId}` : "Create promotion"}
          sub="Activation creates Stripe coupons and replaces any currently active promotion."
          actions={
            editingId != null ? (
              <AdminButton
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                  setFormError(null);
                }}
              >
                Cancel edit
              </AdminButton>
            ) : undefined
          }
        >
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-xs uppercase tracking-widest text-[#888888]">Name</span>
                <input
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  maxLength={100}
                  placeholder="Launch Week"
                  className="mt-1 w-full rounded border border-[#333333] bg-[#111111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-widest text-[#888888]">Expiry (optional)</span>
                <input
                  type="datetime-local"
                  value={form.expires_at}
                  onChange={(e) => setField("expires_at", e.target.value)}
                  className="mt-1 w-full rounded border border-[#333333] bg-[#111111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs uppercase tracking-widest text-[#888888]">Banner text</span>
              <input
                value={form.banner_text}
                onChange={(e) => setField("banner_text", e.target.value)}
                maxLength={200}
                placeholder="Launch week — 20% off all grading tiers"
                className="mt-1 w-full rounded border border-[#333333] bg-[#111111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
            </label>
            {form.banner_text.trim() && (
              <div
                className="rounded px-4 py-2 text-sm font-bold text-center"
                style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)", color: "#1A1400" }}
              >
                {form.banner_text}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-widest text-[#888888]">
                  Tier discounts (% off, 0 = none)
                </span>
                <div className="flex gap-1.5">
                  {QUICK_FILLS.map((pct) => (
                    <AdminButton key={pct} size="sm" onClick={() => setAllTiers(pct)}>
                      {pct}%
                    </AdminButton>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {TIER_FIELDS.map((t) => (
                  <label key={t.key} className="block">
                    <span className="text-[10px] uppercase tracking-widest text-[#888888]">{t.label}</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form[t.key] as number}
                      onChange={(e) => setField(t.key, Math.max(0, Math.min(100, parseInt(e.target.value || "0", 10))))}
                      className="mt-1 w-full rounded border border-[#333333] bg-[#111111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                    />
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setField("active", e.target.checked)}
                className="accent-[#D4AF37]"
              />
              <span className="text-sm text-[#CCCCCC]">
                Set as active (creates Stripe coupons, replaces current promo)
              </span>
            </label>

            {formError && <p className="text-sm text-red-400">{formError}</p>}

            <AdminButton
              variant="gold"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !form.name.trim() || !form.banner_text.trim()}
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…
                </>
              ) : editingId != null ? (
                "Update promotion"
              ) : (
                "Save promotion"
              )}
            </AdminButton>
          </div>
        </Panel>

        {/* ── History ── */}
        <Panel title="Recent promotions" sub="Last 20 — newest first">
          {promotions.length === 0 ? (
            <p className="text-sm text-[#888888]">No promotions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-[#888888] border-b border-[#222222]">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">VQ / Std / Exp / BL</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Expires</th>
                    <th className="py-2 pr-3">Created</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {promotions.map((p) => (
                    <tr key={p.id} className="border-b border-[#1a1a1a]">
                      <td className="py-2 pr-3 text-white">{p.name}</td>
                      <td className="py-2 pr-3 text-[#CCCCCC] tabular-nums">
                        {p.vaultQueuePct}% / {p.standardPct}% / {p.expressPct}% / {p.blackLabelPct}%
                      </td>
                      <td className="py-2 pr-3">
                        {p.active ? (
                          <span className="text-[#D4AF37] font-bold">ACTIVE</span>
                        ) : (
                          <span className="text-[#555555]">inactive</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-[#888888]">{fmtDate(p.expiresAt)}</td>
                      <td className="py-2 pr-3 text-[#888888]">{fmtDate(p.createdAt)}</td>
                      <td className="py-2 text-right">
                        <AdminButton size="sm" onClick={() => startEdit(p)}>
                          Edit
                        </AdminButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
