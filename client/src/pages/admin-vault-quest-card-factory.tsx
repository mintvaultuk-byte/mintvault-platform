import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileDown,
  Image,
  Loader2,
  PackageCheck,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  VQ_CARD_FACTORY_GEOMETRY,
  VQ_CARD_FACTORY_PLACEMENT_DEFAULT,
  VQ_CARD_FACTORY_TEMPLATE_VERSION,
  VQ_STANDARD_CARD_SPECS,
  normalizeVqFactoryPlacement,
  type VqCardFactoryPlacement,
  type VqCardFactorySpec,
} from "@shared/vq-card-factory";
import { useToast } from "@/hooks/use-toast";

type FactoryIssue = { code: string; field: string; message: string; severity: "blocker" | "warning" };
type FactoryCard = {
  cardId: string;
  updatedAt?: string | null;
  name?: string | null;
  element?: string | null;
  stageNumber?: number | null;
  health?: number | null;
  guard?: number | null;
  shift?: number | null;
  attack1Name?: string | null;
  attack1Cost?: number | null;
  attack1Damage?: number | null;
  vulnerability?: string | null;
  rarity?: string | null;
  edition?: string | null;
  year?: number | null;
  prevArtR2Key?: string | null;
};
type FactoryRow = {
  spec: VqCardFactorySpec;
  card: FactoryCard | null;
  validation: FactoryIssue[];
  completionStatus: "missing" | "blocked" | "ready_for_review" | "approved_for_print";
  blockingReason: string;
  artworkStatus: "missing" | "draft" | "approved";
  dataStatus: "missing" | "draft" | "approved";
  validationStatus: "blocked" | "ready_for_review" | "approved_for_print";
  exportStatus: "blocked" | "ready";
  checklist: {
    artwork: "missing" | "draft" | "approved";
    data: "missing" | "draft" | "approved";
    preview: "blocked" | "ready";
    validation: "blocked" | "ready_for_review" | "approved_for_print";
    approval: "missing" | "current" | "stale";
    export: "blocked" | "ready";
  };
  exportReady: boolean;
  lastUpdated: string | null;
  placement: VqCardFactoryPlacement;
  approvalState: "missing" | "current" | "stale";
  approvalStaleReason: string | null;
};
type Dashboard = {
  rows: FactoryRow[];
  totals: {
    total: number;
    fullyReady: number;
    missingData: number;
    missingArtwork: number;
    invalidRelationships: number;
    readyForReview: number;
    readyForExport: number;
  };
  progress: {
    total: number;
    cardsCompleted: number;
    cardsAwaitingArtwork: number;
    cardsAwaitingData: number;
    cardsAwaitingApproval: number;
    cardsExportReady: number;
    percentageComplete: number;
  };
  workQueue: string[];
};

const STEPS = ["Select Card", "Card Data", "Artwork", "Preview & QA", "Approve", "Export"];
const QUEUE_SORTS = [
  ["collector", "Lowest collector number"],
  ["family", "Family"],
  ["stage", "Stage"],
  ["artwork_missing", "Artwork missing"],
  ["data_missing", "Data missing"],
  ["ready_for_review", "Ready for review"],
] as const;
type QueueSort = (typeof QUEUE_SORTS)[number][0];

function statusTone(status: FactoryRow["completionStatus"]) {
  if (status === "approved_for_print") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
  if (status === "ready_for_review") return "border-sky-500/40 bg-sky-500/10 text-sky-100";
  if (status === "blocked") return "border-amber-500/40 bg-amber-500/10 text-amber-100";
  return "border-zinc-600 bg-zinc-900/60 text-zinc-300";
}

function indicatorTone(value: string) {
  if (["approved", "approved_for_print", "ready", "current"].includes(value))
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
  if (["draft", "ready_for_review"].includes(value)) return "border-amber-500/40 bg-amber-500/10 text-amber-100";
  return "border-red-500/40 bg-red-500/10 text-red-100";
}

function shortDate(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

async function fetchImageBlob(collectorNumber: string, endpoint: string): Promise<Blob> {
  const res = await fetch(`/api/admin/vault-quest/card-factory/cards/${collectorNumber}/${endpoint}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "Card Factory render failed");
  }
  return res.blob();
}

async function downloadFactoryFile(collectorNumber: string, endpoint: string, fallbackName: string) {
  const res = await fetch(`/api/admin/vault-quest/card-factory/cards/${collectorNumber}/${endpoint}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "Export failed");
  }
  const disposition = res.headers.get("content-disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = match?.[1] || fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadFactoryUrl(urlPath: string, fallbackName: string) {
  const res = await fetch(urlPath, { method: "POST", credentials: "include" });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "Export failed");
  }
  const disposition = res.headers.get("content-disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = match?.[1] || fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function PreviewImage({ row }: { row: FactoryRow }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setError("");
    if (!row.card || row.validation.some((issue) => issue.severity === "blocker")) return;
    fetchImageBlob(row.spec.collectorNumber, "front-preview.png")
      .then((blob) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Preview failed");
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [row.spec.collectorNumber, row.card?.updatedAt, row.validation.length]);

  if (row.validation.some((issue) => issue.severity === "blocker")) {
    return (
      <div className="flex aspect-[69/94] items-center justify-center rounded border border-dashed border-amber-500/40 bg-zinc-950 p-6 text-center text-sm text-amber-100">
        Preview blocked until validation passes.
      </div>
    );
  }
  if (error)
    return (
      <div className="flex aspect-[69/94] items-center justify-center rounded border border-red-500/40 bg-red-950/20 p-6 text-center text-sm text-red-100">
        {error}
      </div>
    );
  if (!src)
    return (
      <div className="flex aspect-[69/94] items-center justify-center rounded border border-zinc-700 bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-amber-300" />
      </div>
    );
  return (
    <img
      src={src}
      alt={`${row.spec.character} exact card preview`}
      className="aspect-[69/94] w-full rounded border border-zinc-700 object-contain bg-zinc-950"
    />
  );
}

export default function AdminVaultQuestCardFactoryPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [queueSort, setQueueSort] = useState<QueueSort>("collector");
  const [selectedNumber, setSelectedNumber] = useState("001");
  const [busy, setBusy] = useState("");
  const [zoom, setZoom] = useState(100);
  const [showBleed, setShowBleed] = useState(true);
  const [showTrim, setShowTrim] = useState(true);
  const [showSafe, setShowSafe] = useState(false);
  const [placementDraft, setPlacementDraft] = useState<VqCardFactoryPlacement>(VQ_CARD_FACTORY_PLACEMENT_DEFAULT);

  const dashboardQ = useQuery<Dashboard>({
    queryKey: ["/api/admin/vault-quest/card-factory/dashboard"],
    queryFn: async () => {
      const res = await fetch("/api/admin/vault-quest/card-factory/dashboard", { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load Card Factory");
      return res.json();
    },
  });

  const rows = dashboardQ.data?.rows ?? [];
  const selected = rows.find((row) => row.spec.collectorNumber === selectedNumber) ?? rows[0] ?? null;
  useEffect(() => {
    setPlacementDraft(normalizeVqFactoryPlacement(selected?.placement));
  }, [selected?.spec.collectorNumber, selected?.placement]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "missing-artwork" && row.artworkStatus !== "missing") return false;
      if (
        filter === "missing-data" &&
        row.dataStatus !== "missing" &&
        !row.validation.some((issue) => issue.code.startsWith("missing_"))
      )
        return false;
      if (filter === "ready" && row.completionStatus !== "ready_for_review") return false;
      if (filter === "approved" && row.completionStatus !== "approved_for_print") return false;
      if (filter === "ready-export" && !row.exportReady) return false;
      if (filter === "blocked" && row.completionStatus !== "blocked") return false;
      if (!q) return true;
      return [row.spec.collectorNumber, row.spec.character, row.spec.familyName, row.spec.element]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, filter, query]);
  const workQueue = useMemo(() => {
    const queued = rows.filter((row) => !row.exportReady);
    return [...queued].sort((a, b) => {
      const priority = (row: FactoryRow) => {
        if (queueSort === "artwork_missing") return row.artworkStatus === "missing" ? 0 : 1;
        if (queueSort === "data_missing") return row.dataStatus !== "approved" ? 0 : 1;
        if (queueSort === "ready_for_review") return row.completionStatus === "ready_for_review" ? 0 : 1;
        return 0;
      };
      const p = priority(a) - priority(b);
      if (p !== 0) return p;
      if (queueSort === "family") {
        const family = a.spec.familyName.localeCompare(b.spec.familyName);
        if (family !== 0) return family;
      }
      if (queueSort === "stage") {
        const stage = a.spec.stage - b.spec.stage;
        if (stage !== 0) return stage;
      }
      return a.spec.collectorNumber.localeCompare(b.spec.collectorNumber);
    });
  }, [rows, queueSort]);
  const progress = dashboardQ.data?.progress;
  const nextBlocked = rows.find((row) => !row.exportReady);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
      toast({ title: label });
      await dashboardQ.refetch();
    } catch (err) {
      toast({
        title: `${label} failed`,
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy("");
    }
  };

  const selectedIndex = VQ_STANDARD_CARD_SPECS.findIndex((spec) => spec.collectorNumber === selectedNumber);
  const savePlacement = async () => {
    if (!selected) return;
    await runAction("Saved placement", async () => {
      const res = await fetch(`/api/admin/vault-quest/card-factory/cards/${selected.spec.collectorNumber}/placement`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(placementDraft),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Placement save failed");
    });
  };

  const go = (delta: number) => {
    const next =
      VQ_STANDARD_CARD_SPECS[Math.max(0, Math.min(VQ_STANDARD_CARD_SPECS.length - 1, selectedIndex + delta))];
    if (next) setSelectedNumber(next.collectorNumber);
  };

  return (
    <div className="min-h-screen bg-[#081A3D] text-zinc-100">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-amber-300">Vault Quest</p>
            <h1 className="text-3xl font-black">Card Factory</h1>
            <p className="mt-1 max-w-3xl text-sm text-zinc-300">
              Approved character to print export, using the locked card renderer. Opening, validating and exporting here
              never starts AI generation.
            </p>
          </div>
          <div className="rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100">
            {VQ_CARD_FACTORY_TEMPLATE_VERSION}
          </div>
        </header>

        <div className="mb-5 grid gap-2 md:grid-cols-6">
          {STEPS.map((step, index) => (
            <div key={step} className="rounded border border-white/10 bg-white/5 p-3">
              <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Step {index + 1}</span>
              <p className="mt-1 text-sm font-bold">{step}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <section className="rounded border border-white/10 bg-white/5 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-300">Founder Work Queue</p>
                  <p className="text-sm text-zinc-300">{workQueue.length} cards still need work</p>
                </div>
                <button
                  type="button"
                  onClick={() => nextBlocked && setSelectedNumber(nextBlocked.spec.collectorNumber)}
                  disabled={!nextBlocked}
                  className="inline-flex items-center gap-1 rounded bg-amber-300 px-3 py-2 text-xs font-black text-[#081A3D] disabled:opacity-40"
                >
                  Next Card <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <label className="text-xs text-zinc-300">
                Queue sort
                <select
                  value={queueSort}
                  onChange={(event) => setQueueSort(event.target.value as QueueSort)}
                  className="mt-1 h-9 w-full rounded border border-white/10 bg-[#06142F] px-3 text-sm"
                >
                  {QUEUE_SORTS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                {workQueue.map((row) => (
                  <button
                    key={`queue-${row.spec.collectorNumber}`}
                    type="button"
                    onClick={() => setSelectedNumber(row.spec.collectorNumber)}
                    className="flex w-full items-center justify-between gap-2 rounded border border-white/10 bg-[#06142F] px-3 py-2 text-left text-xs hover:border-amber-300/60"
                  >
                    <span className="font-bold">
                      {row.spec.collectorNumber} {row.spec.character}
                    </span>
                    <span className="truncate text-zinc-400">{row.blockingReason || "Needs approval"}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded border border-white/10 bg-white/5 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Search className="h-4 w-4 text-amber-300" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 flex-1 rounded border border-white/10 bg-[#06142F] px-3 text-sm outline-none focus:border-amber-300"
                  placeholder="Search 001, Flammi, Flame"
                />
              </div>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="mb-3 h-9 w-full rounded border border-white/10 bg-[#06142F] px-3 text-sm"
              >
                <option value="all">All 001-036</option>
                <option value="missing-artwork">Missing Artwork</option>
                <option value="missing-data">Missing Data</option>
                <option value="ready">Ready for Review</option>
                <option value="approved">Approved</option>
                <option value="blocked">Blocked</option>
                <option value="ready-export">Ready to Export</option>
              </select>
              <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
                {dashboardQ.isLoading && <p className="text-sm text-zinc-300">Loading Card Factory...</p>}
                {filtered.map((row) => (
                  <button
                    key={row.spec.collectorNumber}
                    type="button"
                    onClick={() => setSelectedNumber(row.spec.collectorNumber)}
                    className={`w-full rounded border p-3 text-left transition ${selectedNumber === row.spec.collectorNumber ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-[#06142F] hover:border-amber-300/60"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-bold">
                        {row.spec.collectorNumber} {row.spec.character}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] uppercase ${statusTone(row.completionStatus)}`}
                      >
                        {row.completionStatus.replaceAll("_", " ")}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-zinc-400">
                      Stage {row.spec.stage} · {row.spec.familyName} · {row.spec.element}
                    </span>
                    {row.blockingReason && (
                      <span className="mt-1 block truncate text-xs text-amber-200">{row.blockingReason}</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          </aside>

          {selected && (
            <main className="space-y-4">
              {progress && (
                <section className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                  {[
                    ["Cards completed", progress.cardsCompleted],
                    ["Awaiting artwork", progress.cardsAwaitingArtwork],
                    ["Awaiting data", progress.cardsAwaitingData],
                    ["Awaiting approval", progress.cardsAwaitingApproval],
                    ["Export ready", progress.cardsExportReady],
                    ["Complete", `${progress.percentageComplete}%`],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded border border-white/10 bg-white/5 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">{label}</p>
                      <p className="mt-1 text-xl font-black text-amber-100">{value}</p>
                    </div>
                  ))}
                </section>
              )}

              <section className="rounded border border-white/10 bg-white/5 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-bold text-amber-300">Standard Dashboard</p>
                  <p className="text-xs text-zinc-400">001 Flammi through 036 Shardor</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wide text-zinc-400">
                      <tr>
                        <th className="py-2 pr-3">No.</th>
                        <th className="py-2 pr-3">Family</th>
                        <th className="py-2 pr-3">Stage</th>
                        <th className="py-2 pr-3">Artwork</th>
                        <th className="py-2 pr-3">Data</th>
                        <th className="py-2 pr-3">Validation</th>
                        <th className="py-2 pr-3">Approval</th>
                        <th className="py-2 pr-3">Export</th>
                        <th className="py-2 pr-3">Blocking reason</th>
                        <th className="py-2">Last updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={`table-${row.spec.collectorNumber}`}
                          className="border-t border-white/10 hover:bg-white/5"
                        >
                          <td className="py-2 pr-3">
                            <button
                              type="button"
                              onClick={() => setSelectedNumber(row.spec.collectorNumber)}
                              className="font-bold text-amber-100 hover:underline"
                            >
                              {row.spec.collectorNumber} {row.spec.character}
                            </button>
                          </td>
                          <td className="py-2 pr-3">{row.spec.familyName}</td>
                          <td className="py-2 pr-3">{row.spec.stage}</td>
                          {[
                            row.artworkStatus,
                            row.dataStatus,
                            row.validationStatus,
                            row.approvalState,
                            row.exportStatus,
                          ].map((value, index) => (
                            <td key={`${row.spec.collectorNumber}-${index}-${value}`} className="py-2 pr-3">
                              <span className={`rounded border px-2 py-0.5 uppercase ${indicatorTone(value)}`}>
                                {value.replaceAll("_", " ")}
                              </span>
                            </td>
                          ))}
                          <td className="max-w-[260px] truncate py-2 pr-3 text-zinc-300">
                            {row.blockingReason || "None"}
                          </td>
                          <td className="py-2 text-zinc-400">{shortDate(row.lastUpdated)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded border border-white/10 bg-white/5 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-sm text-amber-300">Step 1 - Select Card</p>
                    <h2 className="text-2xl font-black">
                      {selected.spec.collectorNumber} · {selected.spec.character}
                    </h2>
                    <p className="text-sm text-zinc-300">
                      Stage {selected.spec.stage} · {selected.spec.familyName} · {selected.spec.element}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => go(-1)}
                      className="rounded border border-white/10 px-3 py-2 text-sm"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => go(1)}
                      className="rounded border border-white/10 px-3 py-2 text-sm"
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
                  {Object.entries(selected.checklist).map(([label, value]) => (
                    <div key={label} className={`rounded border p-2 ${indicatorTone(value)}`}>
                      <p className="text-[10px] font-bold uppercase tracking-wide">{label}</p>
                      <p className="mt-1 text-xs font-black uppercase">{value.replaceAll("_", " ")}</p>
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <section className="space-y-4">
                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <p className="mb-3 text-sm font-bold text-amber-300">Step 2 - Card Data</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      {[
                        ["Card name", selected.card?.name ?? "Missing"],
                        ["Stage", selected.card?.stageNumber ?? selected.spec.stage],
                        ["Element", selected.card?.element ?? "Missing"],
                        ["Health", selected.card?.health ?? "Missing"],
                        ["Guard", selected.card?.guard ?? "Missing"],
                        ["Shift", selected.card?.shift ?? "Missing"],
                        ["Evolves From", selected.spec.expectedPreviousName ?? "None"],
                        ["Attack 1", selected.card?.attack1Name ?? "Missing"],
                        [
                          "Core / Damage",
                          `${selected.card?.attack1Cost ?? "Missing"} / ${selected.card?.attack1Damage ?? "Missing"}`,
                        ],
                        ["Vulnerability", selected.card?.vulnerability ?? "Missing"],
                        ["Rarity", selected.card?.rarity ?? "Missing"],
                        [
                          "Edition / Year",
                          `${selected.card?.edition ?? "Missing"} / ${selected.card?.year ?? "Missing"}`,
                        ],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded border border-white/10 bg-[#06142F] p-3">
                          <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">{label}</p>
                          <p className="mt-1 text-sm font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <p className="mb-3 text-sm font-bold text-amber-300">Step 3 - Artwork</p>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded border border-white/10 bg-[#06142F] p-3">
                        <p className="text-xs text-zinc-400">Approved card artwork</p>
                        <p className="mt-1 font-bold">{selected.artworkStatus}</p>
                      </div>
                      <div className="rounded border border-white/10 bg-[#06142F] p-3">
                        <p className="text-xs text-zinc-400">Previous-stage portrait</p>
                        <p className="mt-1 font-bold">
                          {selected.spec.stage === 1
                            ? "Not required"
                            : selected.card?.prevArtR2Key
                              ? "Present"
                              : "Missing"}
                        </p>
                      </div>
                      <div className="rounded border border-white/10 bg-[#06142F] p-3">
                        <p className="text-xs text-zinc-400">Placement</p>
                        <p className="mt-1 font-bold">
                          {selected.approvalState === "stale" ? "Changed after approval" : "Stored metadata"}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="text-xs text-zinc-300">
                        Artwork scale
                        <input
                          type="range"
                          min="50"
                          max="200"
                          value={Math.round(placementDraft.scale * 100)}
                          onChange={(event) =>
                            setPlacementDraft((prev) => ({ ...prev, scale: Number(event.target.value) / 100 }))
                          }
                          className="mt-2 w-full"
                        />
                      </label>
                      <label className="text-xs text-zinc-300">
                        Horizontal offset
                        <input
                          type="range"
                          min="-100"
                          max="100"
                          value={placementDraft.xOffsetPct}
                          onChange={(event) =>
                            setPlacementDraft((prev) => ({ ...prev, xOffsetPct: Number(event.target.value) }))
                          }
                          className="mt-2 w-full"
                        />
                      </label>
                      <label className="text-xs text-zinc-300">
                        Vertical offset
                        <input
                          type="range"
                          min="-100"
                          max="100"
                          value={placementDraft.yOffsetPct}
                          onChange={(event) =>
                            setPlacementDraft((prev) => ({ ...prev, yOffsetPct: Number(event.target.value) }))
                          }
                          className="mt-2 w-full"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setPlacementDraft(VQ_CARD_FACTORY_PLACEMENT_DEFAULT)}
                        className="rounded border border-white/10 px-3 py-2 text-xs"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlacementDraft((prev) => ({ ...prev, locked: !prev.locked }))}
                        className="rounded border border-white/10 px-3 py-2 text-xs"
                      >
                        {placementDraft.locked ? "Unlock" : "Lock"}
                      </button>
                      <button
                        type="button"
                        onClick={savePlacement}
                        disabled={!!busy || !selected.card}
                        className="rounded bg-amber-300 px-3 py-2 text-xs font-black text-[#081A3D] disabled:opacity-40"
                      >
                        Save Placement
                      </button>
                    </div>
                  </div>

                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <p className="mb-3 text-sm font-bold text-amber-300">Step 4 - Preview & QA</p>
                    <div className="mb-3 flex flex-wrap gap-2">
                      <label className="inline-flex items-center gap-2 rounded border border-white/10 px-3 py-1 text-xs">
                        <input type="checkbox" checked={showBleed} onChange={(e) => setShowBleed(e.target.checked)} />{" "}
                        Bleed
                      </label>
                      <label className="inline-flex items-center gap-2 rounded border border-white/10 px-3 py-1 text-xs">
                        <input type="checkbox" checked={showTrim} onChange={(e) => setShowTrim(e.target.checked)} />{" "}
                        Trim
                      </label>
                      <label className="inline-flex items-center gap-2 rounded border border-white/10 px-3 py-1 text-xs">
                        <input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} />{" "}
                        Safe zone
                      </label>
                      <button
                        type="button"
                        onClick={() => setZoom(100)}
                        className="rounded border border-white/10 px-3 py-1 text-xs"
                      >
                        Fit / 100%
                      </button>
                      <button
                        type="button"
                        onClick={() => setZoom(200)}
                        className="rounded border border-white/10 px-3 py-1 text-xs"
                      >
                        200%
                      </button>
                      <button
                        type="button"
                        onClick={() => setZoom(100)}
                        className="rounded border border-white/10 px-3 py-1 text-xs"
                      >
                        True size
                      </button>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      {selected.validation.length === 0 ? (
                        <p className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                          <CheckCircle2 className="mr-2 inline h-4 w-4" /> Validation passed.
                        </p>
                      ) : (
                        selected.validation.map((issue) => (
                          <p
                            key={`${issue.code}-${issue.field}`}
                            className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
                          >
                            <AlertTriangle className="mr-2 inline h-4 w-4" /> {issue.message}
                          </p>
                        ))
                      )}
                    </div>
                  </div>
                </section>

                <aside className="space-y-4">
                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-bold text-amber-300">Exact Preview</p>
                      <span className="text-xs text-zinc-400">{zoom}%</span>
                    </div>
                    <div
                      className="relative mx-auto max-w-[360px]"
                      style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
                    >
                      <PreviewImage row={selected} />
                      {showBleed && <div className="pointer-events-none absolute inset-0 border-2 border-red-400/70" />}
                      {showTrim && (
                        <div className="pointer-events-none absolute inset-[4.35%] border-2 border-sky-300/70" />
                      )}
                      {showSafe && (
                        <div className="pointer-events-none absolute left-[8.7%] top-[6.38%] h-[87.23%] w-[82.6%] border border-emerald-300/70" />
                      )}
                    </div>
                    <p className="mt-3 text-xs text-zinc-400">
                      Canvas {VQ_CARD_FACTORY_GEOMETRY.canvasMm.width} x {VQ_CARD_FACTORY_GEOMETRY.canvasMm.height} mm ·
                      Trim {VQ_CARD_FACTORY_GEOMETRY.trimMm.width} x {VQ_CARD_FACTORY_GEOMETRY.trimMm.height} mm · 3 mm
                      bleed.
                    </p>
                  </div>

                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <p className="mb-3 text-sm font-bold text-amber-300">Step 5 - Approve</p>
                    <p className="mb-3 rounded border border-white/10 bg-[#06142F] p-3 text-xs text-zinc-300">
                      Approval: <b>{selected.approvalState}</b>
                      {selected.approvalStaleReason ? ` - ${selected.approvalStaleReason}` : ""}
                    </p>
                    <button
                      type="button"
                      disabled={
                        !!busy || !selected.card || selected.validation.some((issue) => issue.severity === "blocker")
                      }
                      onClick={() =>
                        runAction("Approved for print", async () => {
                          const res = await fetch(
                            `/api/admin/vault-quest/card-factory/cards/${selected.spec.collectorNumber}/approve`,
                            { method: "POST", credentials: "include" }
                          );
                          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Approval failed");
                        })
                      }
                      className="inline-flex w-full items-center justify-center gap-2 rounded bg-amber-300 px-4 py-3 text-sm font-black text-[#081A3D] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === "Approved for print" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}{" "}
                      Approve for Print
                    </button>
                  </div>

                  <div className="rounded border border-white/10 bg-white/5 p-4">
                    <p className="mb-3 text-sm font-bold text-amber-300">Step 6 - Export</p>
                    <div className="grid gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          runAction("Front PNG", () =>
                            downloadFactoryFile(selected.spec.collectorNumber, "front.png", "front.png")
                          )
                        }
                        disabled={!!busy || !selected.exportReady}
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm disabled:opacity-40"
                      >
                        <Image className="h-4 w-4" /> Front PNG
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runAction("Back PNG", () =>
                            downloadFactoryFile(selected.spec.collectorNumber, "back.png", "back.png")
                          )
                        }
                        disabled={!!busy || !selected.exportReady}
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm disabled:opacity-40"
                      >
                        <Image className="h-4 w-4" /> Back PNG
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runAction("Front PDF", () =>
                            downloadFactoryFile(selected.spec.collectorNumber, "front.pdf", "front.pdf")
                          )
                        }
                        disabled={!!busy || !selected.exportReady}
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm disabled:opacity-40"
                      >
                        <FileDown className="h-4 w-4" /> Print PDF
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runAction("Physical proof PDF", async () =>
                            downloadFactoryUrl(
                              "/api/admin/vault-quest/card-factory/physical-proof.pdf",
                              "GV_physical_test_print_pack.pdf"
                            )
                          )
                        }
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm"
                      >
                        <PackageCheck className="h-4 w-4" /> Test-Print Pack
                      </button>
                      <a
                        href="/api/admin/vault-quest/card-factory/manifest.json"
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm"
                      >
                        <Download className="h-4 w-4" /> Manifest JSON
                      </a>
                      <a
                        href="/api/admin/vault-quest/card-factory/manifest.csv"
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm"
                      >
                        <Download className="h-4 w-4" /> Manifest CSV
                      </a>
                      <a
                        href="/api/admin/vault-quest/card-factory/missing-blocked-report.txt"
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm"
                      >
                        <Download className="h-4 w-4" /> Missing Report
                      </a>
                      <button
                        type="button"
                        onClick={() =>
                          runAction("Validated all 36", async () => {
                            const res = await fetch("/api/admin/vault-quest/card-factory/validate-all", {
                              method: "POST",
                              credentials: "include",
                            });
                            if (!res.ok)
                              throw new Error((await res.json().catch(() => ({}))).error || "Validate All failed");
                          })
                        }
                        className="inline-flex items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 text-sm"
                      >
                        <ShieldCheck className="h-4 w-4" /> Validate All
                      </button>
                    </div>
                    <p className="mt-3 text-xs text-zinc-400">
                      Manufacturing export remains blocked until all 36 cards are approved and manufacturer specs are
                      stored.
                    </p>
                  </div>
                </aside>
              </div>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
