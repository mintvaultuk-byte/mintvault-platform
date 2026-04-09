import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Loader2, ExternalLink } from "lucide-react";
import SeoHead from "@/components/seo-head";

interface PopCert {
  certId: string;
  cardName: string | null;
  setName: string | null;
  cardGame: string | null;
  grade: string | null;
  gradedAt: string | null;
}

function gradeColor(grade: string | null): string {
  const n = parseFloat(grade ?? "");
  if (isNaN(n)) return "#999999";
  if (n === 10) return "#D4AF37";
  if (n >= 9)   return "#B8960C";
  if (n >= 8)   return "#555555";
  if (n >= 7)   return "#777777";
  return "#AAAAAA";
}

export default function PopCertsPage() {
  const [location] = useLocation();
  const params = new URLSearchParams(location.split("?")[1] ?? "");
  const card = params.get("card") ?? "";
  const set  = params.get("set")  ?? "";

  const { data, isLoading, isError } = useQuery<PopCert[]>({
    queryKey: ["/api/population/certs", card, set],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (card) p.set("card", card);
      if (set)  p.set("set",  set);
      const res = await fetch(`/api/population/certs?${p.toString()}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!(card || set),
  });

  const title = [card, set].filter(Boolean).join(" — ") || "Certificates";

  return (
    <>
      <SeoHead
        title={`${title} | Population | MintVault`}
        description={`All MintVault certificates for ${title}`}
        canonical="/population"
      />

      <div className="px-4 py-12 max-w-4xl mx-auto">

        {/* Back link */}
        <Link href="/population" className="inline-flex items-center gap-1.5 text-[#B8960C] text-sm font-semibold hover:underline underline-offset-2 mb-8">
          <ArrowLeft size={14} />
          Population Report
        </Link>

        {/* Header */}
        <div className="mb-8">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-2">Population Report</p>
          <h1 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight mb-1">
            {card || set || "All Certificates"}
          </h1>
          {set && card && (
            <p className="text-[#666666] text-sm">{set}</p>
          )}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center gap-3 py-16 text-[#D4AF37]/60">
            <Loader2 size={22} className="animate-spin" />
            <span className="text-sm">Loading certificates…</span>
          </div>
        )}

        {/* Error */}
        {isError && (
          <p className="text-center text-red-400 text-sm py-10">
            Failed to load certificates. Please try again.
          </p>
        )}

        {/* Empty */}
        {!isLoading && !isError && data && data.length === 0 && (
          <p className="text-center text-[#999999] text-sm py-10">
            No certificates found for this card.
          </p>
        )}

        {/* Results */}
        {!isLoading && !isError && data && data.length > 0 && (
          <div className="border border-[#D4AF37]/20 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#D4AF37]/20 bg-[#FFF9E6]">
                    <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Cert ID</th>
                    <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3 hidden sm:table-cell">Card</th>
                    <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3 hidden md:table-cell">Set</th>
                    <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Grade</th>
                    <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3 hidden sm:table-cell">Date</th>
                    <th className="px-4 py-3"><span className="sr-only">Open Vault</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((cert, i) => (
                    <tr
                      key={i}
                      className="border-b border-[#E8E4DC] last:border-0 hover:bg-[#FFF9E6] transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-[#555555]">{cert.certId}</span>
                        {/* show card name inline on mobile where card col is hidden */}
                        {cert.cardName && (
                          <div className="text-[#1A1A1A] font-semibold text-sm sm:hidden">{cert.cardName}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#1A1A1A] font-medium hidden sm:table-cell">
                        {cert.cardName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-[#888888] text-sm hidden md:table-cell">
                        {cert.setName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className="font-mono font-bold text-sm"
                          style={{ color: gradeColor(cert.grade) }}
                        >
                          {cert.grade ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[#999999] text-xs text-right hidden sm:table-cell">
                        {cert.gradedAt
                          ? new Date(cert.gradedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/vault/${cert.certId}`}
                          className="inline-flex items-center gap-1 text-[#D4AF37]/60 hover:text-[#D4AF37] text-xs underline-offset-2 hover:underline transition-colors"
                        >
                          Vault
                          <ExternalLink size={11} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-[#E8E4DC] text-xs text-[#999999]">
              {data.length} certificate{data.length !== 1 ? "s" : ""}
              {data.length === 500 ? " (limit 500)" : ""}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
