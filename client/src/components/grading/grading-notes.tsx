import { FileText } from "lucide-react";

interface Props {
  privateNotes: string;
  gradeExplanation: string;
  onChange: (field: "privateNotes" | "gradeExplanation", val: string) => void;
}

export default function GradingNotes({ privateNotes, gradeExplanation, onChange }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-[#D4AF37]" />
        <h3 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Grading Notes</h3>
      </div>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Grade Explanation <span className="text-emerald-500">(public — shown on DGR)</span></label>
        <textarea
          value={gradeExplanation}
          onChange={e => onChange("gradeExplanation", e.target.value)}
          placeholder="Explain the grade — what's notable about this card's condition? e.g. Outstanding condition with a faint print line on the holographic area preventing a higher grade."
          rows={4}
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-3 py-2 placeholder-[#AAAAAA] resize-none"
        />
      </div>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Private Notes <span className="text-[#888888]">(internal only — not shown to customer)</span></label>
        <textarea
          value={privateNotes}
          onChange={e => onChange("privateNotes", e.target.value)}
          placeholder="Internal notes — submission context, customer comments, handling instructions, etc."
          rows={3}
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-3 py-2 placeholder-[#AAAAAA] resize-none"
        />
      </div>
    </div>
  );
}
