import { adminFetch } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { Camera, CheckCircle2, Loader2, ScanLine, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  certId: number;
  onComplete: () => void;
  /** Must be an explicit Card Details recovery action; creates a ledger revision. */
  recapture?: boolean;
}

type CaptureSide = "front" | "back";
type CaptureSession = {
  id: string;
  side: CaptureSide;
  state: "armed" | "claimed" | "capturing" | "captured" | "failed" | "expired" | "cancelled";
  workstationId: string;
  failureReason?: string | null;
  expiresAt?: string;
};

const WORKSTATION_KEY = "mintvault-scanner-workstation-id";

function savedWorkstationId() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(WORKSTATION_KEY)?.trim() || "";
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CaptureWizard({ certId, onComplete, recapture = false }: Props) {
  const { toast } = useToast();
  const [workstationId, setWorkstationId] = useState(savedWorkstationId);
  const [sessions, setSessions] = useState<Partial<Record<CaptureSide, CaptureSession>>>({});
  const [armingSide, setArmingSide] = useState<CaptureSide | null>(null);

  useEffect(() => {
    const active = (Object.values(sessions) as CaptureSession[]).filter((session) =>
      ["armed", "claimed", "capturing"].includes(session.state)
    );
    if (!active.length) return;
    const poll = async () => {
      for (const session of active) {
        try {
          const response = await adminFetch(`/api/admin/certificates/${certId}/scanner-capture-sessions/${session.id}`, {
            credentials: "include",
          });
          if (!response.ok) continue;
          const { capture } = await response.json();
          if (!capture?.side || !capture?.state) continue;
          setSessions((previous) => ({ ...previous, [capture.side]: capture as CaptureSession }));
          if (capture.state === "failed" || capture.state === "expired") {
            toast({
              title: `Scanner ${capture.state}`,
              description: capture.failure_reason || "Arm a new capture only after resolving the station issue.",
              variant: "destructive",
            });
          }
        } catch {
          // Keep the visible armed state; a transient workstation-network loss
          // must not make the operator believe the capture was cancelled.
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => window.clearInterval(timer);
  }, [certId, sessions, toast]);

  useEffect(() => {
    if (sessions.front?.state === "captured" && sessions.back?.state === "captured") {
      onComplete();
    }
  }, [onComplete, sessions.back?.state, sessions.front?.state]);

  async function armScannerCapture(side: CaptureSide) {
    const station = workstationId.trim();
    if (!station) {
      toast({
        title: "Workstation ID required",
        description: "Enter the provisioned station ID once before scanning.",
        variant: "destructive",
      });
      return;
    }
    window.localStorage.setItem(WORKSTATION_KEY, station);
    setArmingSide(side);
    try {
      const response = await adminFetch(`/api/admin/certificates/${certId}/scanner-capture-sessions`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ side, workstation_id: station, recapture }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Unable to arm scanner (${response.status})`);
      setSessions((previous) => ({ ...previous, [side]: data.capture as CaptureSession }));
      toast({
        title: `${side === "front" ? "Front" : "Back"} armed`,
        description: "The station will claim this card-side capture automatically.",
      });
    } catch (error: any) {
      toast({ title: "Scanner not armed", description: error.message, variant: "destructive" });
    } finally {
      setArmingSide(null);
    }
  }

  const frontCaptured = sessions.front?.state === "captured";
  const backCaptured = sessions.back?.state === "captured";
  const activeCapture = (side: CaptureSide) => ["armed", "claimed", "capturing"].includes(sessions[side]?.state || "");

  return (
    <div className="bg-[var(--admin-panel)] border border-[var(--admin-gold)]/20 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <ScanLine size={16} className="text-[var(--admin-gold)]" />
        <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
          {recapture ? "Controlled Canon Recapture" : "Canon LiDE 400 Capture"}
        </p>
      </div>
      <p className="text-[var(--admin-ink-dim)] text-xs mb-5">
        {recapture
          ? "This explicitly supersedes the current selected master after server acceptance. Earlier TIFF evidence remains immutable and auditable."
          : "Arm the selected card side first. The provisioned workstation captures the locked 1200 DPI TIFF profile and binds it to this certificate before upload."}
      </p>

      <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] p-4 mb-5 space-y-4">
        <label className="block text-[10px] uppercase tracking-widest text-[var(--admin-ink-dim)] font-bold">
          Provisioned workstation ID
          <input
            value={workstationId}
            onChange={(event) => setWorkstationId(event.target.value)}
            placeholder="MV-STN-… (provisioned station)"
            className="mt-2 w-full rounded-md border border-[var(--admin-line)] bg-[var(--admin-panel)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--admin-ink)]"
            autoComplete="off"
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void armScannerCapture("front")}
            disabled={!!armingSide || activeCapture("front") || frontCaptured}
            className="min-h-24 rounded-lg border border-[var(--admin-gold)]/40 bg-[var(--admin-gold)]/10 text-[var(--admin-ink)] font-bold text-sm flex flex-col items-center justify-center gap-2 disabled:opacity-50"
          >
            {armingSide === "front" || activeCapture("front") ? (
              <Loader2 className="animate-spin" size={22} />
            ) : frontCaptured ? (
              <CheckCircle2 className="text-[var(--admin-green)]" size={22} />
            ) : (
              <Camera size={22} />
            )}
            {frontCaptured
              ? "FRONT CAPTURED"
              : activeCapture("front")
                ? `FRONT ${sessions.front?.state?.toUpperCase()}`
                : "SCAN FRONT"}
          </button>
          <button
            type="button"
            onClick={() => void armScannerCapture("back")}
            disabled={!frontCaptured || !!armingSide || activeCapture("back") || backCaptured}
            className="min-h-24 rounded-lg border border-[var(--admin-gold)]/40 bg-[var(--admin-gold)]/10 text-[var(--admin-ink)] font-bold text-sm flex flex-col items-center justify-center gap-2 disabled:opacity-50"
          >
            {armingSide === "back" || activeCapture("back") ? (
              <Loader2 className="animate-spin" size={22} />
            ) : backCaptured ? (
              <CheckCircle2 className="text-[var(--admin-green)]" size={22} />
            ) : (
              <RefreshCw size={22} />
            )}
            {backCaptured
              ? "BACK CAPTURED"
              : activeCapture("back")
                ? `BACK ${sessions.back?.state?.toUpperCase()}`
                : "FLIP CARD / SCAN BACK"}
          </button>
        </div>
        {sessions.front?.state === "failed" || sessions.back?.state === "failed" ? (
          <p className="text-xs text-[var(--admin-red)]">
            The station rejected this capture. Resolve the displayed scanner issue, then arm a fresh card-side session.
          </p>
        ) : null}
      </div>

      {frontCaptured && backCaptured ? (
        <div className="mt-5 flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)] rounded-lg px-4 py-3">
          <CheckCircle2 size={16} className="text-[var(--admin-green)] flex-shrink-0" />
          <p className="text-[var(--admin-green)] text-sm">
            Both card sides are captured. The immutable TIFF masters are being processed for grading.
          </p>
        </div>
      ) : null}
    </div>
  );
}
