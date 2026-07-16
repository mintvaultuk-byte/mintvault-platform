/**
 * AI Card Identification panel — embedded in the grading/certificate form.
 *
 * The grader presses Identify Card (explicit — never automatic), the server runs
 * the staged pipeline, and validated suggestions come back with confidence bands
 * + evidence. NOTHING is applied automatically: the grader chooses Accept All /
 * Accept Selected / Change / Reject. Existing form values require confirmation
 * before replacement. The manual form stays fully usable regardless.
 */
import { useMemo, useState } from "react";
import { buildAcceptRows, acceptAllKeys as computeAcceptAllKeys, defaultSelected, fieldsToApply } from "@shared/card-identification-accept";

type Band = "high" | "medium" | "low" | "conflict" | "unknown";
interface Evidence {
  kind: string;
  summary: string;
}
interface SuggestedField<T> {
  value: T | null;
  confidence: Band;
  source: string;
  evidence: Evidence[];
  validationStatus: string;
  canonicalAlternative?: T | null;
  finishConfirmation?: string;
}
interface Suggestion {
  requestId: string;
  provider: string;
  model: string;
  overallConfidence: Band;
  needsHumanReview: boolean;
  warnings: string[];
  evidence: Evidence[];
  knowledgeValidation: { conflicts: string[] };
  alternatives: { setName: string | null; setCode: string | null; reason: string }[];
  [k: string]: unknown;
}

const LABELS: Record<string, string> = {
  cardName: "Card name",
  setName: "Set",
  cardNumber: "Collector number",
  year: "Year",
  language: "Language",
  era: "Era",
  rarityCode: "Rarity",
  finishVariant: "Finish",
  promoType: "Promo",
  subsetName: "Subset",
};

const bandChip = (b: Band) => {
  const map: Record<Band, string> = {
    high: "bg-emerald-500/15 text-emerald-300",
    medium: "bg-amber-500/15 text-amber-300",
    low: "bg-slate-500/20 text-slate-300",
    conflict: "bg-red-500/20 text-red-300",
    unknown: "bg-slate-700 text-slate-400",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${map[b]}`}>{b}</span>;
};

const PROGRESS = ["Checking Images…", "Reading Card…", "Matching Set…", "Checking Rarity…"];

export function CardIdentifyPanel({
  apiBase,
  certId,
  frontImage,
  backImage,
  frontImageKey,
  backImageKey,
  currentValues,
  onAccept,
  quickMode: quickModeProp,
}: {
  apiBase: "/api/admin" | "/api/staff";
  certId?: string | null;
  frontImage?: File | null;
  backImage?: File | null;
  frontImageKey?: string | null;
  backImageKey?: string | null;
  currentValues: Record<string, string>;
  onAccept: (fields: Record<string, string>) => void;
  quickMode?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "working" | "ready" | "error" | "unavailable">("idle");
  const [progressStep, setProgressStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [quickMode, setQuickMode] = useState(Boolean(quickModeProp));

  const fileToBase64 = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(f);
    });

  const applicableRows = useMemo(
    () => (suggestion ? buildAcceptRows(suggestion as unknown as Parameters<typeof buildAcceptRows>[0], currentValues) : []),
    [suggestion, currentValues],
  );

  async function identify() {
    setStatus("working");
    setError(null);
    setSuggestion(null);
    setProgressStep(0);
    const ticker = setInterval(() => setProgressStep((s) => Math.min(s + 1, PROGRESS.length - 1)), 700);
    try {
      const body: Record<string, unknown> = { idempotencyKey: `${certId ?? "new"}:${Date.now()}:${Math.round(Math.random() * 1e6)}`, certId: certId ?? null };
      if (frontImage) body.frontImageBase64 = await fileToBase64(frontImage);
      else if (frontImageKey) body.frontImageKey = frontImageKey;
      if (backImage) body.backImageBase64 = await fileToBase64(backImage);
      else if (backImageKey) body.backImageKey = backImageKey;

      const res = await fetch(`${apiBase}/card-identification`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      clearInterval(ticker);
      if (res.status === 503) {
        setStatus("unavailable");
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Identification failed.");
        setStatus("error");
        return;
      }
      const sug = data.suggestion as Suggestion;
      setSuggestion(sug);
      // Default-select: validated, non-conflict, non-low, non-overwriting fields.
      setSelected(defaultSelected(buildAcceptRows(sug as unknown as Parameters<typeof buildAcceptRows>[0], currentValues)));
      setStatus("ready");
    } catch {
      clearInterval(ticker);
      setError("Identification failed. Please try again or enter manually.");
      setStatus("error");
    }
  }

  function postCorrections(applied: Set<string>) {
    if (!suggestion) return;
    const corrections = applicableRows.map((r) => ({
      requestId: suggestion.requestId,
      field: r.formKey,
      suggestedValue: r.suggestedForm.slice(0, 80),
      decision: applied.has(r.formKey) ? "accepted" : "rejected",
      correctedValue: null,
      confidenceBand: r.confidence,
      setKey: null,
      era: (suggestion.era as SuggestedField<string> | undefined)?.value ?? null,
      language: (suggestion.language as SuggestedField<string> | undefined)?.value ?? null,
      provider: suggestion.provider,
      model: suggestion.model,
    }));
    void fetch(`${apiBase}/card-identification/corrections`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ corrections }),
    }).catch(() => {});
  }

  function applyFields(keys: string[]) {
    onAccept(fieldsToApply(applicableRows, keys)); // parent copies into the draft form — never saves
    postCorrections(new Set(keys));
    setStatus("idle");
    setSuggestion(null);
  }

  const hasConflict = suggestion ? applicableRows.some((r) => r.isConflict) || suggestion.knowledgeValidation.conflicts.length > 0 : false;
  const acceptAllKeys = computeAcceptAllKeys(applicableRows);

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-4" data-testid="card-identify-panel">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-slate-100">AI Card Identification</div>
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          <input type="checkbox" checked={quickMode} onChange={(e) => setQuickMode(e.target.checked)} data-testid="quick-mode-toggle" /> Quick Grade mode
        </label>
      </div>

      {(frontImage || frontImageKey) ? (
        <div className="text-[11px] text-slate-400">Front image ready{backImage || backImageKey ? " · back image ready" : " · no back image"}.</div>
      ) : (
        <div className="text-[11px] text-amber-300/90">Upload or select a front image, then press Identify.</div>
      )}

      <button
        type="button"
        onClick={identify}
        disabled={status === "working" || (!frontImage && !frontImageKey)}
        data-testid="identify-button"
        className="rounded-lg border border-amber-600 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
      >
        {status === "working" ? PROGRESS[progressStep] : status === "ready" ? "Identify Again — may use another credit" : "Identify Card"}
      </button>

      {status === "unavailable" && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2 text-[11px] text-slate-300" data-testid="identify-unavailable">
          AI Identification unavailable — use manual entry.
        </div>
      )}
      {status === "error" && <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-2 text-[11px] text-red-300">{error}</div>}

      {status === "ready" && suggestion && (
        <div className="space-y-2" data-testid="identify-results">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-100">
            Card detected {bandChip(suggestion.overallConfidence)}
          </div>
          {suggestion.warnings.map((w, i) => (
            <div key={i} className="text-[11px] text-amber-300/90">⚠️ {w}</div>
          ))}
          {hasConflict && (
            <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-2 text-[11px] text-red-300" data-testid="identify-conflict">
              Conflicting evidence — review the flagged fields. "Accept All" excludes conflicting and overwriting fields.
            </div>
          )}

          <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {applicableRows
              .filter((r) => !quickMode || ["setName", "cardNumber", "rarityCode", "finishVariant", "language"].includes(r.formKey))
              .map((r) => (
                <label key={r.formKey} className="flex items-start gap-2 p-2 text-[11px]" data-testid={`identify-row-${r.formKey}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(selected[r.formKey])}
                    onChange={(e) => setSelected((s) => ({ ...s, [r.formKey]: e.target.checked }))}
                    data-testid={`identify-check-${r.formKey}`}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-300">{LABELS[r.formKey] ?? r.formKey}:</span>
                      <span className="text-slate-100">{r.suggestedForm}</span>
                      {bandChip(r.confidence as Band)}
                      {r.finishConfirmation === "requires_physical_inspection" && (
                        <span className="rounded bg-slate-800 px-1 text-[9px] text-slate-400">needs physical check</span>
                      )}
                    </div>
                    {r.wouldOverwrite && (
                      <div className="text-amber-300/90">
                        Replaces current value "{r.current}" — tick to confirm replacement.
                      </div>
                    )}
                    {r.isConflict && r.canonicalAlternative != null && (
                      <div className="text-red-300">Knowledge Engine suggests: {r.canonicalAlternative}</div>
                    )}
                    {r.evidence && <div className="text-slate-500">{r.evidence}</div>}
                  </div>
                </label>
              ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyFields(acceptAllKeys)}
              disabled={acceptAllKeys.length === 0}
              data-testid="accept-all"
              className="rounded-lg border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              Accept All ({acceptAllKeys.length})
            </button>
            <button
              type="button"
              onClick={() => applyFields(Object.keys(selected).filter((k) => selected[k]))}
              data-testid="accept-selected"
              className="rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-400"
            >
              Accept Selected
            </button>
            <button
              type="button"
              onClick={() => {
                postCorrections(new Set());
                setStatus("idle");
                setSuggestion(null);
              }}
              data-testid="reject-suggestions"
              className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Reject Suggestions
            </button>
          </div>
          <div className="text-[10px] text-slate-500">
            Suggestions only — accepting copies values into the draft form. Nothing is saved, graded or submitted automatically.
          </div>
        </div>
      )}
    </div>
  );
}
