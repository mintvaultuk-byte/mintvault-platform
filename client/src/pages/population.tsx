import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, BarChart3, Loader2 } from "lucide-react";

interface PopRow {
  cardGame: string | null;
  setName: string | null;
  cardName: string | null;
  total: number;
  gBL: number;
  g10: number;
  g9: number;
  g8: number;
  g7: number;
  gLow: number;
}

const GRADE_COLS: { key: keyof PopRow; label: string; color: string }[] = [
  { key: "gBL",  label: "BL",  color: "#D4AF37" },
  { key: "g10",  label: "10",  color: "#B8960C" },
  { key: "g9",   label: "9",   color: "#555555" },
  { key: "g8",   label: "8",   color: "#777777" },
  { key: "g7",   label: "7",   color: "#999999" },
  { key: "gLow", label: "≤6",  color: "#AAAAAA" },
];

export default function PopulationPage() {
  const [game, setGame] = useState("");
  const [set,  setSet]  = useState("");
  const [card, setCard] = useState("");
  const [submitted, setSubmitted] = useState({ game: "", set: "", card: "" });

  const { data, isLoading, isError } = useQuery<PopRow[]>({
    queryKey: ["/api/population", submitted.game, submitted.set, submitted.card],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (submitted.game) params.set("game", submitted.game);
      if (submitted.set)  params.set("set",  submitted.set);
      if (submitted.card) params.set("card", submitted.card);
      const res = await fetch(`/api/population?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted({ game, set, card });
  }

  function certUrl(row: PopRow) {
    const params = new URLSearchParams();
    if (row.cardName) params.set("card", row.cardName);
    if (row.setName)  params.set("set",  row.setName);
    return `/population/certs?${params.toString()}`;
  }

  return (
    <div className="px-4 py-12 max-w-4xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-sans font-bold text-[#1A1A1A] tracking-tight text-center mb-4"
        data-testid="text-population-title"
      >
        Population Report
      </h1>
      <p className="text-[#444444] text-center mb-10 max-w-xl mx-auto" data-testid="text-population-subtitle">
        Every card graded by MintVault is recorded here. Use the filters below to see how many copies
        of a card have been graded and at which grade levels.
      </p>

      {/* How it works */}
      <div className="border border-[#D4AF37]/20 rounded-lg p-6 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
            <BarChart3 size={20} />
          </div>
          <h2 className="text-lg font-sans font-bold text-[#1A1A1A] tracking-tight">
            How Population Data Works
          </h2>
        </div>
        <ul className="space-y-2">
          {[
            "Total graded count for each card across all grade levels",
            "Grade distribution shows scarcity at each tier — useful for pricing",
            "BL = Black Label: all four sub-scores are 10 (quad-10)",
            "Updated in real time as new cards are graded and certified",
            "Click 'View certs' to see individual certificates for that card",
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span className="text-[#666666] text-sm">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Search form */}
      <form
        onSubmit={handleSearch}
        className="border border-[#D4AF37]/20 rounded-lg p-5 mb-8 flex flex-col sm:flex-row gap-3"
      >
        <input
          type="text"
          placeholder="Game (e.g. Pokémon)"
          value={game}
          onChange={e => setGame(e.target.value)}
          className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/70"
        />
        <input
          type="text"
          placeholder="Set name"
          value={set}
          onChange={e => setSet(e.target.value)}
          className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/70"
        />
        <input
          type="text"
          placeholder="Card name"
          value={card}
          onChange={e => setCard(e.target.value)}
          className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/70"
        />
        <button
          type="submit"
          className="btn-gold flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded"
        >
          <Search size={15} />
          Search
        </button>
      </form>

      {/* Results */}
      {isLoading && (
        <div className="flex items-center justify-center gap-3 py-16 text-[#D4AF37]/60">
          <Loader2 size={22} className="animate-spin" />
          <span className="text-sm">Loading population data…</span>
        </div>
      )}

      {isError && (
        <p className="text-center text-red-400 text-sm py-10">
          Failed to load population data. Please try again.
        </p>
      )}

      {!isLoading && !isError && data && data.length === 0 && (
        <p className="text-center text-[#999999] text-sm py-10">
          No graded cards match your filters yet. Try a broader search or check back as more cards are graded.
        </p>
      )}

      {!isLoading && !isError && data && data.length > 0 && (
        <div data-testid="table-population">

          {/* ── Desktop table (sm+) ── */}
          <div className="hidden sm:block border border-[#D4AF37]/20 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#D4AF37]/20 bg-[#FFF9E6]">
                    <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Card</th>
                    <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3 hidden md:table-cell">Set</th>
                    <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Total</th>
                    {GRADE_COLS.map(col => (
                      <th key={col.key} className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">
                        {col.label}
                      </th>
                    ))}
                    <th className="px-4 py-3"><span className="sr-only">View certs</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-[#E8E4DC] last:border-0 hover:bg-[#FFF9E6] transition-colors"
                      data-testid={`row-population-${i}`}
                    >
                      <td className="px-4 py-3">
                        <div className="text-[#1A1A1A] font-semibold text-sm">{row.cardName ?? "—"}</div>
                        {row.cardGame && (
                          <div className="text-[#D4AF37]/40 text-xs">{row.cardGame}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#D4AF37]/60 text-sm hidden md:table-cell">
                        {row.setName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-[#1A1A1A] font-mono font-semibold text-right">{row.total}</td>
                      {GRADE_COLS.map(col => (
                        <td key={col.key} className="px-4 py-3 font-mono text-right" style={{ color: col.color }}>
                          {(row[col.key] as number) || "—"}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={certUrl(row)}
                          className="text-[#D4AF37]/60 hover:text-[#D4AF37] text-xs underline-offset-2 hover:underline transition-colors"
                        >
                          View certs
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-[#E8E4DC] text-xs text-[#999999]">
              Showing {data.length} result{data.length !== 1 ? "s" : ""}
              {data.length === 200 ? " (limit 200 — refine your search for more specific results)" : ""}
            </div>
          </div>

          {/* ── Mobile card layout (< sm) ── */}
          <div className="sm:hidden space-y-3">
            {data.map((row, i) => (
              <div
                key={i}
                className="border border-[#D4AF37]/20 rounded-lg p-4 bg-white"
                data-testid={`card-population-${i}`}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <div className="text-[#1A1A1A] font-semibold text-sm">{row.cardName ?? "—"}</div>
                    {row.setName && (
                      <div className="text-[#888888] text-xs mt-0.5">{row.setName}</div>
                    )}
                    {row.cardGame && (
                      <div className="text-[#D4AF37]/50 text-xs">{row.cardGame}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[#1A1A1A] font-mono font-bold text-lg leading-none">{row.total}</div>
                    <div className="text-[#999999] text-xs">total</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-3">
                  {GRADE_COLS.map(col => {
                    const val = row[col.key] as number;
                    if (!val) return null;
                    return (
                      <span
                        key={col.key}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono font-semibold border"
                        style={{ color: col.color, borderColor: `${col.color}40`, background: `${col.color}10` }}
                      >
                        <span className="font-bold">{col.label}</span>
                        <span>{val}</span>
                      </span>
                    );
                  })}
                </div>
                <Link
                  href={certUrl(row)}
                  className="text-[#B8960C] text-xs font-semibold hover:underline underline-offset-2"
                >
                  View certificates →
                </Link>
              </div>
            ))}
            <p className="text-[#999999] text-xs text-center pt-1">
              Showing {data.length} result{data.length !== 1 ? "s" : ""}
              {data.length === 200 ? " (limit 200)" : ""}
            </p>
          </div>

        </div>
      )}
    </div>
  );
}
