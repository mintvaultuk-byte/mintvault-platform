/**
 * /admin/community — community wall moderation + manual add.
 *
 * Sections: pending queue, manual add form (image upload), all-posts table
 * with status filter and approve/reject/feature controls. Also exposes a
 * "Pre-warm backgrounds" button that generates all 20 Segmind backgrounds.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Users, Star, Check, X, Sparkles } from "lucide-react";
import { AdminButton, Panel } from "@/components/admin";

interface Post {
  id: number;
  certNumber: string | null;
  instagramHandle: string | null;
  imageUrl: string | null;
  cardName: string | null;
  grade: number | null;
  featured: boolean;
  status: string;
  createdAt: string;
}

type Filter = "all" | "pending" | "approved" | "rejected" | "featured";

export default function AdminCommunityPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [form, setForm] = useState({
    instagramHandle: "",
    certNumber: "",
    cardName: "",
    grade: "",
    instagramPostUrl: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [prewarmMsg, setPrewarmMsg] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/community"] });

  const { data, isLoading } = useQuery<{ posts: Post[] }>({
    queryKey: ["/api/admin/community", filter],
    queryFn: async () => {
      const r = await fetch(`/api/admin/community?filter=${filter}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load posts");
      return r.json();
    },
  });
  const posts = data?.posts ?? [];
  const pending = posts.filter((p) => p.status === "pending");

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Image file required");
      const fd = new FormData();
      fd.append("imageFile", file);
      Object.entries(form).forEach(([k, v]) => v && fd.append(k, v));
      const r = await fetch("/api/admin/community", { method: "POST", credentials: "include", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Create failed");
      return j;
    },
    onSuccess: () => {
      setForm({ instagramHandle: "", certNumber: "", cardName: "", grade: "", instagramPostUrl: "" });
      setFile(null);
      setFormError(null);
      invalidate();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const patchMutation = useMutation({
    mutationFn: async (vars: { id: number; status?: "approved" | "rejected"; featured?: boolean }) => {
      const { id, ...patch } = vars;
      const r = await fetch(`/api/admin/community/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error("Update failed");
      return r.json();
    },
    onSuccess: invalidate,
  });

  const prewarmMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/share/prewarm", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Prewarm failed");
      return j as { generated: number; cached: number };
    },
    onSuccess: (j) => setPrewarmMsg(`Generated ${j.generated}, already cached ${j.cached}.`),
    onError: () => setPrewarmMsg("Prewarm failed — check the Segmind key."),
  });

  const setF = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const PostRow = ({ p }: { p: Post }) => (
    <div className="flex items-center gap-3 border-b border-[#1a1a1a] py-2">
      {p.imageUrl ? (
        <img src={p.imageUrl} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
      ) : (
        <div className="w-12 h-12 rounded bg-[#111] shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm truncate">{p.cardName || "—"}</div>
        <div className="text-[#888] text-xs">
          {p.instagramHandle ? `@${p.instagramHandle.replace(/^@/, "")}` : "no handle"} · {p.certNumber || "no cert"} ·
          grade {p.grade ?? "—"}
        </div>
      </div>
      <span
        className={`text-[10px] uppercase tracking-widest ${
          p.status === "approved" ? "text-[#22c55e]" : p.status === "rejected" ? "text-[#888]" : "text-[#f59e0b]"
        }`}
      >
        {p.status}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {p.status !== "approved" && (
          <AdminButton size="sm" onClick={() => patchMutation.mutate({ id: p.id, status: "approved" })}>
            <Check className="w-3.5 h-3.5" />
          </AdminButton>
        )}
        {p.status !== "rejected" && (
          <AdminButton size="sm" onClick={() => patchMutation.mutate({ id: p.id, status: "rejected" })}>
            <X className="w-3.5 h-3.5" />
          </AdminButton>
        )}
        <AdminButton
          size="sm"
          variant={p.featured ? "gold" : undefined}
          onClick={() => patchMutation.mutate({ id: p.id, featured: !p.featured })}
        >
          <Star className="w-3.5 h-3.5" />
        </AdminButton>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white px-4 md:px-8 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-[#D4AF37]" />
            <h1 className="text-xl font-bold tracking-wide">Community</h1>
          </div>
          <div className="flex items-center gap-2">
            {prewarmMsg && <span className="text-xs text-[#888]">{prewarmMsg}</span>}
            <AdminButton onClick={() => prewarmMutation.mutate()} disabled={prewarmMutation.isPending}>
              {prewarmMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              Pre-warm backgrounds
            </AdminButton>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-[#888]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {pending.length > 0 && (
          <Panel title="Pending queue" sub={`${pending.length} awaiting review`}>
            {pending.map((p) => (
              <PostRow key={p.id} p={p} />
            ))}
          </Panel>
        )}

        <Panel title="Manual add" sub="Auto-approved on save">
          <div className="space-y-3">
            <div className="grid md:grid-cols-2 gap-3">
              <input
                value={form.instagramHandle}
                onChange={(e) => setF("instagramHandle", e.target.value)}
                placeholder="Instagram handle"
                className="rounded border border-[#333] bg-[#111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
              <input
                value={form.certNumber}
                onChange={(e) => setF("certNumber", e.target.value)}
                placeholder="Cert number (MV206)"
                className="rounded border border-[#333] bg-[#111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
              <input
                value={form.cardName}
                onChange={(e) => setF("cardName", e.target.value)}
                placeholder="Card name"
                className="rounded border border-[#333] bg-[#111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
              <input
                value={form.grade}
                onChange={(e) => setF("grade", e.target.value)}
                placeholder="Grade (9)"
                type="number"
                step="0.5"
                className="rounded border border-[#333] bg-[#111] px-3 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-[#888] file:mr-3 file:rounded file:border-0 file:bg-[#D4AF37] file:px-3 file:py-1.5 file:text-[#1A1400] file:font-bold file:text-xs"
            />
            {formError && <p className="text-sm text-red-400">{formError}</p>}
            <AdminButton
              variant="gold"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !file}
            >
              {createMutation.isPending ? "Saving…" : "Add post"}
            </AdminButton>
          </div>
        </Panel>

        <Panel
          title="All posts"
          actions={
            <div className="flex gap-1.5">
              {(["all", "pending", "approved", "rejected", "featured"] as Filter[]).map((f) => (
                <AdminButton key={f} size="sm" variant={filter === f ? "gold" : undefined} onClick={() => setFilter(f)}>
                  {f}
                </AdminButton>
              ))}
            </div>
          }
        >
          {posts.length === 0 ? (
            <p className="text-sm text-[#888]">No posts.</p>
          ) : (
            posts.map((p) => <PostRow key={p.id} p={p} />)
          )}
        </Panel>
      </div>
    </div>
  );
}
