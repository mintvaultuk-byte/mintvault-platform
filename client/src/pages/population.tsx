import { BarChart3, TrendingUp, TrendingDown, Minus } from "lucide-react";

const mockPopulationData = [
  { grade: "10", label: "GEM MINT", count: 47, higher: 0, same: 47, lower: 1203 },
  { grade: "9.5", label: "MINT+", count: 83, higher: 47, same: 83, lower: 1120 },
  { grade: "9", label: "MINT", count: 215, higher: 130, same: 215, lower: 905 },
  { grade: "8.5", label: "NM-MT+", count: 178, higher: 345, same: 178, lower: 727 },
  { grade: "8", label: "NM-MT", count: 312, higher: 523, same: 312, lower: 415 },
  { grade: "7.5", label: "NEAR MINT+", count: 156, higher: 835, same: 156, lower: 259 },
  { grade: "7", label: "NEAR MINT", count: 134, higher: 991, same: 134, lower: 125 },
  { grade: "6", label: "EX-MT", count: 75, higher: 1125, same: 75, lower: 50 },
  { grade: "5", label: "EXCELLENT", count: 32, higher: 1200, same: 32, lower: 18 },
  { grade: "4 & below", label: "VG & LOWER", count: 18, higher: 1232, same: 18, lower: 0 },
];

const totalGraded = mockPopulationData.reduce((sum, row) => sum + row.count, 0);

export default function PopulationPage() {
  return (
    <div className="px-4 py-12 max-w-3xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest text-center mb-4 glow-gold"
        data-testid="text-population-title"
      >
        POPULATION REPORT
      </h1>
      <p className="text-gray-300 text-center mb-12 max-w-xl mx-auto" data-testid="text-population-subtitle">
        MintVault tracks every graded card to provide full transparency on scarcity and grading
        distribution. Our population data helps collectors and investors make informed decisions.
      </p>

      <div className="border border-[#D4AF37]/20 rounded-lg p-6 md:p-8 mb-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
            <BarChart3 size={24} />
          </div>
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide glow-gold-sm" data-testid="text-how-it-works">
            How Population Data Works
          </h2>
        </div>
        <p className="text-gray-300 leading-relaxed mb-4" data-testid="text-how-body">
          Every card graded by MintVault is recorded in our population database. This tracks how many
          copies of each card have been graded at each grade level, giving you a clear picture of
          relative scarcity.
        </p>
        <ul className="space-y-2">
          {[
            "Total graded count for each card across all grade levels",
            "Higher / Same / Lower comparisons at each grade point",
            "Full market transparency for buyers and sellers",
            "Updated regularly as new cards are graded",
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span className="text-[#D4AF37]/90 text-sm" data-testid={`text-pop-bullet-${i}`}>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-2 glow-gold-sm text-center" data-testid="text-example-table-heading">
        Example Population Table
      </h2>
      <p className="text-gray-500 text-sm text-center mb-6" data-testid="text-example-card">
        Charizard — Base Set (1999) #4/102 &nbsp;·&nbsp; Total Graded: {totalGraded.toLocaleString()}
      </p>

      <div className="border border-[#D4AF37]/20 rounded-lg overflow-hidden" data-testid="table-population">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#D4AF37]/20 bg-[#D4AF37]/5">
                <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Grade</th>
                <th className="text-left text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3 hidden sm:table-cell">Label</th>
                <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">Count</th>
                <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">
                  <span className="hidden sm:inline">Higher</span>
                  <TrendingUp size={14} className="inline sm:hidden text-[#D4AF37]/50" />
                </th>
                <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">
                  <span className="hidden sm:inline">Same</span>
                  <Minus size={14} className="inline sm:hidden text-[#D4AF37]/50" />
                </th>
                <th className="text-right text-[#D4AF37]/70 text-xs uppercase tracking-wider px-4 py-3">
                  <span className="hidden sm:inline">Lower</span>
                  <TrendingDown size={14} className="inline sm:hidden text-[#D4AF37]/50" />
                </th>
              </tr>
            </thead>
            <tbody>
              {mockPopulationData.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-[#D4AF37]/10 last:border-0"
                  data-testid={`row-population-${i}`}
                >
                  <td className="px-4 py-3 text-white font-semibold">{row.grade}</td>
                  <td className="px-4 py-3 text-[#D4AF37]/60 hidden sm:table-cell">{row.label}</td>
                  <td className="px-4 py-3 text-white text-right font-mono">{row.count}</td>
                  <td className="px-4 py-3 text-gray-500 text-right font-mono">{row.higher}</td>
                  <td className="px-4 py-3 text-[#D4AF37]/60 text-right font-mono">{row.same}</td>
                  <td className="px-4 py-3 text-gray-500 text-right font-mono">{row.lower}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-gray-600 text-xs text-center mt-4 italic" data-testid="text-pop-disclaimer">
        This is sample data for demonstration purposes. Live population data will be available when
        the full database launches.
      </p>
    </div>
  );
}
