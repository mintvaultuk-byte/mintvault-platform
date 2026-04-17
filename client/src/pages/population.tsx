import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, BarChart3, Loader2 } from "lucide-react";
import SeoHead from "@/components/seo-head";

/* ── Types ── */

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

interface PopulationResponse {
  counters: {
    total_graded: number;
    unique_cards: number;
    unique_sets: number;
    claimed_count: number;
    avg_grade: number;
  };
  recent: Array<{
    certificate_number: string;
    card_name: string | null;
    card_set: string | null;
    grade: number | null;
    label_type: string;
    card_image_front_url: string | null;
    approved_at: string;
  }>;
  population: PopRow[];
}

/* ── Helpers ── */

function CounterTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white border border-[#E8E4DC] rounded-xl p-6 text-center">
      <p className="text-3xl md:text-4xl font-black text-[#D4AF37] mb-1">{value}</p>
      <p className="text-[10px] font-bold uppercase tracking-widest text-[#888888]">{label}</p>
    </div>
  );
}

function titleCase(s: string | null): string {
  if (!s) return "—";
  const specials: Record<string, string> = { pokemon: "Pokémon" };
  return s
    .split(" ")
    .map(w => specials[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

const GRADE_COLS: { key: keyof PopRow; label: string; color: string }[] = [
  { key: "gBL",  label: "BL",  color: "#D4AF37" },
  { key: "g10",  label: "10",  color: "#B8960C" },
  { key: "g9",   label: "9",   color: "#555555" },
  { key: "g8",   label: "8",   color: "#777777" },
  { key: "g7",   label: "7",   color: "#888888" },
  { key: "gLow", label: "≤6",  color: "#AAAAAA" },
];

/* ── Page ── */

export default function PopulationPage() {
  const [game, setGame] = useState("");
  const [set,  setSet]  = useState("");
  const [card, setCard] = useState("");
  const [submitted, setSubmitted] = useState({ game: "", set: "", card: "" });

  const { data, isLoading, isError } = useQuery<PopulationResponse>({
    queryKey: ["/api/population", submitted.game, submitted.set, submitted.card],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (submitted.game) params.set("game", submitted.game);
      if (submitted.set)  params.set("set",  submitted.set);
      if (submitted.card) params.set("card", submitted.card);
      const res = await fetch(`/api/population?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      // Backwards compat: old API returned a plain array
      if (Array.isArray(json)) {
        return {
          counters: { total_graded: 0, unique_cards: 0, unique_sets: 0, claimed_count: 0, avg_grade: 0 },
          recent: [],
          population: json,
        } as PopulationResponse;
      }
      return json as PopulationResponse;
    },
  });

  const counters = data?.counters;
  const recent = data?.recent ?? [];
  const population = data?.population ?? [];

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
    <>
      <SeoHead
        title="Population Report | MintVault"
        description="Browse every card graded by MintVault. View grade distributions, scarcity data, and individual certificates."
        canonical="/population"
      />

      {/* ── Section 1: Hero + Counters ── */}
      <section className="py-16 md:py-20 bg-[#FAFAF8] border-b border-[#E8E4DC]">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-[#D4AF37] mb-3">Public Registry</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] tracking-tight mb-4">Population Report</h1>
          <p className="text-base text-[#555555] max-w-2xl mx-auto mb-10">
            Browse every card graded by MintVault. Tap any certificate to see its full ownership logbook.
          </p>

          {counters && counters.total_graded > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
              <CounterTile label="Cards Graded" value={counters.total_graded.toLocaleString()} />
              <CounterTile label="Unique Cards" value={counters.unique_cards.toLocaleString()} />
              <CounterTile label="Sets Covered" value={counters.unique_sets.toLocaleString()} />
              <CounterTile label="Avg Grade" value={counters.avg_grade > 0 ? counters.avg_grade.toFixed(1) : "—"} />
            </div>
          )}
        </div>
      </section>

      {/* ── Section 2: Recently Graded ── */}
      {recent.length > 0 && (
        <section className="py-16 md:py-20">
          <div className="max-w-6xl mx-auto px-6">
            <p className="text-xs font-bold uppercase tracking-widest text-[#D4AF37] mb-3 text-center">Latest</p>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight text-center mb-10">
              Recently Graded
            </h2>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {recent.slice(0, 12).map(cert => (
                <Link
                  key={cert.certificate_number}
                  href={`/cert/${cert.certificate_number}`}
                  className="group block bg-white border border-[#E8E4DC] rounded-xl overflow-hidden hover:border-[#D4AF37]/40 transition-colors"
                >
                  {/* Card image */}
                  <div className="relative aspect-[3/4] bg-[#F7F7F5]">
                    {cert.card_image_front_url ? (
                      <img
                        src={cert.card_image_front_url}
                        alt={cert.card_name ?? "Card"}
                        className="w-full h-full object-contain p-3"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#AAAAAA] text-xs">
                        No photo
                      </div>
                    )}

                    {/* Grade medallion */}
                    {cert.grade !== null && (
                      <div className="absolute top-2 right-2 w-10 h-10 rounded-full bg-white border-2 border-[#D4AF37] flex items-center justify-center shadow-sm">
                        <span className="text-xs font-black text-[#1A1A1A]">{cert.grade}</span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-3">
                    <p className="text-sm font-bold text-[#1A1A1A] truncate group-hover:text-[#B8960C] transition-colors">
                      {titleCase(cert.card_name)}
                    </p>
                    {cert.card_set && (
                      <p className="text-xs text-[#888888] truncate mt-0.5">{titleCase(cert.card_set)}</p>
                    )}
                    <p className="text-[10px] text-[#AAAAAA] font-mono mt-1">{cert.certificate_number}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Section 3: Search + Population Table ── */}
      <section className="py-16 md:py-20 bg-[#FAFAF8] border-t border-[#E8E4DC]">
        <div className="max-w-4xl mx-auto px-6">
          <p className="text-xs font-bold uppercase tracking-widest text-[#D4AF37] mb-3 text-center">Explore</p>
          <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight text-center mb-10">
            Browse the Registry
          </h2>

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
              className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#888888] focus:outline-none focus:border-[#D4AF37]/70"
            />
            <input
              type="text"
              placeholder="Set name"
              value={set}
              onChange={e => setSet(e.target.value)}
              className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#888888] focus:outline-none focus:border-[#D4AF37]/70"
            />
            <input
              type="text"
              placeholder="Card name"
              value={card}
              onChange={e => setCard(e.target.value)}
              className="flex-1 bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#888888] focus:outline-none focus:border-[#D4AF37]/70"
            />
            <button
              type="submit"
              className="btn-gold flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded"
            >
              <Search size={15} />
              Search →
            </button>
          </form>

          {/* How it works */}
          <div className="border border-[#D4AF37]/20 rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
                <BarChart3 size={20} />
              </div>
              <h3 className="text-lg font-sans font-bold text-[#1A1A1A] tracking-tight">
                How Population Data Works
              </h3>
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
                  <span className="text-[#555555] text-sm">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Results */}
          {isLoading && (
            <div className="flex items-center justify-center gap-3 py-16 text-[#D4AF37]/60">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-sm">Loading population data…</span>
            </div>
          )}

          {isError && (
            <p className="text-center text-red-600 text-sm py-10">
              Failed to load population data. Please try again.
            </p>
          )}

          {!isLoading && !isError && population.length === 0 && (
            <p className="text-center text-[#888888] text-sm py-10">
              No graded cards match your filters yet. Try a broader search or check back as more cards are graded.
            </p>
          )}

          {!isLoading && !isError && population.length > 0 && (
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
                      {population.map((row, i) => (
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
                <div className="px-4 py-3 border-t border-[#E8E4DC] text-xs text-[#888888]">
                  Showing {population.length} result{population.length !== 1 ? "s" : ""}
                  {population.length === 200 ? " (limit 200 — refine your search for more specific results)" : ""}
                </div>
              </div>

              {/* ── Mobile card layout (< sm) ── */}
              <div className="sm:hidden space-y-3">
                {population.map((row, i) => (
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
                        <div className="text-[#888888] text-xs">total</div>
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
                <p className="text-[#888888] text-xs text-center pt-1">
                  Showing {population.length} result{population.length !== 1 ? "s" : ""}
                  {population.length === 200 ? " (limit 200)" : ""}
                </p>
              </div>

            </div>
          )}
        </div>
      </section>
    </>
  );
}
