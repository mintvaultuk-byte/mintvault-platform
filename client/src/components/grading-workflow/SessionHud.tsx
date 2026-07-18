/**
 * Grading session HUD — session timer, cards/hour, and today's completed count.
 *
 * Pure client-side UI: no tracking leaves the browser. The session start time
 * and completed-card timestamps live in localStorage so a refresh doesn't reset
 * them, and a session auto-rolls after an idle gap. `completed` is the count of
 * cards finished this session (the parent bumps it after a successful save).
 * This component reads nothing from and writes nothing to the certificate,
 * grading, or save systems.
 */
import { useEffect, useState } from "react";
import { Clock, Gauge, CheckCircle2, RotateCcw } from "lucide-react";

const SESSION_KEY = "mv.gradingSession";
const IDLE_ROLL_MS = 6 * 60 * 60 * 1000; // a >6h gap starts a fresh session

interface SessionState {
  startedAt: number;
  completedTimes: number[]; // epoch ms of each completed card, this session
}

function loadSession(now: number): SessionState {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (raw && typeof raw.startedAt === "number" && Array.isArray(raw.completedTimes)) {
      const last = raw.completedTimes[raw.completedTimes.length - 1] ?? raw.startedAt;
      if (now - last < IDLE_ROLL_MS) return raw;
    }
  } catch {
    /* fall through to a fresh session */
  }
  return { startedAt: now, completedTimes: [] };
}

function saveSession(s: SessionState) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* private mode — HUD still works in-memory this session */
  }
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function SessionHud({ completed, nowProvider, embedded = false }: { completed: number; nowProvider?: () => number; embedded?: boolean }) {
  const now = nowProvider ?? (() => Date.now());
  const [session, setSession] = useState<SessionState>(() => loadSession(now()));
  const [tick, setTick] = useState(now());

  // Tick the clock once per second (display only — no re-render storm elsewhere).
  useEffect(() => {
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Record a completion whenever the parent's completed count rises.
  useEffect(() => {
    setSession((prev) => {
      if (completed <= prev.completedTimes.length) return prev;
      const additions = completed - prev.completedTimes.length;
      const stamp = now();
      const next = { ...prev, completedTimes: [...prev.completedTimes, ...Array(additions).fill(stamp)] };
      saveSession(next);
      return next;
    });
  }, [completed]);

  const elapsedMs = Math.max(1000, tick - session.startedAt);
  const done = session.completedTimes.length;
  const perHour = done > 0 ? Math.round((done / elapsedMs) * 3600_000) : 0;

  const reset = () => {
    const fresh = { startedAt: now(), completedTimes: [] };
    saveSession(fresh);
    setSession(fresh);
  };

  const Stat = ({ icon, label, value, testId }: { icon: React.ReactNode; label: string; value: string; testId: string }) => (
    <div className="flex items-center gap-1" data-testid={testId}>
      <span className="text-[var(--admin-gold)]/50">{icon}</span>
      <span className="text-[8px] uppercase tracking-wider text-[var(--admin-ink-faint)]">{label}</span>
      <span className="text-[10px] font-bold tabular-nums text-[var(--admin-ink)]">{value}</span>
    </div>
  );

  return (
    <div
      className={
        embedded
          ? "flex flex-wrap items-center gap-x-2.5 gap-y-0.5"
          : "flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/60 px-2.5 py-1"
      }
      data-testid="session-hud"
      aria-label="Grading session statistics"
    >
      <Stat icon={<Clock size={11} />} label="Session" value={fmtElapsed(elapsedMs)} testId="session-timer" />
      <Stat icon={<CheckCircle2 size={11} />} label="Completed" value={`${done}`} testId="session-completed" />
      <Stat icon={<Gauge size={11} />} label="Cards/hr" value={`${perHour}`} testId="session-cards-per-hour" />
      <button
        type="button"
        onClick={reset}
        data-testid="session-reset"
        title="Start a new session"
        aria-label="Start a new session"
        className={
          embedded
            ? "flex items-center text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold)]"
            : "ml-auto flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold)]"
        }
      >
        <RotateCcw size={11} />
        {!embedded && <span className="ml-1">New session</span>}
      </button>
    </div>
  );
}
