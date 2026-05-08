import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Award, ChevronLeft, RefreshCw } from "lucide-react";

interface LedgerRow {
  id:          string;
  delta:       number;
  reason:      string;
  source_type: string | null;
  source_id:   string | null;
  metadata:    Record<string, unknown> | null;
  expires_at:  string | null;
  created_at:  string;
}

interface MeResponse {
  user_id: string | null;
  balance: number;
  total:   number;
  ledger:  LedgerRow[];
}

const PAGE_SIZE = 20;

function fmtSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
}

function reasonLabel(r: string): string {
  switch (r) {
    case "order_completed": return "Order completed";
    case "admin_adjust":    return "Admin adjustment";
    case "redeem":          return "Redemption";
    case "expire":          return "Expired";
    case "referral":        return "Referral";
    default:                return r;
  }
}

export default function DashboardLoyaltyPage() {
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<MeResponse>({
    queryKey: ["/api/loyalty/me", { limit: PAGE_SIZE, offset }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      const res = await fetch(`/api/loyalty/me?${params}`, { credentials: "include" });
      if (res.status === 401) throw new Error("not_authenticated");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    retry: false,
  });

  const total = data?.total ?? 0;
  const hasMore = offset + PAGE_SIZE < total;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-[#888] hover:text-[#1A1A1A] text-sm"
      >
        <ChevronLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-center gap-3">
        <Award size={22} className="text-[#D4AF37]" />
        <div>
          <h1 className="text-xl font-bold text-[#1A1A1A]">Loyalty points</h1>
          <p className="text-[#888] text-sm">
            Your points balance and activity history. Earning + redemption launching soon — see programme T&Cs once published.
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full" />
        </div>
      )}

      {isError && (error as Error)?.message === "not_authenticated" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-6 text-center">
          <p className="text-amber-900 font-bold mb-1">Please sign in to view your loyalty balance</p>
          <p className="text-amber-800 text-sm">
            <Link href="/dashboard" className="underline">Open your dashboard</Link> to log in via the magic link sent to your email.
          </p>
        </div>
      )}

      {data && (
        <>
          {/* Balance card */}
          <div className="bg-gradient-to-br from-[#D4AF37]/10 to-[#FBF8EE] border border-[#D4AF37]/30 rounded-xl p-8 text-center">
            <p className="text-[#D4AF37] text-xs uppercase tracking-widest font-bold mb-2">Current balance</p>
            <p className="text-5xl font-black text-[#1A1A1A] tabular-nums">{data.balance}</p>
            <p className="text-[#888] text-sm mt-2">
              {data.balance === 0
                ? "No points yet — earning launches once the loyalty programme T&Cs are published."
                : "points available"}
            </p>
          </div>

          {/* Ledger */}
          <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 border-b border-[#E8E4DC]">
              <h2 className="text-[#1A1A1A] font-bold">Activity</h2>
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isFetching}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-[#D4D0C8] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-60"
              >
                <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
                Refresh
              </button>
            </div>

            {data.ledger.length === 0 ? (
              <div className="p-12 text-center text-[#888] text-sm">
                No activity yet. Once the programme is live, every completed submission and grading service will earn points.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#F0EDE5]">
                  <tr className="text-[10px] uppercase tracking-widest text-[#888]">
                    <th className="text-left  px-4 py-2">When</th>
                    <th className="text-left  px-4 py-2">Reason</th>
                    <th className="text-left  px-4 py-2">Source</th>
                    <th className="text-right px-4 py-2 w-24">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledger.map(row => (
                    <tr key={row.id} className="border-b border-[#E8E4DC] last:border-0">
                      <td className="px-4 py-2 text-[#555] text-xs whitespace-nowrap">{fmtDate(row.created_at)}</td>
                      <td className="px-4 py-2 text-[#1A1A1A]">{reasonLabel(row.reason)}</td>
                      <td className="px-4 py-2 text-[#888] text-xs">
                        {row.source_type ? `${row.source_type}${row.source_id ? `:${row.source_id}` : ""}` : "—"}
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums font-bold ${row.delta > 0 ? "text-green-700" : row.delta < 0 ? "text-red-700" : "text-[#888]"}`}>
                        {fmtSigned(row.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {(offset > 0 || hasMore) && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-[#E8E4DC] text-xs">
                <span className="text-[#888]">
                  Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                    className="px-3 py-1 rounded border border-[#D4D0C8] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={!hasMore}
                    className="px-3 py-1 rounded border border-[#D4D0C8] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <p className="text-[#888] text-xs">
        Points are non-monetary — they redeem only against MintVault grading services per the programme T&Cs. Redemption opens once T&Cs are published.
      </p>
    </div>
  );
}
