import { Trophy, Clock, Star } from "lucide-react";

interface GradedCard {
  certId: string;
  cardName: string;
  grade: number | string;
  durationSeconds: number;
  isBlackLabel?: boolean;
}

interface Props {
  cards: GradedCard[];
  sessionDurationSeconds: number;
  onClose: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SessionSummary({ cards, sessionDurationSeconds, onClose }: Props) {
  const numericCards = cards.filter(c => typeof c.grade === "number");
  const avgGrade = numericCards.length > 0
    ? (numericCards.reduce((a, c) => a + (c.grade as number), 0) / numericCards.length).toFixed(2)
    : "—";
  const avgTime = cards.length > 0
    ? Math.round(cards.reduce((a, c) => a + c.durationSeconds, 0) / cards.length)
    : 0;
  const fastest = cards.length > 0 ? cards.reduce((a, b) => a.durationSeconds < b.durationSeconds ? a : b) : null;
  const slowest = cards.length > 0 ? cards.reduce((a, b) => a.durationSeconds > b.durationSeconds ? a : b) : null;
  const blackLabels = cards.filter(c => c.isBlackLabel);

  // Grade distribution
  const gradeBuckets: Record<string, number> = {};
  numericCards.forEach(c => {
    const g = String(c.grade);
    gradeBuckets[g] = (gradeBuckets[g] || 0) + 1;
  });

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-[#111111] border border-[#D4AF37]/30 rounded-2xl p-6 max-w-md w-full space-y-5">

        <div className="text-center">
          <Trophy size={32} className="text-[#D4AF37] mx-auto mb-2" />
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Session Complete</p>
          <p className="text-white text-2xl font-black mt-1">{cards.length} Cards Graded</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Avg Grade", value: avgGrade },
            { label: "Total Time", value: formatTime(sessionDurationSeconds) },
            { label: "Avg / Card", value: formatTime(avgTime) },
          ].map(({ label, value }) => (
            <div key={label} className="bg-[#0A0A0A] rounded-lg p-3 text-center">
              <p className="text-[#555555] text-[9px] uppercase tracking-widest mb-1">{label}</p>
              <p className="text-[#D4AF37] text-lg font-black">{value}</p>
            </div>
          ))}
        </div>

        {/* Grade distribution */}
        {numericCards.length > 0 && (
          <div>
            <p className="text-[#888888] text-[10px] uppercase tracking-widest mb-2">Grade Distribution</p>
            <div className="flex items-end gap-1 h-12">
              {Object.entries(gradeBuckets).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).map(([grade, count]) => (
                <div key={grade} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full bg-[#D4AF37] rounded-t" style={{ height: `${(count / cards.length) * 40}px`, minHeight: 4 }} />
                  <span className="text-[#555555] text-[8px]">{grade}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Fastest / Slowest */}
        <div className="space-y-1.5">
          {fastest && <div className="flex justify-between text-xs"><span className="text-[#555555]">Fastest</span><span className="text-emerald-400">{fastest.certId} — {formatTime(fastest.durationSeconds)}</span></div>}
          {slowest && <div className="flex justify-between text-xs"><span className="text-[#555555]">Slowest</span><span className="text-[#888888]">{slowest.certId} — {formatTime(slowest.durationSeconds)}</span></div>}
        </div>

        {/* Black Labels */}
        {blackLabels.length > 0 && (
          <div className="border border-[#D4AF37]/30 rounded-lg px-4 py-3 bg-[#D4AF37]/5">
            <div className="flex items-center gap-2">
              <Star size={14} className="text-[#D4AF37] fill-[#D4AF37]" />
              <p className="text-[#D4AF37] text-xs font-bold">{blackLabels.length} Black Label{blackLabels.length > 1 ? "s" : ""} awarded!</p>
            </div>
            {blackLabels.map(c => <p key={c.certId} className="text-[#CCCCCC] text-xs mt-1 ml-6">{c.certId} — {c.cardName}</p>)}
          </div>
        )}

        <button
          type="button" onClick={onClose}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase py-3 rounded-lg hover:opacity-90"
        >
          Close
        </button>
      </div>
    </div>
  );
}
