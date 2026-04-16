import { Shield } from "lucide-react";

export type AuthStatus = "genuine" | "authentic_altered" | "not_original" | "uncertain";

interface Props {
  status: AuthStatus;
  notes: string;
  onChange: (status: AuthStatus, notes: string) => void;
}

const OPTIONS: { value: AuthStatus; label: string; sub: string }[] = [
  { value: "genuine",            label: "Genuine",              sub: "Card is authentic and unaltered" },
  { value: "authentic_altered",  label: "Authentic Altered (AA)", sub: "Genuine card that has been trimmed, recoloured, or otherwise modified" },
  { value: "not_original",       label: "Not Original (NO)",    sub: "Counterfeit, reproduction, or proxy" },
  { value: "uncertain",          label: "Uncertain",            sub: "Requires further examination" },
];

export default function Authentication({ status, notes, onChange }: Props) {
  const isNonStandard = status === "authentic_altered" || status === "not_original";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-[#D4AF37]" />
        <h3 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Authentication</h3>
      </div>

      <div className="space-y-2">
        {OPTIONS.map(opt => (
          <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer group">
            <input
              type="radio"
              name="auth_status"
              value={opt.value}
              checked={status === opt.value}
              onChange={() => onChange(opt.value, notes)}
              className="mt-0.5 accent-[#D4AF37]"
            />
            <div>
              <p className={`text-xs font-medium transition-colors ${status === opt.value ? "text-[#D4AF37]" : "text-[#AAAAAA] group-hover:text-[#3A3A3A]"}`}>
                {opt.label}
              </p>
              <p className="text-[9px] text-[#888888]">{opt.sub}</p>
            </div>
          </label>
        ))}
      </div>

      {isNonStandard && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          <Shield size={12} className="text-amber-600 flex-shrink-0" />
          <p className="text-amber-600 text-xs">
            This card will be graded as <strong>{status === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}</strong> — no numerical grade will be assigned.
          </p>
        </div>
      )}

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Authentication Notes</label>
        <textarea
          value={notes}
          onChange={e => onChange(status, e.target.value)}
          placeholder="Note any authentication observations — card stock, print quality, holo pattern, etc."
          rows={3}
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-3 py-2 placeholder-[#AAAAAA] resize-none"
        />
        <p className="text-[#888888] text-[9px] mt-1">These notes appear on the public Digital Grading Report.</p>
      </div>
    </div>
  );
}
