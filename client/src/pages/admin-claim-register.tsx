import { adminFetch } from "@/lib/queryClient";
/**
 * Super Admin — Claim Code / Ownership Register.
 *
 * Read-only. Shows which certificates hold a valid claim credential, which have
 * had one printed, who owns them, and which need a human decision. It never
 * displays a claim code: the register exists to say WHICH cards need attention,
 * not to hand out credentials.
 *
 * The counters are filters, not decoration — clicking one narrows the table to
 * exactly the rows it counted, so a number and the list behind it can never
 * disagree.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, Loader2, Printer, RefreshCw, Search, ShieldAlert } from "lucide-react";
import AdminShell from "@/components/admin/admin-shell";

interface RegisterRow {
  certId: string;
  cardName: string | null;
  setName: string | null;
  grade: string | null;
  gradeType: string | null;
  credentialStatus: "present" | "hash_only" | "absent";
  printedAt: string | null;
  claimStatus: string;
  ownerEmailMasked: string | null;
  claimedAt: string | null;
  transferPending: boolean;
  stolen: boolean;
  voided: boolean;
  category: string;
  categoryLabel: string;
  action: string;
  reason: string;
  actionRequired: boolean;
  lastClaimEvent: string | null;
  firstPrintedAt: string | null;
  credentialIssuedAt: string | null;
  supersededPrintedCredential: boolean;
  printedNoCredential: boolean;
  customerRisk: boolean;
  controlledTestReset: boolean;
  ownershipConflict: boolean;
  printArtefactSurvives: boolean;
  certificateRepurposed: boolean;
  shippingRiskUnknown: boolean;
  priorGenerationPrintedAt: string | null;
}

interface RegisterMetrics {
  totalEligible: number;
  printed: number;
  neverPrinted: number;
  validCredential: number;
  claimed: number;
  outstanding: number;
  noCredential: number;
  brokenPrintedCredential: number;
  printedCredentialSuperseded: number;
  printedNoCredential: number;
  customerRisk: number;
  testReset: number;
  ownershipConflict: number;
  certificateRepurposed: number;
  shippingRiskUnknown: number;
  genuineSameIdentitySuperseded: number;
  transferPending: number;
  stolen: number;
  void: number;
  actionRequired: number;
  claimVerificationRate: number | null;
}

interface RegisterResponse {
  generatedAt: string;
  metrics: RegisterMetrics;
  rows: RegisterRow[];
}

type FilterKey =
  | "all"
  | "printed"
  | "neverPrinted"
  | "validCredential"
  | "claimed"
  | "outstanding"
  | "noCredential"
  | "brokenPrintedCredential"
  | "printedCredentialSuperseded"
  | "printedNoCredential"
  | "customerRisk"
  | "testReset"
  | "ownershipConflict"
  | "certificateRepurposed"
  | "shippingRiskUnknown"
  | "genuineSameIdentitySuperseded"
  | "transferPending"
  | "stolen"
  | "void"
  | "actionRequired";

const METRICS: Array<{ key: FilterKey; label: string; tone?: "warn" | "bad" }> = [
  { key: "all", label: "Total eligible" },
  { key: "printed", label: "Printed" },
  { key: "neverPrinted", label: "Never printed" },
  { key: "validCredential", label: "Valid credential" },
  { key: "claimed", label: "Claimed" },
  { key: "outstanding", label: "Outstanding" },
  { key: "noCredential", label: "No credential", tone: "warn" },
  { key: "brokenPrintedCredential", label: "Broken printed", tone: "bad" },
  { key: "printedCredentialSuperseded", label: "Printed credential superseded", tone: "bad" },
  { key: "genuineSameIdentitySuperseded", label: "Same-identity superseded", tone: "bad" },
  { key: "certificateRepurposed", label: "Number reused", tone: "warn" },
  { key: "shippingRiskUnknown", label: "Shipping unknown", tone: "warn" },
  { key: "printedNoCredential", label: "Printed / no credential", tone: "bad" },
  { key: "customerRisk", label: "Customer risk", tone: "bad" },
  { key: "testReset", label: "Test / reset" },
  { key: "ownershipConflict", label: "Ownership conflict", tone: "warn" },
  { key: "transferPending", label: "Transfer pending" },
  { key: "stolen", label: "Stolen", tone: "bad" },
  { key: "void", label: "Void" },
  { key: "actionRequired", label: "Action required", tone: "bad" },
];

/** Which rows a given counter is counting. Kept next to the counter so they cannot drift. */
function matchesFilter(row: RegisterRow, key: FilterKey): boolean {
  switch (key) {
    case "all":
      return true;
    case "printed":
      return row.printedAt !== null;
    case "neverPrinted":
      return row.printedAt === null;
    case "validCredential":
      return row.credentialStatus !== "absent";
    case "claimed":
      return row.category === "E_CLAIMED";
    case "outstanding":
      return row.category === "A_PRINTED_VALID";
    case "noCredential":
      return row.credentialStatus === "absent";
    case "brokenPrintedCredential":
      return row.category === "C_PRINTED_BROKEN" || row.category === "B_PRINTED_RECOVERABLE";
    case "printedCredentialSuperseded":
      return row.supersededPrintedCredential;
    case "printedNoCredential":
      return row.printedNoCredential;
    case "customerRisk":
      return row.customerRisk;
    case "testReset":
      return row.controlledTestReset;
    case "ownershipConflict":
      return row.ownershipConflict;
    case "certificateRepurposed":
      return row.certificateRepurposed;
    case "shippingRiskUnknown":
      return row.shippingRiskUnknown;
    case "genuineSameIdentitySuperseded":
      // The count that matters: a rotated credential on THIS card, not an earlier
      // occupant of the same number.
      return row.supersededPrintedCredential && !row.certificateRepurposed;
    case "transferPending":
      return row.transferPending;
    case "stolen":
      return row.stolen;
    case "void":
      return row.voided;
    case "actionRequired":
      return row.actionRequired;
  }
}

const CATEGORY_TONE: Record<string, string> = {
  A_PRINTED_VALID: "ok",
  R_READY_NOT_PRINTED: "ok",
  E_CLAIMED: "ok",
  D_NEVER_PRINTED_NO_CREDENTIAL: "warn",
  B_PRINTED_RECOVERABLE: "warn",
  F_TRANSFER_PENDING: "warn",
  G_VOID: "muted",
  C_PRINTED_BROKEN: "bad",
  S_PRINTED_SUPERSEDED: "bad",
  P_CERTIFICATE_REPURPOSED: "warn",
  H_STOLEN: "bad",
  I_CONFLICT: "bad",
};

const TONE_CLASS: Record<string, string> = {
  ok: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  warn: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  bad: "text-red-300 bg-red-500/10 border-red-500/30",
  muted: "text-white/50 bg-white/5 border-white/15",
};

export default function AdminClaimRegisterPage() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, error, refetch } = useQuery<RegisterResponse>({
    queryKey: ["/api/admin/claim-register"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/claim-register");
      if (!res.ok) throw new Error("Could not load the claim register.");
      return res.json();
    },
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (!q) return true;
      return (
        r.certId.toLowerCase().includes(q) ||
        (r.cardName ?? "").toLowerCase().includes(q) ||
        (r.setName ?? "").toLowerCase().includes(q) ||
        (r.ownerEmailMasked ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, filter, search]);

  return (
    <AdminShell
      activeTab="claim-register"
      onTabChange={() => navigate("/admin")}
      title="Claim Register"
      crumb="MINTVAULT · OPERATIONS"
      disableEnvironmentPolling
    >
      <div className="flex flex-col gap-5 p-4 md:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-white">
              <KeyRound className="h-4 w-4 text-[#D4AF37]" />
              Claim code &amp; ownership
            </h1>
            <p className="text-xs text-white/50">
              Claim codes are never shown here. {data ? `Read ${new Date(data.generatedAt).toLocaleString("en-GB")}.` : ""}
            </p>
            {data && (
              <p className="text-xs text-white/60">
                Claim verification rate:{" "}
                <span className="font-bold tabular-nums text-white/80">
                  {/* Unknown is "—". Nothing issued means the rate does not exist — it is not 0%. */}
                  {data.metrics.claimVerificationRate === null
                    ? "—"
                    : `${(data.metrics.claimVerificationRate * 100).toFixed(1)}%`}
                </span>
                <span className="text-white/35">
                  {" "}
                  ({data.metrics.claimed} claimed of {data.metrics.printed} issued)
                </span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 text-xs font-bold text-white/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4AF37]"
            data-testid="button-refresh-register"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </header>

        {isLoading && (
          <div className="flex items-center gap-2 p-8 text-sm text-white/60">
            <Loader2 className="h-4 w-4 animate-spin" /> Building the register…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4" /> {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {METRICS.map((m) => {
                const value = m.key === "all" ? data.metrics.totalEligible : (data.metrics as never as Record<string, number>)[m.key];
                const active = filter === m.key;
                const tone = m.tone === "bad" && value > 0 ? "text-red-300" : m.tone === "warn" && value > 0 ? "text-amber-300" : "text-white";
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setFilter(m.key)}
                    aria-pressed={active}
                    data-testid={`metric-${m.key}`}
                    className={`flex flex-col items-start gap-0.5 rounded border p-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4AF37] ${
                      active ? "border-[#D4AF37] bg-[#D4AF37]/10" : "border-white/12 bg-white/[0.03] hover:border-white/25"
                    }`}
                  >
                    <span className={`text-xl font-extrabold tabular-nums ${tone}`}>{value ?? 0}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/45">{m.label}</span>
                  </button>
                );
              })}
            </div>

            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-white/35" />
              <span className="sr-only">Search the register</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search certificate, card, set or owner"
                data-testid="input-register-search"
                className="w-full rounded border border-white/12 bg-white/[0.03] py-2 pl-8 pr-3 text-sm text-white placeholder:text-white/30 focus:border-[#D4AF37] focus:outline-none"
              />
            </label>

            <div className="overflow-x-auto rounded border border-white/12">
              <table className="w-full min-w-[64rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/12 text-[10px] uppercase tracking-wider text-white/45">
                    <th className="p-2 text-left font-bold">Cert</th>
                    <th className="p-2 text-left font-bold">Card</th>
                    <th className="p-2 text-left font-bold">Grade</th>
                    <th className="p-2 text-left font-bold">Credential</th>
                    <th className="p-2 text-left font-bold">Printed</th>
                    <th className="p-2 text-left font-bold">Owner</th>
                    <th className="p-2 text-left font-bold">State</th>
                    <th className="p-2 text-left font-bold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.certId} className="border-b border-white/[0.06] last:border-0" data-testid={`row-${r.certId}`}>
                      <td className="p-2 font-mono text-xs font-bold text-white tabular-nums">
                        {r.certId}
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {r.customerRisk && (
                            <span
                              className="rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[9px] font-bold uppercase text-red-300"
                              data-testid={`badge-customer-risk-${r.certId}`}
                            >
                              Customer risk
                            </span>
                          )}
                          {r.controlledTestReset && (
                            <span
                              className="rounded border border-white/20 bg-white/5 px-1 py-px text-[9px] font-bold uppercase text-white/50"
                              data-testid={`badge-test-reset-${r.certId}`}
                            >
                              Test / reset
                            </span>
                          )}
                          {r.ownershipConflict && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-bold uppercase text-amber-300">
                              Ownership conflict
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="p-2 text-white/80">
                        {r.cardName ?? <span className="text-white/30">—</span>}
                        {r.setName && <span className="block text-[11px] text-white/40">{r.setName}</span>}
                      </td>
                      <td className="p-2 tabular-nums text-white/70">{r.grade ?? "—"}</td>
                      <td className="p-2">
                        <span className="text-xs text-white/70">
                          {r.credentialStatus === "present"
                            ? "stored"
                            : r.credentialStatus === "hash_only"
                              ? "hash only"
                              : "none"}
                        </span>
                        {r.supersededPrintedCredential && (
                          <span className="block text-[10px] font-bold text-red-300">not the printed code</span>
                        )}
                      </td>
                      <td className="p-2 text-xs tabular-nums text-white/60">
                        {r.printedAt ? new Date(r.printedAt).toLocaleDateString("en-GB") : <span className="text-white/25">never</span>}
                        {r.firstPrintedAt && r.firstPrintedAt !== r.printedAt && (
                          <span className="block text-[10px] text-white/35">
                            first {new Date(r.firstPrintedAt).toLocaleDateString("en-GB")}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-xs text-white/60">
                        {r.ownerEmailMasked ?? <span className="text-white/25">—</span>}
                        {r.claimedAt && (
                          <span className="block text-[11px] text-white/35">
                            {new Date(r.claimedAt).toLocaleDateString("en-GB")}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <span
                          className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            TONE_CLASS[CATEGORY_TONE[r.category] ?? "muted"]
                          }`}
                          title={r.reason}
                        >
                          {r.categoryLabel}
                        </span>
                        {r.stolen && <ShieldAlert className="ml-1 inline h-3.5 w-3.5 text-red-300" aria-label="stolen" />}
                        {r.certificateRepurposed && (
                          <span
                            className="ml-1 inline-block rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300"
                            title={
                              r.priorGenerationPrintedAt
                                ? `This number was printed for a different card on ${new Date(r.priorGenerationPrintedAt).toLocaleDateString("en-GB")}`
                                : "This certificate number carried a different card earlier"
                            }
                          >
                            reused
                          </span>
                        )}
                        {r.printedAt && <Printer className="ml-1 inline h-3 w-3 text-white/25" aria-label="printed" />}
                      </td>
                      <td className="p-2 text-xs text-white/55">
                        {r.action === "NONE" ? <span className="text-white/25">—</span> : r.action.replace(/_/g, " ").toLowerCase()}
                        <span className="block text-[11px] text-white/35">{r.reason}</span>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-6 text-center text-sm text-white/40">
                        Nothing matches this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-white/35">
              Showing {rows.length} of {data.rows.length} certificates.
            </p>
          </>
        )}
      </div>
    </AdminShell>
  );
}
