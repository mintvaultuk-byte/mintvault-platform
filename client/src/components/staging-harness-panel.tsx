import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { FlaskConical, Loader2, AlertTriangle, X } from "lucide-react";

interface SeedCounts { customers: number; certs: number; transfers: number; vaultClubRows: number; }
interface ResetCounts {
  transfers: number; claimVerifications: number; labelPrints: number; labelOverrides: number;
  reprintLog: number; ownershipHistory: number; stolenReports: number; certificates: number;
  customerMagicLinkTokens: number; passwordResetTokens: number; emailVerificationTokens: number;
  accountMagicLinkTokens: number; users: number; total: number;
}

type ResultState =
  | { kind: "idle" }
  | { kind: "seeded"; inserted: SeedCounts }
  | { kind: "already-seeded" }
  | { kind: "reset"; deleted: ResetCounts }
  | { kind: "error"; message: string };

export default function StagingHarnessPanel() {
  const [confirming, setConfirming] = useState<"seed" | "reset" | null>(null);
  const [result, setResult] = useState<ResultState>({ kind: "idle" });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/staging/seed", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      setConfirming(null);
      if (data.alreadySeeded) {
        setResult({ kind: "already-seeded" });
      } else {
        setResult({ kind: "seeded", inserted: data.inserted });
      }
    },
    onError: async (err: any) => {
      let msg = "Seed failed. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setConfirming(null);
      setResult({ kind: "error", message: msg });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/staging/reset", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      setConfirming(null);
      setResult({ kind: "reset", deleted: data.deleted });
    },
    onError: async (err: any) => {
      let msg = "Reset failed. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setConfirming(null);
      setResult({ kind: "error", message: msg });
    },
  });

  const anyPending = seedMutation.isPending || resetMutation.isPending;

  return (
    <div className="max-w-5xl mx-auto px-4 pt-4">
      <div className="border border-amber-400 bg-amber-50 rounded-lg p-4">
        <div className="flex items-start gap-3 mb-3">
          <FlaskConical size={18} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-900">🧪 Staging test harness</p>
            <p className="text-xs text-amber-800 mt-0.5">
              Affects test data only — certs MV900xxx + emails @staging-test.mintvault.dev.
              Real data protected by triple-guard + 50-row safety limit.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => { setConfirming("seed"); setResult({ kind: "idle" }); }}
            disabled={anyPending}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 bg-amber-200 hover:bg-amber-300 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
          >
            {seedMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
            Seed E2E Test Data
          </button>
          <button
            type="button"
            onClick={() => { setConfirming("reset"); setResult({ kind: "idle" }); }}
            disabled={anyPending}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 border border-amber-700 bg-white hover:bg-amber-100 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
          >
            {resetMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
            Reset Test Data
          </button>

          {/* Result display */}
          {result.kind === "seeded" && (
            <span className="text-xs text-green-700">
              ✅ Seeded: {result.inserted.customers} customers · {result.inserted.certs} certs · {result.inserted.transfers} transfers · {result.inserted.vaultClubRows} Vault Club rows
            </span>
          )}
          {result.kind === "already-seeded" && (
            <span className="text-xs text-amber-900">⚠️ Already seeded — run Reset first.</span>
          )}
          {result.kind === "reset" && (
            <span className="text-xs text-green-700">
              ✅ Reset: {result.deleted.total} rows deleted ({result.deleted.certificates} certs, {result.deleted.users} users, {result.deleted.transfers} transfers…)
            </span>
          )}
          {result.kind === "error" && (
            <span className="text-xs text-red-600">❌ {result.message}</span>
          )}
        </div>
      </div>

      {/* Confirmation modal */}
      {confirming && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50"
          onClick={anyPending ? undefined : () => setConfirming(null)}
        >
          <div
            className="bg-white rounded-xl max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#E8E4DC]">
              <h3 className="text-sm font-bold text-[#1A1A1A]">
                {confirming === "seed" ? "Seed E2E Test Data" : "Reset Test Data"}
              </h3>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={anyPending}
                className="text-[#999] hover:text-[#1A1A1A] disabled:opacity-40"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-[#444444] mb-4">
                {confirming === "seed"
                  ? "Seed 10 test certs, 3 test users, 5 transfers, 2 subscriptions. Test data uses MV900xxx IDs and @staging-test.mintvault.dev emails. Only runs on staging."
                  : "Delete all test data (MV900xxx + @staging-test emails). Real data is protected by triple-guard + 50-row safety limit. Continue?"}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  disabled={anyPending}
                  className="px-3 py-1.5 text-xs font-semibold border border-[#E8E4DC] rounded hover:bg-[#F5F2EB] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirming === "seed") seedMutation.mutate();
                    else resetMutation.mutate();
                  }}
                  disabled={anyPending}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded transition-colors disabled:opacity-50 ${
                    confirming === "seed"
                      ? "bg-amber-500 hover:bg-amber-600 text-white"
                      : "bg-red-600 hover:bg-red-700 text-white"
                  }`}
                >
                  {anyPending ? <Loader2 size={12} className="animate-spin" /> : null}
                  {confirming === "seed" ? "Seed" : "Reset"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
