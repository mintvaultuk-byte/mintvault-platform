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
        <GradingWorkstation
          mode="grader"
          apiBase="/api/partner/grading"
          graderMode
          graderEdit={card.gradingStatus === "pending_review"}
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
