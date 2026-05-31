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
        <FileText size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Grading Notes</h3>
      </div>

      <div>
        <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">
          Grade Explanation <span className="text-[var(--admin-green)]">(public — shown on DGR)</span>
        </label>
        <textarea
          value={gradeExplanation}
          onChange={(e) => onChange("gradeExplanation", e.target.value)}
          placeholder="Explain the grade — what's notable about this card's condition? e.g. Outstanding condition with a faint print line on the holographic area preventing a higher grade."
          rows={4}
          className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-3 py-2 placeholder-[var(--admin-ink-faint)] resize-none"
        />
      </div>

      <div>
        <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">
          Private Notes <span className="text-[var(--admin-ink-dim)]">(internal only — not shown to customer)</span>
        </label>
        <textarea
          value={privateNotes}
          onChange={(e) => onChange("privateNotes", e.target.value)}
          placeholder="Internal notes — submission context, customer comments, handling instructions, etc."
          rows={3}
          className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-3 py-2 placeholder-[var(--admin-ink-faint)] resize-none"
        />
      </div>
    </div>
  );
}
