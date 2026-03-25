import { FileText, CheckCircle, BarChart3, Eye } from "lucide-react";

const mockReport = {
  certId: "MV1",
  cardName: "Charizard",
  cardSet: "Base Set (1999)",
  cardNumber: "4/102",
  overallGrade: 10,
  gradeLabel: "GEM MINT",
  subgrades: [
    { name: "Centering", score: 10 },
    { name: "Corners", score: 10 },
    { name: "Edges", score: 9.5 },
    { name: "Surface", score: 10 },
  ],
  graderNotes: "Exceptional card with near-flawless presentation. Minor edge softening at top-left under 10x magnification. No print lines, no whitening, perfect gloss retention.",
  gradedDate: "15 January 2026",
  tier: "ELITE",
};

export default function ReportsPage() {
  return (
    <div className="px-4 py-12 max-w-3xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest text-center mb-4 glow-gold"
        data-testid="text-reports-title"
      >
        GRADING REPORTS
      </h1>
      <p className="text-gray-300 text-center mb-12 max-w-xl mx-auto" data-testid="text-reports-subtitle">
        Every MintVault graded card receives a detailed grading report breaking down the assessment
        across multiple criteria. Here's what to expect.
      </p>

      <div className="border border-[#D4AF37]/20 rounded-lg p-6 md:p-8 mb-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
            <FileText size={24} />
          </div>
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide glow-gold-sm" data-testid="text-what-included">
            What's Included
          </h2>
        </div>
        <ul className="space-y-2">
          {[
            "Overall grade from 1 to 10 (including half grades)",
            "Individual subgrades for Centering, Corners, Edges, and Surface",
            "Detailed grader notes (Premier tier and above)",
            "High-resolution front & back imaging (Ultra tier and above)",
            "Population report inclusion (Elite tier)",
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircle size={16} className="text-[#D4AF37] mt-0.5 shrink-0" />
              <span className="text-gray-300 text-sm" data-testid={`text-included-${i}`}>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-6 glow-gold-sm text-center" data-testid="text-example-heading">
        Example Grading Report
      </h2>

      <div className="border border-[#D4AF37]/30 rounded-lg overflow-hidden" data-testid="card-mock-report">
        <div className="bg-gradient-to-r from-[#D4AF37]/10 to-transparent p-5 border-b border-[#D4AF37]/20">
          <div className="flex items-center gap-2 mb-1">
            <Eye size={16} className="text-[#D4AF37]" />
            <span className="text-[#D4AF37]/60 text-xs uppercase tracking-widest">Sample Report</span>
          </div>
          <p className="font-mono text-[#D4AF37] font-bold tracking-wider" data-testid="text-report-cert-id">
            {mockReport.certId}
          </p>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-[#D4AF37]/60 text-xs uppercase tracking-wider block mb-1">Card</span>
              <span className="text-white font-medium" data-testid="text-report-card">{mockReport.cardName}</span>
            </div>
            <div>
              <span className="text-[#D4AF37]/60 text-xs uppercase tracking-wider block mb-1">Set</span>
              <span className="text-white font-medium" data-testid="text-report-set">{mockReport.cardSet}</span>
            </div>
            <div>
              <span className="text-[#D4AF37]/60 text-xs uppercase tracking-wider block mb-1">Number</span>
              <span className="text-white font-medium" data-testid="text-report-number">{mockReport.cardNumber}</span>
            </div>
            <div>
              <span className="text-[#D4AF37]/60 text-xs uppercase tracking-wider block mb-1">Service Tier</span>
              <span className="text-white font-medium" data-testid="text-report-tier">{mockReport.tier}</span>
            </div>
          </div>

          <div className="text-center py-4 border-y border-[#D4AF37]/10">
            <div className="text-5xl font-bold text-emerald-400 mb-1" data-testid="text-report-grade">
              {mockReport.overallGrade}
            </div>
            <div className="text-[#D4AF37] font-semibold tracking-widest text-sm" data-testid="text-report-grade-label">
              {mockReport.gradeLabel}
            </div>
          </div>

          <div>
            <h3 className="text-[#D4AF37]/70 text-xs uppercase tracking-widest mb-3">Subgrades</h3>
            <div className="grid grid-cols-2 gap-3">
              {mockReport.subgrades.map((sg) => (
                <div key={sg.name} className="border border-[#D4AF37]/15 rounded p-3 text-center" data-testid={`card-subgrade-${sg.name.toLowerCase()}`}>
                  <div className="text-2xl font-bold text-white mb-0.5">{sg.score}</div>
                  <div className="text-[#D4AF37]/60 text-xs uppercase tracking-wider">{sg.name}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-[#D4AF37]/70 text-xs uppercase tracking-widest mb-2">Grader Notes</h3>
            <p className="text-gray-400 text-sm leading-relaxed italic" data-testid="text-report-notes">
              "{mockReport.graderNotes}"
            </p>
          </div>

          <div className="text-[#D4AF37]/40 text-xs text-right" data-testid="text-report-date">
            Graded: {mockReport.gradedDate}
          </div>
        </div>
      </div>
    </div>
  );
}
