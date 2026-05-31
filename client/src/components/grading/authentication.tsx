import { Shield } from "lucide-react";

export type AuthStatus = "genuine" | "authentic_altered" | "not_original" | "uncertain";

interface Props {
  status: AuthStatus;
  notes: string;
  onChange: (status: AuthStatus, notes: string) => void;
}

const OPTIONS: { value: AuthStatus; label: string; sub: string }[] = [
  { value: "genuine", label: "Genuine", sub: "Card is authentic and unaltered" },
  {
    value: "authentic_altered",
    label: "Authentic Altered (AA)",
    sub: "Genuine card that has been trimmed, recoloured, or otherwise modified",
  },
  { value: "not_original", label: "Not Original (NO)", sub: "Counterfeit, reproduction, or proxy" },
  { value: "uncertain", label: "Uncertain", sub: "Requires further examination" },
];

export default function Authentication({ status, notes, onChange }: Props) {
  const isNonStandard = status === "authentic_altered" || status === "not_original";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Authentication</h3>
      </div>

      <div className="space-y-2">
        {OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer group">
            <input
              type="radio"
              name="auth_status"
              value={opt.value}
              checked={status === opt.value}
              onChange={() => onChange(opt.value, notes)}
              className="mt-0.5 accent-[var(--admin-gold)]"
            />
            <div>
              <p
                className={`text-xs font-medium transition-colors ${status === opt.value ? "text-[var(--admin-gold)]" : "text-[var(--admin-ink-faint)] group-hover:text-[var(--admin-ink)]"}`}
              >
                {opt.label}
              </p>
              <p className="text-[9px] text-[var(--admin-ink-dim)]">{opt.sub}</p>
            </div>
          </label>
        ))}
      </div>

      {isNonStandard && (
        <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)] rounded px-3 py-2">
          <Shield size={12} className="text-[var(--admin-amber)] flex-shrink-0" />
          <p className="text-[var(--admin-amber)] text-xs">
            This card will be graded as{" "}
            <strong>{status === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}</strong> — no numerical
            grade will be assigned.
          </p>
        </div>
      )}

      <div>
        <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">Authentication Notes</label>
        <textarea
          value={notes}
          onChange={(e) => onChange(status, e.target.value)}
          placeholder="Note any authentication observations — card stock, print quality, holo pattern, etc."
          rows={3}
          className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-3 py-2 placeholder-[var(--admin-ink-faint)] resize-none"
        />
        <p className="text-[var(--admin-ink-dim)] text-[9px] mt-1">
          These notes appear on the public Digital Grading Report.
        </p>
      </div>
    </div>
  );
}
