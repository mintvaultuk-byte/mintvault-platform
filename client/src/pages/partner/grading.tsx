import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GradingWorkstation } from "@/components/grading-workflow/GradingWorkstation";
import { usePartnerGradingLease } from "@/hooks/use-partner-grading-lease";

/**
 * ONE QUEUE, TWO LINEAGES.
 *
 * `card_job` is the canonical Partner intake spine (Scanner NEW); `connector` is legacy/imported
 * work. Both open the SAME workstation — there is no second grading UI.
 *
 * `openable` and `heldBy` are DERIVED BY THE SERVER. This page used to compute openability itself as
 * `gradingStatus === "assigned" && assignedToMe`, which is unanswerable for a Card Job: its
 * certificate is `unassigned` until a grader takes the editing lease, so that rule made every
 * Scanner card permanently un-openable. Teaching the browser the second rule as well would have put
 * grading authority in browser state; the server decides and this renders what it is told.
 */
type PartnerLineage = "card_job" | "connector";
type QueueEvidenceSide = {
  state: "admitted" | "missing" | "invalid" | "unavailable";
  label: string;
  thumbnailUrl: string | null;
  reason: string | null;
  recovery: string | null;
};
type QueueEvidence = {
  front: QueueEvidenceSide;
  back: QueueEvidenceSide;
  workflow: "READY_TO_GRADE" | "IN_GRADING" | "INCOMPLETE_EVIDENCE" | "EVIDENCE_ERROR" | "AWAITING_CAPTURE_ACCEPTANCE";
};

type GradingCard = {
  lineage: PartnerLineage;
  cardJobId: string | null;
  cardJobStatus: string | null;
  mvNumber: string | null;
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
  /** Server-derived: may this operator open this card right now? */
  openable: boolean;
  /** Display name of another grader currently holding it, or null. Never an email or a user id. */
  heldBy: string | null;
  /** Complete server-derived evidence projection. The browser never infers it from an image URL. */
  evidence: QueueEvidence;
};
type QueueItem = {
  groupKey: string;
  lineage: PartnerLineage;
  /** Connector lineage only — a walk-in Card Job has no destination submission. */
  submissionId: number | null;
  /** The MV number on Card Job lineage; the submission reference on connector lineage. */
  submissionRef: string | null;
  serviceTier: string | null;
  cards: GradingCard[];
};

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

function QueueEvidenceTile({
  certId,
  side,
  evidence,
}: {
  certId: number;
  side: "front" | "back";
  evidence: QueueEvidenceSide;
}) {
  const accessibleSide = side.toUpperCase();
  return (
    <div
      className="flex min-w-[7.5rem] items-center gap-2 rounded border border-border bg-muted/20 p-2"
      data-testid={`partner-queue-${side}-evidence-${certId}`}
      data-evidence-state={evidence.state}
    >
      {evidence.thumbnailUrl ? (
        <img
          src={evidence.thumbnailUrl}
          alt={`${accessibleSide} evidence thumbnail`}
          className="h-12 w-9 rounded object-contain bg-black"
          loading="lazy"
          data-testid={`partner-queue-${side}-thumbnail-${certId}`}
        />
      ) : (
        <div
          className="flex h-12 w-9 items-center justify-center rounded border border-dashed border-muted-foreground/50 px-1 text-center text-[9px] font-semibold leading-tight text-muted-foreground"
          aria-label={evidence.label}
          data-testid={`partner-queue-${side}-placeholder-${certId}`}
        >
          {evidence.label}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[11px] font-semibold leading-tight">{evidence.label}</p>
        {evidence.state !== "admitted" && evidence.reason ? (
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground">{evidence.reason}</p>
        ) : null}
      </div>
    </div>
  );
}

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

/**
 * ONE OPEN CARD, held under a server lease.
 *
 * Extracted from the page so the lease hook runs unconditionally: a hook called inside `if (active)`
 * would violate the rules of hooks the moment a grader closed a card.
 *
 * CONNECTOR LINEAGE HAS NO LEASE and never did — those cards are bound by the importer's
 * assigned-grader model. `cardJobId` is null for them, the hook stays idle, and the workstation
 * behaves exactly as it always has. Only Card Job lineage is gated.
 */
function PartnerGradingSession({
  item,
  card,
  onClose,
  onFinished,
}: {
  item: QueueItem;
  card: GradingCard;
  onClose: () => void;
  onFinished: () => Promise<void>;
}) {
  const [takeoverReason, setTakeoverReason] = useState("");
  const lease = usePartnerGradingLease(card.cardJobId, {
    displayName: card.cardName,
    enabled: card.lineage === "card_job",
  });

  /*
   * A connector card is editable on the old rules; a Card Job only while its lease is genuinely held.
   *
   * `acquiring` counts as editable ON PURPOSE. `gradingEnabled={false}` UNMOUNTS the grading panel,
   * so treating the brief moment between opening a card and the lease arriving as "not editable"
   * would mount the panel, unmount it and mount it again — discarding whatever the operator had
   * already started typing. Nothing is risked by it: there is no lease yet, so the server refuses
   * every write during that window regardless of what this component believes.
   *
   * The workstation is not a read-only VIEWER when occupied — the panel is hidden and the banner
   * explains why. That is the safe direction, and a genuine read-only projection of somebody else's
   * in-progress card is a larger piece of work than this closeout.
   */
  const editable = card.lineage === "connector" || lease.state === "held" || lease.state === "acquiring";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--admin-bg)] text-[var(--admin-ink)]">
      <header className="shrink-0 border-b border-[var(--admin-line)] px-3 py-2">
        <button type="button" onClick={onClose} className="text-[var(--admin-gold)] text-xs hover:underline">
          Back to partner grading
        </button>
      </header>

      {card.lineage === "card_job" && lease.state !== "held" ? (
        <section
          className="shrink-0 border-b border-[var(--admin-line)] bg-[var(--admin-panel)] px-3 py-2 space-y-2"
          data-testid="partner-lease-banner"
          data-lease-state={lease.state}
        >
          {lease.state === "acquiring" ? (
            <p className="text-xs text-[var(--admin-ink-dim)]">Opening this card for editing…</p>
          ) : lease.state === "occupied" ? (
            <>
              <p className="text-xs text-amber-500">
                {lease.holderDisplay ? `${lease.holderDisplay} is` : "Another grader is"} working on this card. It is
                read-only until they finish.
              </p>
              {/* Taking a card off a colleague is a deliberate, reasoned, audited act — never a
                  side effect of opening it. The server checks the permission; this only asks. */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="Reason for taking over this card"
                  placeholder="Reason for taking over"
                  value={takeoverReason}
                  onChange={(event) => setTakeoverReason(event.target.value)}
                  className="min-w-[16rem] rounded border border-[var(--admin-line)] bg-[var(--admin-bg)] px-2 py-1 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!takeoverReason.trim()}
                  onClick={() => void lease.takeover(takeoverReason.trim())}
                >
                  Take over
                </Button>
              </div>
            </>
          ) : lease.state === "lost" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-red-500">{lease.message ?? "Your editing session has ended."}</p>
              <Button size="sm" onClick={() => void lease.acquire()}>
                Reopen this card
              </Button>
            </div>
          ) : (
            <p className="text-xs text-red-500">{lease.message ?? "This card cannot be opened for editing."}</p>
          )}
        </section>
      ) : null}

      <GradingWorkstation
        mode="partner"
        apiBase="/api/partner/grading"
        /*
         * From origin/main: station capture is now a CAPABILITY SLOT on the canonical workstation
         * rather than a sibling element. Adopted here so the Partner surface keeps using the one
         * unified workstation — the whole point of the slot — instead of forking a second layout.
         */
        scannerControls={<PartnerCaptureControls certId={card.certId} />}
        graderMode
        graderEdit={card.gradingStatus === "pending_review"}
        gradingEnabled={editable}
        serviceTier={item.serviceTier}
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
        /*
         * THE LEASE GENERATION TRAVELS WITH EVERY WRITE.
         *
         * Read at request-build time, not captured: the server refuses a Card Job write that does not
         * present the current generation, and it moves on a takeover or an expiry. Connector cards
         * send nothing, and their guard stays inert.
         */
        writeEnvelope={
          card.lineage === "card_job"
            ? () => (lease.revision === null ? {} : { leaseRevision: lease.revision })
            : undefined
        }
        onGradeApproved={onFinished}
        onCertUpdated={() => {}}
      />
    </div>
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
    return (
      <PartnerGradingSession
        item={active.item}
        card={active.card}
        onClose={() => setActive(null)}
        onFinished={async () => {
          await refresh();
          setActive(null);
        }}
      />
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
            // OPENABILITY COMES FROM THE SERVER. Re-deriving it here is what made every Scanner Card
            // Job un-openable: its certificate is `unassigned` until a grader takes the lease.
            const canEditSubmitted = card.gradingStatus === "pending_review" && card.gradedByMe;
            // Workflow readiness is server-derived from both canonical evidence sides. The raw
            // lifecycle remains a separate hint, never a readiness substitute.
            const lifecycleLabel = (card.lineage === "card_job" ? card.cardJobStatus : card.gradingStatus) ?? "unknown";
            const unavailableAction =
              card.evidence.workflow === "INCOMPLETE_EVIDENCE"
                ? "Capture at approved Scanner"
                : card.evidence.workflow === "EVIDENCE_ERROR"
                  ? "Resolve evidence"
                  : card.evidence.workflow === "AWAITING_CAPTURE_ACCEPTANCE"
                    ? "Awaiting capture acceptance"
                    : card.heldBy
                      ? "Held by another grader"
                      : "Not available";
            return (
              <Card key={card.certId} data-testid={`partner-grade-card-${card.certId}`} data-lineage={card.lineage}>
                <CardContent className="p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-muted-foreground">
                      {item.submissionRef ?? card.mvNumber ?? card.certIdStr}
                    </p>
                    <p className="font-semibold truncate">{card.cardName || "Unidentified card"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[card.setName, card.cardNumber, card.variant].filter(Boolean).join(" · ")}
                    </p>
                    {card.heldBy ? (
                      <p className="text-xs text-amber-500">{card.heldBy} is working on this card</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2" aria-label="Evidence status">
                    <QueueEvidenceTile certId={card.certId} side="front" evidence={card.evidence.front} />
                    <QueueEvidenceTile certId={card.certId} side="back" evidence={card.evidence.back} />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col items-end gap-1">
                      <Badge data-testid={`partner-queue-workflow-${card.certId}`}>
                        {card.evidence.workflow.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{lifecycleLabel.replace(/_/g, " ")}</span>
                    </div>
                    {card.openable ? (
                      <Button onClick={() => setActive({ item, card })}>{canEditSubmitted ? "Edit" : "Open"}</Button>
                    ) : (
                      <span
                        className="max-w-32 text-right text-[10px] text-muted-foreground"
                        data-testid={`partner-queue-unavailable-action-${card.certId}`}
                      >
                        {unavailableAction}
                      </span>
                    )}
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
