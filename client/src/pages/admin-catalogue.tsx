/**
 * Admin → System → Catalogue Manager (Super Admin only).
 *
 * The single place to manage every grading classification list — rarities,
 * finishes, promo types, designations, languages, eras, subsets and optional
 * card attributes — with no code deploy. Backed by /api/admin/catalogue/* and
 * the catalogue_items table; the grading pickers load the same data live.
 *
 * Server enforces Super Admin on every write; this page is a thin client over
 * that API. Nothing here touches certificates, grading, or label rendering.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, AdminButton, Badge } from "@/components/admin";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";
import { useToast } from "@/hooks/use-toast";
import { adminFetch, apiRequest } from "@/lib/queryClient";
import { CATALOGUE_CATEGORIES } from "@shared/vocabulary";
import type { CatalogueCategory } from "@shared/vocabulary";
import type { CatalogueItem } from "@shared/schema";

const CATEGORY_LABELS: Record<CatalogueCategory, string> = {
  rarity: "Rarities",
  finish: "Finishes",
  promo: "Promo Types",
  designation: "Designations",
  language: "Languages",
  era: "Eras",
  subset: "Optional Subsets",
  attribute: "Optional Card Attributes",
};

interface EditorState {
  id?: number;
  category: CatalogueCategory;
  value: string;
  label: string;
  abbreviation: string;
  aliases: string;
  description: string;
  notes: string;
  metadata: string;
  allowCrossCategory: boolean;
  active: boolean;
  archived: boolean;
}

function emptyEditor(category: CatalogueCategory): EditorState {
  return {
    category,
    value: "",
    label: "",
    abbreviation: "",
    aliases: "",
    description: "",
    notes: "",
    metadata: "{}",
    allowCrossCategory: false,
    active: true,
    archived: false,
  };
}

function toEditor(item: CatalogueItem): EditorState {
  return {
    id: item.id,
    category: item.category as CatalogueCategory,
    value: item.value,
    label: item.label,
    abbreviation: item.abbreviation ?? "",
    aliases: (item.aliases ?? []).join(", "),
    description: item.description ?? "",
    notes: item.notes ?? "",
    metadata: JSON.stringify(item.metadata ?? {}, null, 2),
    allowCrossCategory: item.allowCrossCategory,
    active: item.active,
    archived: item.archived,
  };
}

const input =
  "w-full rounded-md border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500";

export default function AdminCataloguePage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<CatalogueCategory>("rarity");
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [busy, setBusy] = useState(false);

  const itemsQuery = useQuery({
    queryKey: ["catalogue-items", category, search, includeArchived],
    queryFn: async () => {
      const params = new URLSearchParams({ category, includeArchived: String(includeArchived) });
      if (search.trim()) params.set("search", search.trim());
      const res = await adminFetch(`/api/admin/catalogue/items?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load catalogue.");
      return (await res.json()) as { items: CatalogueItem[] };
    },
  });

  const auditQuery = useQuery({
    queryKey: ["catalogue-audit"],
    enabled: showAudit,
    queryFn: async () => {
      const res = await adminFetch("/api/admin/catalogue/audit?limit=100", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load audit log.");
      return (await res.json()) as { entries: Array<{ id: number; action: string; entityId: string; adminUser: string | null; details: Record<string, unknown>; createdAt: string }> };
    },
  });

  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["catalogue-items"] });
    qc.invalidateQueries({ queryKey: ["/api/catalogue/snapshot"] });
    qc.invalidateQueries({ queryKey: ["catalogue-audit"] });
  }

  async function run(fn: () => Promise<void>, successMsg?: string) {
    setBusy(true);
    try {
      await fn();
      if (successMsg) toast({ title: successMsg });
      invalidate();
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editor) return;
    let metadata: Record<string, unknown>;
    try {
      metadata = editor.metadata.trim() ? JSON.parse(editor.metadata) : {};
    } catch {
      toast({ title: "Invalid metadata JSON", variant: "destructive" });
      return;
    }
    const body = {
      category: editor.category,
      value: editor.value.trim(),
      label: editor.label.trim(),
      abbreviation: editor.abbreviation.trim() || null,
      aliases: editor.aliases.split(",").map((s) => s.trim()).filter(Boolean),
      description: editor.description.trim(),
      notes: editor.notes.trim() || null,
      metadata,
      allowCrossCategory: editor.allowCrossCategory,
      active: editor.active,
      archived: editor.archived,
    };
    await run(async () => {
      if (editor.id) {
        await apiRequest("PUT", `/api/admin/catalogue/items/${editor.id}`, body);
      } else {
        await apiRequest("POST", "/api/admin/catalogue/items", body);
      }
      setEditor(null);
    }, editor.id ? "Saved." : "Added.");
  }

  async function toggleActive(item: CatalogueItem) {
    await run(
      () => apiRequest("POST", `/api/admin/catalogue/items/${item.id}/active`, { active: !item.active }).then(() => undefined),
      item.active ? "Disabled." : "Enabled.",
    );
  }

  async function toggleArchive(item: CatalogueItem) {
    await run(
      () => apiRequest("POST", `/api/admin/catalogue/items/${item.id}/archive`, { archived: !item.archived }).then(() => undefined),
      item.archived ? "Restored." : "Archived.",
    );
  }

  async function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= items.length) return;
    const ordered = [...items];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(next, 0, moved);
    await run(() =>
      apiRequest("POST", "/api/admin/catalogue/reorder", {
        category,
        orderedIds: ordered.map((i) => i.id),
      }).then(() => undefined),
    );
  }

  async function exportJson() {
    const res = await adminFetch("/api/admin/catalogue/export", { credentials: "include" });
    if (!res.ok) {
      toast({ title: "Export failed", variant: "destructive" });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalogue-export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    const text = await file.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      toast({ title: "Invalid JSON file", variant: "destructive" });
      return;
    }
    await run(async () => {
      const res = await apiRequest("POST", "/api/admin/catalogue/import", payload);
      const { result } = (await res.json()) as { result: { created: number; updated: number; skipped: number } };
      toast({ title: `Imported: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped.` });
    });
  }

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-200" data-testid="admin-catalogue">
      <AdminHeaderRow
        left={<h1 className="text-lg font-bold text-slate-100">System · Catalogue Manager</h1>}
        right={
          <div className="flex items-center gap-2">
            <AdminButton size="sm" onClick={() => setShowAudit((s) => !s)} data-testid="btn-audit">
              {showAudit ? "Hide audit" : "Audit log"}
            </AdminButton>
            <AdminButton size="sm" onClick={exportJson} data-testid="btn-export">Export</AdminButton>
            <AdminButton size="sm" onClick={() => fileRef.current?.click()} data-testid="btn-import">Import</AdminButton>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = "";
              }}
            />
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5" data-testid="category-tabs">
        {CATALOGUE_CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            data-testid={`tab-${c}`}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              category === c ? "bg-amber-500 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className={`${input} max-w-xs`}
            placeholder="Search name / abbreviation / aliases / description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search"
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            Show archived
          </label>
          <div className="ml-auto">
            <AdminButton variant="gold" size="sm" onClick={() => setEditor(emptyEditor(category))} data-testid="btn-add">
              + Add {CATEGORY_LABELS[category].replace(/s$/, "")}
            </AdminButton>
          </div>
        </div>

        {itemsQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No entries yet. Add one to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="catalogue-table">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="w-16 px-2 py-1">Order</th>
                  <th className="px-2 py-1">Label</th>
                  <th className="px-2 py-1">Value</th>
                  <th className="px-2 py-1">Abbr.</th>
                  <th className="px-2 py-1">Aliases</th>
                  <th className="px-2 py-1">State</th>
                  <th className="px-2 py-1 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.id} className="border-t border-slate-800" data-testid={`row-${item.value}`}>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1" title={search.trim() ? "Clear the search to reorder" : undefined}>
                        <button className="text-slate-500 hover:text-amber-400 disabled:opacity-30" disabled={busy || i === 0 || Boolean(search.trim())} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
                        <button className="text-slate-500 hover:text-amber-400 disabled:opacity-30" disabled={busy || i === items.length - 1 || Boolean(search.trim())} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 font-medium text-slate-100">{item.label}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-400">{item.value}</td>
                    <td className="px-2 py-1.5 text-slate-400">{item.abbreviation ?? "—"}</td>
                    <td className="max-w-[16rem] truncate px-2 py-1.5 text-xs text-slate-500">{(item.aliases ?? []).join(", ") || "—"}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1">
                        <Badge variant={item.active ? "act" : "neu"}>{item.active ? "Active" : "Inactive"}</Badge>
                        {item.archived && <Badge variant="neu">Archived</Badge>}
                        {item.allowCrossCategory && <Badge variant="wait">Cross-cat</Badge>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex justify-end gap-1">
                        <AdminButton size="sm" onClick={() => setEditor(toEditor(item))} data-testid={`btn-edit-${item.value}`}>Edit</AdminButton>
                        <AdminButton size="sm" onClick={() => toggleActive(item)} disabled={busy}>{item.active ? "Disable" : "Enable"}</AdminButton>
                        <AdminButton size="sm" onClick={() => toggleArchive(item)} disabled={busy}>{item.archived ? "Restore" : "Archive"}</AdminButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {showAudit && (
        <Panel>
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Recent catalogue changes</h2>
          {auditQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <div className="max-h-72 overflow-y-auto text-xs">
              {(auditQuery.data?.entries ?? []).map((e) => (
                <div key={e.id} className="border-t border-slate-800 py-1.5" data-testid="audit-entry">
                  <span className="font-mono text-amber-400">{e.action}</span>{" "}
                  <span className="text-slate-300">{e.entityId}</span>{" "}
                  <span className="text-slate-500">by {e.adminUser ?? "—"} · {new Date(e.createdAt).toLocaleString()}</span>
                  {typeof e.details?.reason === "string" && e.details.reason && (
                    <span className="text-slate-400"> · {String(e.details.reason)}</span>
                  )}
                </div>
              ))}
              {(auditQuery.data?.entries ?? []).length === 0 && <p className="text-slate-500">No changes recorded yet.</p>}
            </div>
          )}
        </Panel>
      )}

      {editor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setEditor(null)}>
          <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()} data-testid="catalogue-editor">
            <h2 className="mb-3 text-base font-bold text-slate-100">
              {editor.id ? "Edit" : "Add"} — {CATEGORY_LABELS[editor.category]}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">
                Value (machine, unique)
                <input className={input} value={editor.value} disabled={Boolean(editor.id)} onChange={(e) => setEditor({ ...editor, value: e.target.value })} data-testid="field-value" />
              </label>
              <label className="text-xs text-slate-400">
                Label
                <input className={input} value={editor.label} onChange={(e) => setEditor({ ...editor, label: e.target.value })} data-testid="field-label" />
              </label>
              <label className="text-xs text-slate-400">
                Abbreviation
                <input className={input} value={editor.abbreviation} onChange={(e) => setEditor({ ...editor, abbreviation: e.target.value })} data-testid="field-abbr" />
              </label>
              <label className="text-xs text-slate-400">
                Aliases (comma-separated)
                <input className={input} value={editor.aliases} onChange={(e) => setEditor({ ...editor, aliases: e.target.value })} data-testid="field-aliases" />
              </label>
            </div>
            <label className="mt-3 block text-xs text-slate-400">
              Description
              <input className={input} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} />
            </label>
            <label className="mt-3 block text-xs text-slate-400">
              Notes
              <input className={input} value={editor.notes} onChange={(e) => setEditor({ ...editor, notes: e.target.value })} />
            </label>
            <label className="mt-3 block text-xs text-slate-400">
              Metadata (advanced — JSON; e.g. a rarity symbol {"{shape,colour,count,glyph}"})
              <textarea className={`${input} h-24 font-mono`} value={editor.metadata} onChange={(e) => setEditor({ ...editor, metadata: e.target.value })} data-testid="field-metadata" />
            </label>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={editor.active} onChange={(e) => setEditor({ ...editor, active: e.target.checked })} /> Active
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={editor.archived} onChange={(e) => setEditor({ ...editor, archived: e.target.checked })} /> Archived
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={editor.allowCrossCategory} onChange={(e) => setEditor({ ...editor, allowCrossCategory: e.target.checked })} /> Allow cross-category
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <AdminButton size="sm" onClick={() => setEditor(null)}>Cancel</AdminButton>
              <AdminButton variant="gold" size="sm" onClick={save} disabled={busy} data-testid="btn-save">
                {editor.id ? "Save changes" : "Add entry"}
              </AdminButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
