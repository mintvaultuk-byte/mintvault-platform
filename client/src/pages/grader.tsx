import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import GradingPanel from "../components/grading/grading-panel";

/**
 * Restricted-grader dashboard (v2 — cert-level). Shows ONLY this grader's
 * assigned CARDS (certificates) and is strictly PII-free — every datum comes
 * from /api/grader/* endpoints that never return a customer name/email/address.
 * Grading runs the REAL MVGS panel (the same component admins use), mounted with
 * apiBase='/api/grader' + graderMode so the grader crops/centres/analyses/
 * identifies/saves a draft and Submits for approval — never publishes.
 */
type Card = {
  certId: number;
  certIdStr: string;
  cardGame: string | null;
  setName: string | null;
  cardName: string | null;
  cardNumber: string | null;
  year: string | null;
  variant: string | null;
  grade: string | null;
  gradingStatus: string;
  rejectionReason: string | null;
  redoCount: number;
};
type QueueItem = { submissionId: number; submissionRef: string; serviceTier: string | null; cards: Card[] };
type Earnings = { approved: number; pendingReview: number; flagged: number; rate: number; earned: number };

export default function GraderPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [active, setActive] = useState<{ item: QueueItem; card: Card } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/grader/session", { credentials: "include" });
        const d = await res.json();
        if (!cancelled) {
          setAuthed(!!d.authenticated);
          setEmail(d.email || "");
        }
      } catch {
        if (!cancelled) setAuthed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/grader/login", { replace: true });
  }, [authed, navigate]);

  const refresh = useCallback(async () => {
    const [q, e] = await Promise.all([
      fetch("/api/grader/queue", { credentials: "include" }),
      fetch("/api/grader/earnings", { credentials: "include" }),
    ]);
    if (q.ok) setQueue((await q.json()).items || []);
    if (e.ok) setEarnings(await e.json());
  }, []);
  useEffect(() => {
    if (authed) refresh();
  }, [authed, refresh]);

  async function logout() {
    await fetch("/api/grader/logout", { method: "POST", credentials: "include" });
    navigate("/grader/login", { replace: true });
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  if (active) {
    const c = active.card;
    return (
      <div className="min-h-screen bg-black text-[#E8E4DC]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-[#D4AF37]/20">
          <button onClick={() => setActive(null)} className="text-[#D4AF37] text-xs hover:underline">
            ← Back to queue
          </button>
          <span className="text-[#E8E4DC]/60 text-xs font-mono">{active.item.submissionRef}</span>
        </header>
        {c.rejectionReason && (
          <div className="mx-auto max-w-3xl mt-3 px-4">
            <div className="border border-amber-500/50 bg-amber-950/30 text-amber-300 rounded-lg px-4 py-2 text-sm">
              <span className="font-bold uppercase text-[11px] tracking-wide">Sent back for redo</span> —{" "}
              {c.rejectionReason}
            </div>
          </div>
        )}
        <GradingPanel
          apiBase="/api/grader"
          graderMode
          certId={c.certId}
          certIdStr={c.certIdStr}
          cardName={c.cardName || ""}
          cardSet={c.setName || ""}
          cardGame={c.cardGame || undefined}
          existingGrade={c.grade}
          onGradeApproved={async () => {
            await refresh();
            setActive(null);
          }}
          onCertUpdated={() => {}}
        />
      </div>
    );
  }

  const cardCount = queue.reduce((n, it) => n + it.cards.length, 0);
  return (
    <div className="min-h-screen bg-black text-[#E8E4DC]">
      <header className="flex items-center justify-between px-5 py-3 border-b border-[#D4AF37]/20">
        <h1 className="text-[#D4AF37] font-extrabold tracking-wide">MintVault — Grading Queue</h1>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#E8E4DC]/60">{email}</span>
          <button onClick={logout} className="border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10">
            Sign out
          </button>
        </div>
      </header>

      {earnings && (
        <div className="max-w-3xl mx-auto px-4 pt-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label="Approved" value={String(earnings.approved)} />
            <Stat label="Pending" value={String(earnings.pendingReview)} />
            <Stat label="Flagged" value={String(earnings.flagged)} />
            <Stat
              label="Earned"
              value={earnings.rate > 0 ? `£${earnings.earned.toFixed(2)}` : "—"}
              sub={earnings.rate > 0 ? `@ £${earnings.rate.toFixed(2)}/card` : "rate unset"}
            />
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 py-5">
        {cardCount === 0 ? (
          <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No cards assigned to you right now.</p>
        ) : (
          <ul className="space-y-3">
            {queue.flatMap((item) =>
              item.cards.map((card) => (
                <li
                  key={card.certId}
                  className="border border-[#D4AF37]/20 rounded-lg p-4 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-[#D4AF37] font-mono text-xs">{item.submissionRef}</div>
                    <div className="font-semibold truncate">
                      {card.cardName || "Unidentified card"}{" "}
                      {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
                    </div>
                    <div className="text-[#E8E4DC]/50 text-xs">
                      {[card.setName, card.year, card.variant, card.cardGame].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {card.redoCount > 0 && (
                      <span className="text-[10px] uppercase tracking-wide text-amber-400">redo</span>
                    )}
                    <StatusChip status={card.gradingStatus} />
                    <button
                      onClick={() => setActive({ item, card })}
                      disabled={card.gradingStatus !== "assigned"}
                      className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C] disabled:opacity-40"
                    >
                      {card.gradingStatus === "assigned" ? "Grade" : "Submitted"}
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-[#D4AF37]/20 rounded-lg py-2">
      <div className="text-[#D4AF37] font-extrabold text-lg">{value}</div>
      <div className="text-[#E8E4DC]/60 text-[10px] uppercase tracking-wide">{label}</div>
      {sub && <div className="text-[#E8E4DC]/30 text-[9px]">{sub}</div>}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    assigned: "text-[#D4AF37] border-[#D4AF37]/40",
    pending_review: "text-amber-400 border-amber-500/40",
    approved: "text-emerald-400 border-emerald-500/40",
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wide border rounded-full px-2 py-0.5 ${map[status] || "text-[#E8E4DC]/50 border-[#E8E4DC]/20"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
