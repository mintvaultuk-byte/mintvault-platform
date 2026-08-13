import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GradingWorkstation } from "@/components/grading-workflow/GradingWorkstation";

type GradingCard = {
  certId: number;
  certIdStr: string;
  cardGame: string | null;
  setName: string | null;
  cardName: string | null;
  cardNumber: string | null;
  year: string | null;
  language: string | null;
  variant: string | null;
  grade: string | null;
  gradingStatus: string;
  rejectionReason: string | null;
  redoCount: number;
  assignedToMe: boolean;
  gradedByMe: boolean;
};
type QueueItem = { submissionId: number; submissionRef: string; serviceTier: string | null; cards: GradingCard[] };

type CaptureStation = { stationCode: string; locationId: string; locationName: string };
type CaptureSide = "front" | "back";
type CaptureSession = {
  id: string;
  side: CaptureSide;
  state: "armed" | "claimed" | "capturing" | "captured" | "failed" | "expired" | "cancelled";
  failureReason: string | null;
  expiresAt: string;
  workstationId: string;
};

/**
 * Partner capture is an adapter over the same target-bound signed-station
 * lifecycle as HQ. The browser may pick only a server-listed, calibrated
 * station in its own location; it never supplies a certificate target to the
 * scanner or a free-form workstation/device identity.
 */
function PartnerCaptureControls({ certId }: { certId: number }) {
  const [stations, setStations] = useState<CaptureStation[]>([]);
  const [stationCode, setStationCode] = useState("");
  const [sessions, setSessions] = useState<Partial<Record<CaptureSide, CaptureSession>>>({});
  const [arming, setArming] = useState<CaptureSide | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/partner/stations/capture-ready", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (!response.ok) {
        setMessage(data?.error?.message || data?.error || "Approved stations are unavailable.");
        return;
      }
      const ready = Array.isArray(data.stations) ? (data.stations as CaptureStation[]) : [];
      setStations(ready);
      setStationCode((current) => current || ready[0]?.stationCode || "");
    })().catch(() => {
      if (!cancelled) setMessage("Approved stations are unavailable.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const active = Object.values(sessions).filter(
      (session): session is CaptureSession => !!session && ["armed", "claimed", "capturing"].includes(session.state)
    );
    if (!active.length) return;
    let cancelled = false;
    const poll = async () => {
      for (const session of active) {
        const response = await fetch(`/api/partner/stations/capture-sessions/${session.id}`, {
          credentials: "include",
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled || !response.ok || !data.capture?.side) continue;
        setSessions((current) => ({ ...current, [data.capture.side]: data.capture as CaptureSession }));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessions]);

  async function arm(side: CaptureSide) {
    if (!stationCode) {
      setMessage("Choose an approved station before arming this card side.");
      return;
    }
    setArming(side);
    setMessage(null);
    try {
      const response = await fetch(`/api/partner/stations/${encodeURIComponent(stationCode)}/capture-sessions`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ certificateId: certId, side }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || data?.error || "Unable to arm scanner capture.");
      setSessions((current) => ({ ...current, [side]: data.capture as CaptureSession }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to arm scanner capture.");
    } finally {
      setArming(null);
    }
  }

  const frontCaptured = sessions.front?.state === "captured";
  const backCaptured = sessions.back?.state === "captured";
  const active = (side: CaptureSide) => ["armed", "claimed", "capturing"].includes(sessions[side]?.state || "");

  return (
    <section className="border-t border-[var(--admin-line)] px-3 py-2 space-y-2" data-testid="partner-station-capture">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--admin-ink-dim)]">Station capture</p>
      {stations.length > 0 ? (
        <select
          aria-label="Approved capture station"
          value={stationCode}
          onChange={(event) => setStationCode(event.target.value)}
          disabled={active("front") || active("back")}
          className="max-w-sm rounded border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1 text-xs"
        >
          {stations.map((station) => (
            <option key={station.stationCode} value={station.stationCode}>
              {station.locationName} — {station.stationCode}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-xs text-[var(--admin-ink-dim)]">
          No approved, calibrated station is available for your location.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!stationCode || !!arming || active("front") || frontCaptured}
          onClick={() => void arm("front")}
        >
          {frontCaptured ? "Front captured" : active("front") ? `Front ${sessions.front?.state}` : "Arm front"}
        </Button>
        <Button
          size="sm"
          disabled={!stationCode || !frontCaptured || !!arming || active("back") || backCaptured}
          onClick={() => void arm("back")}
        >
          {backCaptured ? "Back captured" : active("back") ? `Back ${sessions.back?.state}` : "Arm back"}
        </Button>
        {frontCaptured && backCaptured ? <Badge>Capture complete</Badge> : null}
      </div>
      {message ? <p className="text-xs text-red-500">{message}</p> : null}
      {sessions.front?.failureReason || sessions.back?.failureReason ? (
        <p className="text-xs text-red-500">{sessions.front?.failureReason || sessions.back?.failureReason}</p>
      ) : null}
    </section>
  );
}

export default function PartnerGradingPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [active, setActive] = useState<{ item: QueueItem; card: GradingCard } | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/partner/grading/queue", { credentials: "include" });
    if (res.ok) setQueue((await res.json()).items ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/partner/grading/session", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      setAuthed(!!data.authenticated);
      if (data.authenticated) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  if (active) {
    const card = active.card;
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-[var(--admin-bg)] text-[var(--admin-ink)]">
        <header className="shrink-0 border-b border-[var(--admin-line)] px-3 py-2">
          <button
            type="button"
            onClick={() => setActive(null)}
            className="text-[var(--admin-gold)] text-xs hover:underline"
          >
            Back to partner grading
          </button>
        </header>
        <PartnerCaptureControls certId={card.certId} />
        <GradingWorkstation
          mode="partner"
          apiBase="/api/partner/grading"
          graderMode
          graderEdit={card.gradingStatus === "pending_review"}
          serviceTier={active.item.serviceTier}
          certId={card.certId}
          certIdStr={card.certIdStr}
          cardName={card.cardName || ""}
          cardSet={card.setName || ""}
          cardNumber={card.cardNumber}
          cardYear={card.year}
          cardLanguage={card.language}
          cardVariant={card.variant}
          cardGame={card.cardGame || undefined}
          existingGrade={card.grade}
          onGradeApproved={async () => {
            await refresh();
            setActive(null);
          }}
          onCertUpdated={() => {}}
        />
      </div>
    );
  }

  if (authed === false) {
    return (
      <Card data-testid="partner-grading-signin">
        <CardHeader>
          <CardTitle>MVGS grading workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">You do not have access to assigned partner grading cards.</p>
        </CardContent>
      </Card>
    );
  }

  const cards = queue.flatMap((item) => item.cards.map((card) => ({ item, card })));

  return (
    <div className="space-y-6" data-testid="partner-grading-page">
      <div>
        <h1 className="text-2xl font-bold">MVGS grading workspace</h1>
        <p className="text-sm text-muted-foreground">Assigned cards only.</p>
      </div>
      <div className="grid gap-3">
        {cards.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">No cards assigned for grading.</CardContent>
          </Card>
        ) : (
          cards.map(({ item, card }) => {
            const canGrade = card.gradingStatus === "assigned" && card.assignedToMe;
            const canEditSubmitted = card.gradingStatus === "pending_review" && card.gradedByMe;
            const canOpen = canGrade || canEditSubmitted;
            return (
              <Card key={card.certId} data-testid={`partner-grade-card-${card.certId}`}>
                <CardContent className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-muted-foreground">{item.submissionRef}</p>
                    <p className="font-semibold truncate">{card.cardName || "Unidentified card"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[card.setName, card.cardNumber, card.variant].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{card.gradingStatus.replace("_", " ")}</Badge>
                    <Button disabled={!canOpen} onClick={() => setActive({ item, card })}>
                      {canEditSubmitted ? "Edit" : "Open"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
