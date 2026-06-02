/**
 * /admin/mvgs-calibration — Grading Calibration admin panel (Phase 3 Step 1).
 *
 * Edits the three "[CALIBRATE]" thresholds from MVGS-v2-spec.md §3 + §6.
 * Engine (shared/mvgs-scoring.ts) is unchanged — this page only writes the
 * pipeline_settings row keyed "mvgs.calibration", which the engine reads via
 * loadMvgsCalibration() at request time.
 *
 * Two states (spec §6):
 *   - Calibration mode (locked: false) — every value editable with min/max
 *     guards mirrored from the server-side ranges. Save persists; lock
 *     publishes.
 *   - Locked + published (locked: true) — values read-only; unlock requires
 *     an explicit confirm modal ("This modifies the published MVGS standard").
 *
 * No scoring change. No engine code touched. All persistence flows through
 * the four existing /api/admin/mvgs/calibration routes.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Lock, Unlock, RotateCcw, Save, CheckCircle2, AlertTriangle } from "lucide-react";
import { AdminButton, Panel, Chip } from "@/components/admin";

// ── Types — mirror server shape exactly ─────────────────────────────────────

interface Calibration {
  edgeAffectedPct: number;
  minorVisibleSplitPct: number;
  darkBorderMultiplier: number;
  creaseMinorMaxPct: number;
  creaseHalfMaxPct: number;
  creaseThreeQuarterMaxPct: number;
  locked: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

interface CalibrationApi {
  calibration: Calibration;
  defaults: Omit<Calibration, "locked" | "updatedAt" | "updatedBy">;
  ranges: Record<keyof Omit<Calibration, "locked" | "updatedAt" | "updatedBy">, { min: number; max: number }>;
}

type FieldKey = keyof Omit<Calibration, "locked" | "updatedAt" | "updatedBy">;

const FIELD_META: Array<{
  key: FieldKey;
  label: string;
  unit: "%" | "×";
  step: number;
  description: string;
}> = [
  {
    key: "edgeAffectedPct",
    label: "Edge-affected threshold",
    unit: "%",
    step: 0.5,
    description:
      "Whitening must cover at least this much of an edge's length for the edge to count as 'affected' on the §3 ladder.",
  },
  {
    key: "minorVisibleSplitPct",
    label: "Minor ↔ visible split",
    unit: "%",
    step: 0.5,
    description: "Whitening coverage above this percentage is classed 'visible' (the higher tier); below is 'minor'.",
  },
  {
    key: "darkBorderMultiplier",
    label: "Dark-border WH multiplier",
    unit: "×",
    step: 0.05,
    description:
      "Coverage on a dark-bordered edge is multiplied by this before reading the ladder (whitening reads worse on dark borders).",
  },
  {
    key: "creaseMinorMaxPct",
    label: "Crease minor max",
    unit: "%",
    step: 1,
    description: "Upper bound of the 'minor crease' bracket (cap 4.5). Strictly less than the half-across cutoff.",
  },
  {
    key: "creaseHalfMaxPct",
    label: "Crease half-across max",
    unit: "%",
    step: 1,
    description: "Upper bound of the 'half across' bracket (cap 4). Must sit between minor and three-quarter.",
  },
  {
    key: "creaseThreeQuarterMaxPct",
    label: "Crease three-quarter max",
    unit: "%",
    step: 1,
    description: "Upper bound of the 'three-quarters across' bracket (cap 3.5). Above this → cap 3.",
  },
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function AdminMvgsCalibrationPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<CalibrationApi>({
    queryKey: ["/api/admin/mvgs/calibration"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/mvgs/calibration");
      return r.json();
    },
    staleTime: 30_000,
  });

  // Working copy — separated from the persisted state so the operator can
  // tweak multiple fields, see the dirty marker, and Save once. Resets on
  // every server refresh so an external lock/unlock can't strand stale edits.
  const [draft, setDraft] = useState<Partial<Record<FieldKey, number>>>({});
  const [confirm, setConfirm] = useState<null | { kind: "lock" | "unlock" }>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft({});
  }, [data?.calibration]);

  const cal = data?.calibration;
  const locked = !!cal?.locked;

  // Current effective value = draft override OR persisted value.
  const effective = useMemo(() => {
    if (!cal) return {} as Record<FieldKey, number>;
    return Object.fromEntries(FIELD_META.map((f) => [f.key, draft[f.key] ?? cal[f.key]])) as Record<FieldKey, number>;
  }, [cal, draft]);

  const dirty = Object.keys(draft).length > 0;

  // Ordering validation (mirrored from server; live UI hint).
  const orderingError = useMemo(() => {
    if (!cal) return null;
    if (!(effective.creaseMinorMaxPct < effective.creaseHalfMaxPct)) {
      return `Crease minor max (${effective.creaseMinorMaxPct}) must be < half-across max (${effective.creaseHalfMaxPct}).`;
    }
    if (!(effective.creaseHalfMaxPct < effective.creaseThreeQuarterMaxPct)) {
      return `Crease half-across max (${effective.creaseHalfMaxPct}) must be < three-quarter max (${effective.creaseThreeQuarterMaxPct}).`;
    }
    return null;
  }, [cal, effective]);

  const patchMutation = useMutation({
    mutationFn: async (values: Partial<Record<FieldKey, number>>) => {
      const r = await apiRequest("PATCH", "/api/admin/mvgs/calibration", { values });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mvgs/calibration"] });
    },
    onError: (e: Error) => setSaveError(e.message),
  });

  const lockMutation = useMutation({
    mutationFn: async (kind: "lock" | "unlock") => {
      const r = await apiRequest("POST", `/api/admin/mvgs/calibration/${kind}`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setConfirm(null);
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mvgs/calibration"] });
    },
    onError: (e: Error) => setSaveError(e.message),
  });

  if (isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-[var(--admin-ink-dim)]">
        <Loader2 className="animate-spin" size={16} /> Loading calibration…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 text-[var(--admin-red)] text-sm">
        Failed to load calibration: {(error as Error)?.message ?? "unknown error"}
      </div>
    );
  }

  function setField(key: FieldKey, value: number) {
    const range = data!.ranges[key];
    const clamped = Math.max(range.min, Math.min(range.max, value));
    setDraft((d) => ({ ...d, [key]: clamped }));
  }

  function resetField(key: FieldKey) {
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  }

  function resetFieldToDefault(key: FieldKey) {
    setDraft((d) => ({ ...d, [key]: data!.defaults[key] }));
  }

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[var(--admin-ink)]">Grading Calibration</h1>
          <p className="text-[var(--admin-ink-dim)] text-sm mt-1 max-w-xl">
            The three <code className="text-[var(--admin-gold)]">[CALIBRATE]</code> values from MVGS-v2-spec.md §3 + §6.
            Tune against your own cards; lock to publish. The locked values become the published MVGS standard — change
            is a deliberate v2.x decision, not a casual nudge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {locked ? (
            <Chip>
              <Lock size={12} /> Locked &amp; published
            </Chip>
          ) : (
            <Chip>
              <Unlock size={12} /> Calibration mode
            </Chip>
          )}
        </div>
      </header>

      {/* Audit row */}
      {(cal?.updatedAt || cal?.updatedBy) && (
        <p className="text-[var(--admin-ink-faint)] text-[11px] font-mono">
          last edited{cal?.updatedAt ? ` ${new Date(cal.updatedAt).toLocaleString()}` : ""}
          {cal?.updatedBy ? ` by ${cal.updatedBy}` : ""}
        </p>
      )}

      <Panel
        title="Thresholds"
        sub={locked ? "Read-only. Unlock to edit." : "Adjust below. Save persists; Lock publishes."}
      >
        <div className="space-y-5">
          {FIELD_META.map((f) => {
            const range = data.ranges[f.key];
            const defaultValue = data.defaults[f.key];
            const value = effective[f.key];
            const isDirty = draft[f.key] !== undefined && draft[f.key] !== cal![f.key];
            const isDefault = value === defaultValue;
            return (
              <div key={f.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <label htmlFor={`input-${f.key}`} className="text-[var(--admin-ink)] text-sm font-bold">
                    {f.label}
                  </label>
                  <div className="flex items-center gap-2 text-[10px] text-[var(--admin-ink-faint)] font-mono">
                    <span>
                      range {range.min}–{range.max}
                      {f.unit}
                    </span>
                    <span>·</span>
                    <span>
                      default {defaultValue}
                      {f.unit}
                    </span>
                    {isDirty && <span className="text-[var(--admin-amber)] font-bold">· edited</span>}
                    {isDefault && !isDirty && <span className="text-[var(--admin-green)]">· at default</span>}
                  </div>
                </div>
                <p className="text-[var(--admin-ink-dim)] text-[11px] leading-snug">{f.description}</p>
                <div className="flex items-center gap-2">
                  <input
                    id={`input-${f.key}`}
                    type="number"
                    min={range.min}
                    max={range.max}
                    step={f.step}
                    value={value}
                    disabled={locked}
                    onChange={(e) => setField(f.key, Number(e.target.value))}
                    className="w-32 px-2 py-1 text-sm font-mono bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded text-[var(--admin-ink)] disabled:opacity-60 disabled:cursor-not-allowed"
                    data-testid={`input-${f.key}`}
                  />
                  <span className="text-[var(--admin-ink-dim)] text-sm">{f.unit}</span>
                  {!locked && !isDefault && (
                    <button
                      type="button"
                      onClick={() => resetFieldToDefault(f.key)}
                      className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold)] text-[10px] uppercase tracking-widest underline-offset-2 hover:underline"
                      data-testid={`btn-reset-${f.key}`}
                    >
                      Reset to default
                    </button>
                  )}
                  {!locked && isDirty && (
                    <button
                      type="button"
                      onClick={() => resetField(f.key)}
                      className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-amber)] text-[10px] uppercase tracking-widest"
                    >
                      Discard edit
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Live validation hint */}
      {orderingError && (
        <div className="flex items-start gap-2 bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[var(--admin-red)] rounded p-3">
          <AlertTriangle size={14} className="text-[var(--admin-red)] flex-shrink-0 mt-0.5" />
          <p className="text-[var(--admin-red)] text-xs">{orderingError}</p>
        </div>
      )}
      {saveError && (
        <div className="flex items-start gap-2 bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[var(--admin-red)] rounded p-3">
          <AlertTriangle size={14} className="text-[var(--admin-red)] flex-shrink-0 mt-0.5" />
          <p className="text-[var(--admin-red)] text-xs font-mono">{saveError}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {!locked && (
            <>
              <AdminButton
                variant="gold"
                size="md"
                disabled={!dirty || !!orderingError || patchMutation.isPending}
                onClick={() => patchMutation.mutate(draft)}
                data-testid="btn-save-calibration"
              >
                {patchMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save changes
              </AdminButton>
              {dirty && (
                <button
                  type="button"
                  onClick={() => setDraft({})}
                  className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-xs uppercase tracking-widest"
                >
                  <RotateCcw size={12} className="inline mr-1" />
                  Discard all
                </button>
              )}
              {patchMutation.isSuccess && !dirty && (
                <span className="text-[var(--admin-green)] text-xs flex items-center gap-1">
                  <CheckCircle2 size={12} /> Saved
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {locked ? (
            <AdminButton
              variant="ghost"
              size="md"
              onClick={() => setConfirm({ kind: "unlock" })}
              disabled={lockMutation.isPending}
              data-testid="btn-unlock-calibration"
            >
              <Unlock size={14} /> Unlock to edit
            </AdminButton>
          ) : (
            <AdminButton
              variant="gold"
              size="md"
              onClick={() => setConfirm({ kind: "lock" })}
              disabled={dirty || !!orderingError || lockMutation.isPending}
              title={dirty ? "Save or discard pending edits before locking" : undefined}
              data-testid="btn-lock-calibration"
            >
              <Lock size={14} /> Lock &amp; publish
            </AdminButton>
          )}
        </div>
      </div>

      {/* Confirm modal — lock + unlock both go through this single component */}
      {confirm && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4"
          onClick={() => setConfirm(null)}
        >
          <div
            className="bg-[var(--admin-panel)] border border-[var(--admin-line-hard)] rounded-xl p-6 max-w-md w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
              {confirm.kind === "lock" ? "Lock & Publish" : "Unlock to Edit"}
            </p>
            <p className="text-[var(--admin-ink)] text-sm">
              {confirm.kind === "lock"
                ? "Lock the current values as the published MVGS standard. The engine will use these for every grade until you explicitly unlock. Continue?"
                : "Unlocking modifies the published MVGS standard. Subsequent edits will change how cards score. Continue?"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-xs uppercase tracking-widest text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)]"
                data-testid="btn-cancel-confirm"
              >
                Cancel
              </button>
              <AdminButton
                variant="gold"
                size="md"
                onClick={() => lockMutation.mutate(confirm.kind)}
                disabled={lockMutation.isPending}
                data-testid={`btn-confirm-${confirm.kind}`}
              >
                {lockMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : confirm.kind === "lock" ? (
                  <Lock size={14} />
                ) : (
                  <Unlock size={14} />
                )}
                {confirm.kind === "lock" ? "Lock & Publish" : "Unlock"}
              </AdminButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
