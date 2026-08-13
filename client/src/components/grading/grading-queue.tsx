import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Play, ChevronLeft, ChevronRight, Clock, SquareStack, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import SessionSummary from "./session-summary";

interface QueueItem {
  id: number;
  certId: string;
  cardName: string;
  cardSet: string;
  cardGame: string;
  createdAt: string;
  hasImages: boolean;
  grade: string | null;
}

interface GradedCard {
  certId: string;
  cardName: string;
  grade: number | string;
  durationSeconds: number;
  isBlackLabel?: boolean;
}

interface Props {
  onSelectCert: (id: number) => void;
  currentCertId?: number | null;
  onGradeApproved?: (certId: string, grade: string) => void;
  approvedSignal?: { certId: string; grade: string; ts: number } | null;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function GradingQueue({ onSelectCert, currentCertId, onGradeApproved, approvedSignal }: Props) {
  const { toast } = useToast();
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [cardSeconds, setCardSeconds] = useState(0);
  const [gradedCards, setGradedCards] = useState<GradedCard[]>([]);
  const [showSummary, setShowSummary] = useState(false);

  const { data: queue = [], isLoading } = useQuery<QueueItem[]>({
    queryKey: ["/api/admin/grading-queue"],
    queryFn: async () => {
      const res = await fetch("/api/admin/grading-queue", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: sessionActive ? 15_000 : false,
  });

  // Session timer
  useEffect(() => {
    if (!sessionActive) return;
    const id = setInterval(() => setSessionSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [sessionActive]);

  // Per-card timer
  useEffect(() => {
    if (!sessionActive || !currentCertId) return;
    setCardSeconds(0);
    const id = setInterval(() => setCardSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [currentCertId, sessionActive]);

  // React to external grade-approved signal
  useEffect(() => {
    if (!approvedSignal) return;
    handleGradeApproved(approvedSignal.certId, approvedSignal.grade);
    // eslint-disable-next-line
  }, [approvedSignal?.ts]);

  const currentIdx = queue.findIndex((c) => c.id === currentCertId);

  function startSession() {
    setSessionActive(true);
    setSessionSeconds(0);
    setGradedCards([]);
    if (queue.length > 0) onSelectCert(queue[0].id);
  }

  function goToCard(idx: number) {
    if (idx >= 0 && idx < queue.length) onSelectCert(queue[idx].id);
  }

  function handleGradeApproved(certId: string, grade: string) {
    const gradeNum = parseFloat(grade);
    setGradedCards((prev) => [
      ...prev,
      {
        certId,
        cardName: queue.find((c) => c.certId === certId)?.cardName || certId,
        grade: isNaN(gradeNum) ? grade : gradeNum,
        durationSeconds: cardSeconds,
        // A ten is not automatically Pristine. The server returns that
        // designation through its canonical certificate/report payload.
        isBlackLabel: false,
      },
    ]);
    onGradeApproved?.(certId, grade);
    queryClient.invalidateQueries({ queryKey: ["/api/admin/grading-queue"] });

    // Auto-advance
    setTimeout(() => {
      const remaining = queue.filter((c) => !gradedCards.some((g) => g.certId === c.certId) && c.certId !== certId);
      if (remaining.length > 0) {
        onSelectCert(remaining[0].id);
      } else {
        setSessionActive(false);
        setShowSummary(true);
      }
    }, 1500);
  }

  const ungradedCount = queue.length;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SquareStack size={15} className="text-[var(--admin-gold)]" />
          <h3 className="text-[var(--admin-ink)] text-xs font-bold uppercase tracking-widest">Grading Queue</h3>
          <span className="bg-[var(--admin-gold)]/20 text-[var(--admin-gold)] text-[10px] px-1.5 py-0.5 rounded font-bold">
            {ungradedCount}
          </span>
        </div>
        {sessionActive && (
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 text-[var(--admin-ink-dim)]">
              <Clock size={11} />
              Session:{" "}
              <span className="text-[var(--admin-gold)] font-mono font-bold">{formatTime(sessionSeconds)}</span>
            </span>
            {currentCertId && (
              <span className="flex items-center gap-1 text-[var(--admin-ink-dim)]">
                Card: <span className="text-[var(--admin-ink)] font-mono font-bold">{formatTime(cardSeconds)}</span>
              </span>
            )}
            {currentIdx >= 0 && (
              <span className="text-[var(--admin-ink-dim)]">
                Card {currentIdx + 1} of {queue.length + gradedCards.length}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Start session / nav controls */}
      {!sessionActive ? (
        <button
          type="button"
          onClick={startSession}
          disabled={queue.length === 0}
          className="flex items-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-4 py-2 rounded-lg disabled:opacity-40 hover:opacity-90"
        >
          <Play size={13} />
          Start Grading Session
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goToCard(currentIdx - 1)}
            disabled={currentIdx <= 0}
            className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] hover:border-[var(--admin-gold)]/40 p-1.5 rounded transition-colors disabled:opacity-30"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => goToCard(currentIdx + 1)}
            disabled={currentIdx >= queue.length - 1}
            className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] hover:border-[var(--admin-gold)]/40 p-1.5 rounded transition-colors disabled:opacity-30"
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionActive(false);
              setShowSummary(true);
            }}
            className="text-[var(--admin-ink-dim)] text-xs hover:text-[var(--admin-ink)] ml-2 transition-colors"
          >
            End Session
          </button>
        </div>
      )}

      {/* Queue list */}
      {isLoading ? (
        <p className="text-[var(--admin-ink-faint)] text-xs">Loading queue…</p>
      ) : queue.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)] rounded-lg px-3 py-2">
          <CheckCircle2 size={13} />
          All cards graded!
        </div>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {queue.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectCert(item.id);
              }}
              className={`w-full text-left rounded-lg px-3 py-2.5 border transition-all text-xs ${
                item.id === currentCertId
                  ? "border-[var(--admin-gold)] bg-[var(--admin-gold)]/8 ring-1 ring-[var(--admin-gold)]/30"
                  : "border-[var(--admin-line)] bg-[var(--admin-panel2)] hover:border-[var(--admin-gold)]/40 hover:bg-[var(--admin-panel)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--admin-ink-faint)] text-[9px] font-mono">{item.certId}</span>
                    {item.id === currentCertId && (
                      <span className="text-[var(--admin-gold)] text-[9px] font-bold">● Current</span>
                    )}
                  </div>
                  <p
                    className={`font-semibold truncate ${item.id === currentCertId ? "text-[var(--admin-ink)]" : "text-[var(--admin-ink-dim)]"}`}
                  >
                    {item.cardName || "Unnamed"}
                  </p>
                  <p className="text-[var(--admin-ink-dim)] text-[10px]">
                    {item.cardSet} · {item.cardGame}
                  </p>
                </div>
                <div className="flex-shrink-0 text-right">
                  <div
                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${item.hasImages ? "text-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)]" : "text-[var(--admin-ink-faint)] bg-[var(--admin-panel2)]"}`}
                  >
                    {item.hasImages ? "Images ✓" : "No images"}
                  </div>
                  <p className="text-[var(--admin-ink-faint)] text-[9px] mt-0.5">
                    {new Date(item.createdAt).toLocaleDateString("en-GB")}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Graded this session */}
      {gradedCards.length > 0 && (
        <div className="border-t border-[var(--admin-line)] pt-3 space-y-1">
          <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest">Graded this session</p>
          {gradedCards.map((g) => (
            <div
              key={g.certId}
              className="flex items-center justify-between text-xs text-[var(--admin-ink-dim)] py-0.5"
            >
              <span className="truncate">{g.cardName}</span>
              <span
                className={`font-bold ml-2 ${g.isBlackLabel ? "text-[var(--admin-gold)]" : "text-[var(--admin-ink)]"}`}
              >
                {g.grade}
                {g.isBlackLabel ? " ★" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Session summary modal */}
      {showSummary && (
        <SessionSummary
          cards={gradedCards}
          sessionDurationSeconds={sessionSeconds}
          onClose={() => setShowSummary(false)}
        />
      )}
    </div>
  );
}
