import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Archive, Check, Edit3, Search, X } from "lucide-react";
import AdminShell from "@/components/admin/admin-shell";
import { apiRequest } from "@/lib/queryClient";

type SetSource = "custom" | "tcgdex" | "card_sets";
type TcgBrand = "pokemon" | "sports" | "one_piece" | "yugioh" | "magic" | "lorcana" | "other";
type TabKey = "all" | "needs_attention" | "archived";

type Suggestion = {
  key: string;
  label: string;
  severity: "confirmed_issue" | "possible_duplicate" | "missing_information" | "suggested_cleanup";
  current: Record<string, unknown>;
  suggested: Record<string, unknown>;
  dismissed?: boolean;
};

type SetRow = {
  uid: string;
  source: SetSource;
  setId: string;
  setName: string;
  tcg: TcgBrand;
  series: string | null;
  releaseYear: number | null;
  totalCards: number | null;
  subset: string | null;
  archived: boolean;
  updatedAt: string | null;
  publishedCardCount: number | null;
  linkedCards: number;
  linkedCertificates: number;
  issueLabels: string[];
  suggestions: Suggestion[];
};

type SetLibraryResponse = {
  sets: SetRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  bounded: true;
};

type EditDraft = {
  setId: string;
  setName: string;
  tcg: TcgBrand;
  series: string;
  releaseYear: string;
  totalCards: string;
  subset: string;
  archived: boolean;
  reason: string;
  approvedSuggestionId?: string;
};

const TCG_OPTIONS: Array<{ value: TcgBrand; label: string }> = [
  { value: "pokemon", label: "Pokemon" },
  { value: "sports", label: "Sports" },
  { value: "one_piece", label: "One Piece" },
  { value: "yugioh", label: "Yu-Gi-Oh!" },
  { value: "magic", label: "Magic" },
  { value: "lorcana", label: "Lorcana" },
  { value: "other", label: "Other" },
];

const SORT_OPTIONS = [
  ["name_az", "Name A-Z"],
  ["name_za", "Name Z-A"],
  ["code_low_high", "Set code low-high"],
  ["code_high_low", "Set code high-low"],
  ["oldest", "Oldest first"],
  ["newest", "Newest first"],
  ["most_linked_certificates", "Most linked certificates"],
] as const;

const FILTER_OPTIONS = [
  ["active", "Active"],
  ["archived", "Archived"],
  ["pokemon", "Pokemon"],
  ["sports", "Sports"],
  ["one_piece", "One Piece"],
  ["yugioh", "Yu-Gi-Oh!"],
  ["magic", "Magic"],
  ["lorcana", "Lorcana"],
  ["other", "Other"],
  ["missing_details", "Missing details"],
  ["overlong_names", "Overlong names"],
  ["possible_duplicates", "Possible duplicates"],
] as const;

const inputCls =
  "rounded border border-[#D4AF37]/25 bg-black px-3 py-2 text-sm text-[#E8E4DC] outline-none focus:border-[#D4AF37]";
const compactBtn =
  "inline-flex items-center gap-1 rounded border border-[#D4AF37]/25 bg-black px-2.5 py-1.5 text-xs font-semibold text-[#E8E4DC] hover:border-[#D4AF37]/60 disabled:opacity-50";

function sourceLabel(source: SetSource): string {
  if (source === "tcgdex") return "TCGdex";
  if (source === "card_sets") return "Legacy";
  return "Custom";
}

function sourceBadgeClass(source: SetSource): string {
  if (source === "tcgdex") return "border-sky-400/35 bg-sky-500/10 text-sky-200";
  if (source === "card_sets") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  return "border-emerald-400/35 bg-emerald-500/10 text-emerald-200";
}

function adminBlockedMsg(status: number, err?: string): string | null {
  if (status === 403 && /graders cannot access admin/i.test(err || "")) {
    return "This browser is signed into the staff portal. Sign in again at /admin/login to manage sets.";
  }
  return null;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const statusValue = (error as Error & { status?: unknown }).status;
    const status = typeof statusValue === "number" ? statusValue : 0;
    return adminBlockedMsg(status, error.message) || error.message || fallback;
  }
  return fallback;
}

function draftFrom(row: SetRow, patch: Partial<EditDraft> = {}): EditDraft {
  return {
    setId: row.setId,
    setName: row.setName,
    tcg: row.tcg,
    series: row.series || "",
    releaseYear: row.releaseYear == null ? "" : String(row.releaseYear),
    totalCards: row.totalCards == null ? "" : String(row.totalCards),
    subset: row.subset || "",
    archived: row.archived,
    reason: "",
    ...patch,
  };
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString();
}

function activeIssues(row: SetRow): Suggestion[] {
  return row.suggestions.filter((s) => !s.dismissed);
}

export default function AdminSetsPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("name_az");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SetLibraryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: SetRow; draft: EditDraft } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "include" });
        const d = await res.json().catch(() => ({}));
        setAuthed(res.ok && d.authenticated === true);
      } catch {
        setAuthed(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/sets", { replace: true });
  }, [authed, navigate]);

  const filterString = useMemo(() => Array.from(filters).sort().join(","), [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ tab, sort, page: String(page), pageSize: "50" });
      if (q.trim()) params.set("q", q.trim());
      if (filterString) params.set("filters", filterString);
      const res = await apiRequest("GET", `/api/admin/sets?${params.toString()}`);
      setData(await res.json());
    } catch (error) {
      setErr(messageFromError(error, "Unable to load sets."));
    } finally {
      setLoading(false);
    }
  }, [filterString, page, q, sort, tab]);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  function toggleFilter(key: string) {
    setPage(1);
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const { row, draft } = editing;
    setMsg(null);
    setErr(null);
    const cleanName = draft.setName.trim();
    const cleanCode = draft.setId.replace(/\s+/g, "").toLowerCase();
    if (!cleanName) return setErr("Set name is required.");
    if (!cleanCode) return setErr("Set code is required.");
    const codeChanged = cleanCode !== row.setId;
    const nameChanged = cleanName !== row.setName;
    let confirmLinkedCardUpdate = false;
    if (nameChanged || codeChanged) {
      const prompt = codeChanged
        ? `Save this set code change for the ${sourceLabel(row.source)} record?\n\nLinked draft/card-master records using ${row.setId} will be updated to ${cleanCode}. Issued certificate text will not be rewritten.`
        : "Save this set name change? Issued certificate text will not be rewritten.";
      if (!window.confirm(prompt)) return;
      confirmLinkedCardUpdate = codeChanged;
    }
    try {
      await apiRequest("PATCH", `/api/admin/sets/${row.source}/${encodeURIComponent(row.setId)}`, {
        ...draft,
        setId: cleanCode,
        setName: cleanName,
        releaseYear: draft.releaseYear.trim(),
        totalCards: draft.totalCards.trim(),
        confirmLinkedCardUpdate,
      });
      setMsg("Set updated.");
      setEditing(null);
      await load();
    } catch (error) {
      setErr(messageFromError(error, "Set was not updated."));
    }
  }

  async function decide(row: SetRow, suggestion: Suggestion, decision: "reject" | "ignore") {
    setMsg(null);
    setErr(null);
    const reason = window.prompt(`${decision === "reject" ? "Reject" : "Ignore"} "${suggestion.label}" reason:`);
    if (reason === null) return;
    try {
      await apiRequest("POST", `/api/admin/sets/${row.source}/${encodeURIComponent(row.setId)}/review`, {
        suggestionKey: suggestion.key,
        decision,
        reason,
      });
      setMsg(decision === "reject" ? "Suggestion rejected." : "Suggestion ignored.");
      await load();
    } catch (error) {
      setErr(messageFromError(error, "Review decision was not saved."));
    }
  }

  function approveSuggestion(row: SetRow, suggestion: Suggestion) {
    const patch: Partial<EditDraft> = { approvedSuggestionId: suggestion.key, reason: `Approved: ${suggestion.label}` };
    if (typeof suggestion.suggested.setName === "string") patch.setName = suggestion.suggested.setName;
    if (typeof suggestion.suggested.setId === "string") patch.setId = suggestion.suggested.setId;
    if (typeof suggestion.suggested.subset === "string") patch.subset = suggestion.suggested.subset;
    if (typeof suggestion.suggested.tcg === "string") patch.tcg = suggestion.suggested.tcg as TcgBrand;
    if (typeof suggestion.suggested.archived === "boolean") patch.archived = suggestion.suggested.archived;
    setEditing({ row, draft: draftFrom(row, patch) });
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    navigate("/cert");
  }

  if (authed !== true) {
    return (
      <div className="admin-root flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#D4AF37] border-t-transparent" />
      </div>
    );
  }

  const rows = data?.sets || [];

  return (
    <AdminShell
      activeTab="sets"
      onTabChange={() => navigate("/admin")}
      onLogout={logout}
      title="Sets"
      crumb="MINTVAULT · RECORDS"
    >
      <div className="space-y-4">
        <section className="rounded border border-[#D4AF37]/20 bg-black/55 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-xl font-semibold text-[#E8E4DC]">Set Library</h1>
              <p className="mt-1 max-w-3xl text-sm text-[#E8E4DC]/60">
                Search, review and correct existing TCG set records without creating duplicates.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["all", "needs_attention", "archived"] as TabKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key);
                    setPage(1);
                  }}
                  className={`${compactBtn} ${tab === key ? "border-[#D4AF37] text-[#D4AF37]" : ""}`}
                >
                  {key === "all" ? "All Sets" : key === "needs_attention" ? "Needs Attention" : "Archived"}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(220px,1fr)_220px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#D4AF37]" />
              <input
                className={`${inputCls} w-full pl-9`}
                value={q}
                onChange={(event) => {
                  setQ(event.target.value);
                  setPage(1);
                }}
                placeholder="Search by set name, code, TCG, series or year"
                data-testid="input-set-search"
              />
            </label>
            <select
              className={inputCls}
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
              data-testid="select-set-sort"
            >
              {SORT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {FILTER_OPTIONS.map(([value, label]) => (
              <label
                key={value}
                className={`inline-flex cursor-pointer items-center gap-2 rounded border px-2.5 py-1.5 text-xs ${
                  filters.has(value)
                    ? "border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37]"
                    : "border-[#D4AF37]/20 text-[#E8E4DC]/70"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-[#D4AF37]"
                  checked={filters.has(value)}
                  onChange={() => toggleFilter(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </section>

        {(msg || err) && (
          <div
            className={`rounded border px-4 py-3 text-sm ${
              err
                ? "border-red-500/40 bg-red-950/25 text-red-200"
                : "border-emerald-500/40 bg-emerald-950/25 text-emerald-200"
            }`}
          >
            {err || msg}
          </div>
        )}

        <section className="overflow-hidden rounded border border-[#D4AF37]/20 bg-black/55">
          <div className="flex items-center justify-between border-b border-[#D4AF37]/15 px-4 py-3 text-sm text-[#E8E4DC]/70">
            <span>{loading ? "Loading sets..." : `${data?.total ?? 0} matching sets`}</span>
            <span>
              Page {data?.page ?? 1} of {data?.totalPages ?? 1}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#D4AF37]/10 text-xs uppercase tracking-wide text-[#D4AF37]">
                <tr>
                  <th className="px-3 py-2">Set name</th>
                  <th className="px-3 py-2">Set code</th>
                  <th className="px-3 py-2">TCG</th>
                  <th className="px-3 py-2">Series</th>
                  <th className="px-3 py-2">Year</th>
                  <th className="px-3 py-2">Published cards</th>
                  <th className="px-3 py-2">Linked cards</th>
                  <th className="px-3 py-2">Linked certs</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Last updated</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#D4AF37]/10">
                {rows.map((row) => {
                  const issues = activeIssues(row);
                  return (
                    <tr key={row.uid} className="align-top text-[#E8E4DC]">
                      <td className="max-w-[280px] px-3 py-3">
                        <div className="font-semibold">{row.setName}</div>
                        {row.subset && <div className="mt-1 text-xs text-[#D4AF37]">Subset: {row.subset}</div>}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs">{row.setId}</td>
                      <td className="px-3 py-3">{TCG_OPTIONS.find((o) => o.value === row.tcg)?.label || row.tcg}</td>
                      <td className="px-3 py-3">{row.series || "-"}</td>
                      <td className="px-3 py-3">{row.releaseYear ?? "-"}</td>
                      <td className="px-3 py-3">{row.publishedCardCount ?? "-"}</td>
                      <td className="px-3 py-3">{row.linkedCards}</td>
                      <td className="px-3 py-3">{row.linkedCertificates}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {row.archived && (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-700 px-2 py-0.5 text-xs">
                              <Archive className="h-3 w-3" /> Archived
                            </span>
                          )}
                          {issues.length === 0 ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                              <Check className="h-3 w-3" /> OK
                            </span>
                          ) : (
                            issues.slice(0, 3).map((issue) => (
                              <span
                                key={issue.key}
                                className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200"
                              >
                                <AlertTriangle className="h-3 w-3" /> {issue.label}
                              </span>
                            ))
                          )}
                        </div>
                        {issues.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {issues.slice(0, 2).map((issue) => (
                              <div key={issue.key} className="rounded border border-[#D4AF37]/10 p-2">
                                <div className="mb-1 text-[11px] text-[#E8E4DC]/55">
                                  Current: {JSON.stringify(issue.current)} Suggested: {JSON.stringify(issue.suggested)}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  <button
                                    type="button"
                                    className={compactBtn}
                                    onClick={() => approveSuggestion(row, issue)}
                                  >
                                    Review
                                  </button>
                                  {Object.keys(issue.suggested).length > 0 && (
                                    <button
                                      type="button"
                                      className={compactBtn}
                                      onClick={() => approveSuggestion(row, issue)}
                                    >
                                      Approve suggested correction
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className={compactBtn}
                                    onClick={() => setEditing({ row, draft: draftFrom(row) })}
                                  >
                                    Edit manually
                                  </button>
                                  <button
                                    type="button"
                                    className={compactBtn}
                                    onClick={() => decide(row, issue, "reject")}
                                  >
                                    Reject suggestion
                                  </button>
                                  <button
                                    type="button"
                                    className={compactBtn}
                                    onClick={() => decide(row, issue, "ignore")}
                                  >
                                    Ignore
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex rounded border px-2 py-0.5 text-xs ${sourceBadgeClass(row.source)}`}
                        >
                          {sourceLabel(row.source)}
                        </span>
                      </td>
                      <td className="px-3 py-3">{formatDate(row.updatedAt)}</td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          className={compactBtn}
                          onClick={() => setEditing({ row, draft: draftFrom(row) })}
                        >
                          <Edit3 className="h-3.5 w-3.5" /> Edit Set
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-3 py-10 text-center text-[#E8E4DC]/55">
                      No sets match the current search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[#D4AF37]/15 px-4 py-3">
            <button
              type="button"
              className={compactBtn}
              disabled={(data?.page ?? 1) <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className={compactBtn}
              disabled={(data?.page ?? 1) >= (data?.totalPages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </section>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded border border-[#D4AF37]/30 bg-[#090909] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[#E8E4DC]">Edit Set</h2>
                <p className="mt-1 text-sm text-[#E8E4DC]/55">
                  Updates the existing {sourceLabel(editing.row.source)} record only.
                </p>
              </div>
              <button type="button" className={compactBtn} onClick={() => setEditing(null)} aria-label="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Set name</span>
                <input
                  className={`${inputCls} w-full`}
                  value={editing.draft.setName}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, setName: e.target.value } })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Set code</span>
                <input
                  className={`${inputCls} w-full`}
                  value={editing.draft.setId}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, setId: e.target.value } })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Year</span>
                <input
                  className={`${inputCls} w-full`}
                  inputMode="numeric"
                  value={editing.draft.releaseYear}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, releaseYear: e.target.value } })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Series</span>
                <input
                  className={`${inputCls} w-full`}
                  value={editing.draft.series}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, series: e.target.value } })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">TCG / Brand</span>
                <select
                  className={`${inputCls} w-full`}
                  value={editing.draft.tcg}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, tcg: e.target.value as TcgBrand } })
                  }
                >
                  {TCG_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Published card count</span>
                <input
                  className={`${inputCls} w-full`}
                  inputMode="numeric"
                  value={editing.draft.totalCards}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, totalCards: e.target.value } })}
                />
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Subset / review classification</span>
                <input
                  className={`${inputCls} w-full`}
                  value={editing.draft.subset}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, subset: e.target.value } })}
                />
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-[#E8E4DC]">
                <input
                  type="checkbox"
                  className="accent-[#D4AF37]"
                  checked={editing.draft.archived}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, archived: e.target.checked } })}
                />
                Archived
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-xs font-semibold uppercase text-[#D4AF37]">Audit reason</span>
                <textarea
                  className={`${inputCls} min-h-[72px] w-full`}
                  value={editing.draft.reason}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, reason: e.target.value } })}
                  placeholder="Reason for this correction"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={compactBtn} onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="admin-btn admin-btn--gold" onClick={saveEdit}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
