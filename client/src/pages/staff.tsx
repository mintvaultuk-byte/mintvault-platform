import { useEffect, useMemo, useState, useCallback } from "react";
import { Image as ImageIcon } from "lucide-react";
import { useLocation } from "wouter";
import InstallAppButton from "../components/install-app-button";
import { PrintingConsole } from "./admin-printing";
import { PrintQueueConsole } from "./admin-print-queue";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";
import { GradingWorkstation } from "@/components/grading-workflow/GradingWorkstation";

/**
 * Unified staff dashboard. Renders ONLY the tabs the logged-in person's
 * capabilities allow (grade / scan / print). Every datum is PII-FREE (from
 * /api/staff/* + the grader surface). Server-guarded per tab — this UI is
 * convenience, not the security boundary.
 */
type Caps = { grade: boolean; scan: boolean; print: boolean };
type Tab = "grade" | "scan" | "print" | "print-queue";

export default function StaffPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [caps, setCaps] = useState<Caps>({ grade: false, scan: false, print: false });
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/staff/session", { credentials: "include" });
        const d = await res.json();
        if (cancelled) return;
        setAuthed(!!d.authenticated);
        setEmail(d.email || "");
        const c: Caps = d.caps || { grade: false, scan: false, print: false };
        setCaps(c);
        setTab(c.grade ? "grade" : c.scan ? "scan" : c.print ? "print" : null);
      } catch {
        if (!cancelled) setAuthed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/staff/login", { replace: true });
  }, [authed, navigate]);

  async function logout() {
    await fetch("/api/staff/logout", { method: "POST", credentials: "include" });
    navigate("/staff/login", { replace: true });
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  const allTabs: { id: Tab; label: string; on: boolean }[] = [
    { id: "grade", label: "Grading", on: caps.grade },
    { id: "scan", label: "Scanning", on: caps.scan },
    { id: "print", label: "Printing", on: caps.print },
    { id: "print-queue", label: "Print Queue", on: caps.print },
  ];
  const tabs = allTabs.filter((t) => t.on);

  return (
    <div className="min-h-screen bg-[var(--admin-bg)] text-[var(--admin-ink)]">
      {/* Same shared AdminHeaderRow primitive as the Super Admin dashboard and
          grading workstation (breadcrumb/title left, compact actions right) —
          Staff keeps its own tab nav and permission-gated content entirely;
          only the outer row rhythm + design tokens are shared. */}
      <header className="border-b border-[var(--admin-line)] px-3 py-2">
        <AdminHeaderRow
          testId="staff-header"
          left={
            <>
              <h1 className="text-[var(--admin-gold)] text-sm font-extrabold tracking-wide">MintVault — Staff</h1>
              <nav className="flex gap-1">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${tab === t.id ? "bg-[var(--admin-gold)] text-[#1A1400]" : "border border-[var(--admin-gold)]/30 text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10"}`}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            </>
          }
          right={
            <>
              <InstallAppButton className="border border-[var(--admin-gold)]/30 rounded-lg px-2 py-1 text-[10px] hover:bg-[var(--admin-gold)]/10" />
              <span className="text-[10px] text-[var(--admin-ink-faint)]">{email}</span>
              <button
                onClick={logout}
                className="border border-[var(--admin-gold)]/30 rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10"
              >
                Sign out
              </button>
            </>
          }
        />
      </header>
      {tab === "grade" && <GradeTab />}
      {tab === "scan" && <ScanTab />}
      {tab === "print" && <PrintTab />}
      {tab === "print-queue" && <PrintQueueConsole apiBase="/api/staff/print" />}
      {!tab && <p className="text-center text-[#E8E4DC]/50 py-16 text-sm">No tools enabled for your account.</p>}
    </div>
  );
}

// ── GRADE tab — the real MVGS panel (reuses the grader surface) ───────────────
type GCard = {
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
  scannedByMe: boolean;
  gradedByMe: boolean;
  gradeApprovedAt: string | null;
  frontUrl: string | null;
  backUrl: string | null;
};
type GItem = { submissionRef: string; submissionCreatedAt: string | null; serviceTier: string | null; cards: GCard[] };
type CorrectionFeedback = {
  corrected: boolean;
  correctedAt?: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
};
type StaffQueueSort =
  | "queue-oldest"
  | "queue-newest"
  | "cert-asc"
  | "cert-desc"
  | "submission-oldest"
  | "submission-newest";

const STAFF_QUEUE_SORT_KEY = "mv.staff.queueSort";
const STAFF_QUEUE_SORT_DEFAULT: StaffQueueSort = "queue-oldest";
const STAFF_QUEUE_SORT_OPTIONS: { value: StaffQueueSort; label: string }[] = [
  { value: "queue-oldest", label: "Queue Order (Oldest First)" },
  { value: "queue-newest", label: "Queue Order (Newest First)" },
  { value: "cert-asc", label: "Certificate Number (Lowest \u2192 Highest)" },
  { value: "cert-desc", label: "Certificate Number (Highest \u2192 Lowest)" },
  { value: "submission-oldest", label: "Submission Date (Oldest \u2192 Newest)" },
  { value: "submission-newest", label: "Submission Date (Newest \u2192 Oldest)" },
];

function loadStaffQueueSort(): StaffQueueSort {
  try {
    const saved = localStorage.getItem(STAFF_QUEUE_SORT_KEY);
    return STAFF_QUEUE_SORT_OPTIONS.some((o) => o.value === saved)
      ? (saved as StaffQueueSort)
      : STAFF_QUEUE_SORT_DEFAULT;
  } catch {
    return STAFF_QUEUE_SORT_DEFAULT;
  }
}

function numericCertValue(certId: string): number {
  const match = certId.match(/\d+/g);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match.join(""));
}

function timestampValue(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

type Analytics = {
  rate: number;
  dailyTarget: number;
  week: { approved: number; earnings: number; startDate: string };
  month: { approved: number; earnings: number; startDate: string };
  today: { approved: number };
  queue: { assigned: number; pendingReview: number };
  approval: { approved: number; bounced: number; rate: number };
  lifetime: { approved: number; earnings: number };
};

function Stat({
  label,
  big,
  sub,
  subLabel,
  rateNotSet,
}: {
  label: string;
  big: string;
  sub?: string;
  subLabel?: string;
  rateNotSet?: boolean;
}) {
  return (
    <div className="border border-[#D4AF37]/20 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">
        {label}
        {subLabel ? ` · ${subLabel}` : ""}
      </div>
      <div className="text-[#D4AF37] text-xl font-extrabold mt-1 leading-none">{big}</div>
      {sub && <div className="text-[11px] text-[#E8E4DC]/50 mt-1">{sub}</div>}
      {rateNotSet && <div className="text-[10px] text-amber-400/80 mt-0.5">(rate not set)</div>}
    </div>
  );
}

/** Always-visible analytics strip above the grader card list. Loading → skeleton;
 *  error/not-ready (a === null && !loading) → renders nothing (never blocks the queue). */
function GradeAnalytics({ a, loading }: { a: Analytics | null; loading: boolean }) {
  if (!a) {
    if (!loading) return null;
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border border-[#D4AF37]/20 rounded-lg p-3">
            <div className="h-2 w-16 bg-[#D4AF37]/10 rounded animate-pulse" />
            <div className="h-5 w-20 bg-[#D4AF37]/10 rounded animate-pulse mt-2" />
            <div className="h-2 w-24 bg-[#D4AF37]/10 rounded animate-pulse mt-2" />
          </div>
        ))}
      </div>
    );
  }
  const rateSet = a.rate > 0;
  const money = (v: number) => (rateSet ? `£${v.toFixed(2)}` : "—");
  const target = a.dailyTarget || 20;
  const todayN = a.today.approved;
  const now = new Date();
  const dayFrac = (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const pace = todayN >= target ? "Ahead" : todayN >= 0.7 * target && dayFrac >= 0.7 ? "On pace" : "Behind";
  const paceCls =
    pace === "Ahead"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/30"
      : pace === "On pace"
        ? "text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10"
        : "text-red-400 border-red-500/40 bg-red-950/30";
  const pct = target > 0 ? Math.min(100, Math.round((todayN / target) * 100)) : 0;
  const inQueue = a.queue.assigned + a.queue.pendingReview;

  return (
    <div className="mb-5 space-y-4" data-testid="grade-analytics">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="This week"
          big={money(a.week.earnings)}
          sub={`${a.week.approved} cards approved`}
          rateNotSet={!rateSet}
        />
        <Stat
          label="This month"
          big={money(a.month.earnings)}
          sub={`${a.month.approved} cards approved`}
          rateNotSet={!rateSet}
        />
        <Stat
          label="Approval rate"
          subLabel="30d"
          big={`${a.approval.rate}%`}
          sub={`${a.approval.approved} approved / ${a.approval.bounced} bounced`}
        />
        <Stat
          label="Lifetime"
          big={`${a.lifetime.approved} cards`}
          sub={rateSet ? `${money(a.lifetime.earnings)} total` : "earnings —"}
          rateNotSet={!rateSet}
        />
      </div>
      <div className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[#E8E4DC]/70">
              <span className="text-[#D4AF37] font-bold">{todayN}</span> / {target} cards today
            </span>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${paceCls}`}
              data-testid="pace-badge"
            >
              {pace}
            </span>
          </div>
          <div className="h-2 bg-[#D4AF37]/10 rounded-full overflow-hidden">
            <div className="h-full bg-[#D4AF37] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="text-xs text-[#E8E4DC]/60">
          <span className="text-[#E8E4DC]/80 font-semibold">{a.queue.assigned}</span> assigned ·{" "}
          <span className="text-[#E8E4DC]/80 font-semibold">{a.queue.pendingReview}</span> pending review · {inQueue}{" "}
          total in queue
        </div>
      </div>
    </div>
  );
}

function GradeTab() {
  const [queue, setQueue] = useState<GItem[]>([]);
  const [active, setActive] = useState<{ ref: string; serviceTier: string | null; card: GCard } | null>(null);
  const [correctionFeedback, setCorrectionFeedback] = useState<CorrectionFeedback | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [aLoading, setALoading] = useState(true);
  const [queueSort, setQueueSort] = useState<StaffQueueSort>(loadStaffQueueSort);
  const load = useCallback(async () => {
    const r = await fetch("/api/grader/queue", { credentials: "include" });
    if (r.ok) setQueue((await r.json()).items || []);
    // Analytics — best-effort; any error is silent and never blocks the queue.
    setALoading(true);
    try {
      const ar = await fetch("/api/staff/analytics", { credentials: "include" });
      if (ar.ok) setAnalytics(await ar.json());
    } catch {
      /* silent */
    } finally {
      setALoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const certId = active?.card.certId;
    if (!certId || active.card.gradingStatus !== "approved") {
      setCorrectionFeedback(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/grader/certificates/${certId}/corrections`, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setCorrectionFeedback(res.ok ? data : null);
      } catch {
        if (!cancelled) setCorrectionFeedback(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.card.certId, active?.card.gradingStatus]);

  function updateQueueSort(next: StaffQueueSort) {
    setQueueSort(next);
    try {
      localStorage.setItem(STAFF_QUEUE_SORT_KEY, next);
    } catch {
      /* preference persistence is best-effort */
    }
  }

  // Flatten the grader's own cards (every state) and segment by workflow stage so
  // both outstanding and finished work are visible. A card the grader only SCANNED
  // (assigned to someone else / not yet assigned) is read-only here.
  const all = useMemo(
    () =>
      queue.flatMap((it, submissionIndex) =>
        it.cards.map((card, cardIndex) => ({
          card,
          ref: it.submissionRef,
          serviceTier: it.serviceTier,
          submissionCreatedAt: it.submissionCreatedAt,
          queueIndex: submissionIndex,
          cardIndex,
        }))
      ),
    [queue]
  );
  const sortRows = useCallback(
    (
      items: {
        card: GCard;
        ref: string;
        serviceTier: string | null;
        submissionCreatedAt: string | null;
        queueIndex: number;
        cardIndex: number;
      }[]
    ) =>
      [...items].sort((a, b) => {
        const stableCompare = a.queueIndex - b.queueIndex || a.cardIndex - b.cardIndex;
        const queueCompare =
          timestampValue(a.submissionCreatedAt) - timestampValue(b.submissionCreatedAt) || stableCompare;
        const certCompare =
          numericCertValue(a.card.certIdStr) - numericCertValue(b.card.certIdStr) ||
          a.card.certIdStr.localeCompare(b.card.certIdStr) ||
          queueCompare;

        switch (queueSort) {
          case "queue-newest":
            return -queueCompare;
          case "cert-asc":
            return certCompare;
          case "cert-desc":
            return -certCompare;
          case "submission-oldest":
            return queueCompare;
          case "submission-newest":
            return -queueCompare;
          case "queue-oldest":
          default:
            return queueCompare;
        }
      }),
    [queueSort]
  );

  if (active) {
    const c = active.card;
    return (
      // Focused full-viewport grading view: a bounded h-[100dvh] flex column so
      // the canonical workstation (flex-1) fills exactly the available height —
      // no fixed offset, no black band. Fixed inset-0 takes over the screen for
      // rapid grading (breadcrumb has the ← back to exit).
      <div className="fixed inset-0 z-40 flex flex-col bg-[var(--admin-bg)] text-[var(--admin-ink)]" data-testid="staff-grading-focus">
        {/* Same shared AdminHeaderRow primitive as the outer Staff header and
            Super Admin — this breadcrumb previously used raw ad-hoc markup
            (hardcoded #D4AF37 hex, no shared row rhythm), which is exactly
            what made the live grading workflow look like a second, legacy
            standalone shell stacked beneath the real header. */}
        <div className="shrink-0">
        <AdminHeaderRow
          testId="staff-grading-breadcrumb"
          left={
            <>
              <button onClick={() => setActive(null)} className="text-[var(--admin-gold)] text-xs hover:underline">
                ← Back
              </button>
              <span className="text-[var(--admin-gold)] font-mono text-xs">{active.ref}</span>
              {c.gradingStatus === "pending_review" && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  Submitted · editing (stays pending review)
                </span>
              )}
            </>
          }
        />
        {c.rejectionReason && (
          <div className="mx-auto max-w-3xl mt-3 px-4">
            <div className="border border-amber-500/50 bg-amber-950/30 text-amber-300 rounded-lg px-4 py-2 text-sm">
              <span className="font-bold uppercase text-[11px] tracking-wide">Sent back for redo</span> —{" "}
              {c.rejectionReason}
            </div>
          </div>
        )}
        </div>
        <GradingWorkstation
          mode="staff"
          apiBase="/api/grader"
          graderMode
          serviceTier={active.serviceTier}
          // Reopening an already-submitted card = EDIT mode: the full workstation,
          // but the primary action saves via the gated /edit-submission (stays
          // pending review, never publishes).
          graderEdit={c.gradingStatus === "pending_review"}
          certId={c.certId}
          certIdStr={c.certIdStr}
          cardName={c.cardName || ""}
          cardSet={c.setName || ""}
          cardNumber={c.cardNumber}
          cardYear={c.year}
          cardLanguage={c.language}
          cardVariant={c.variant}
          cardGame={c.cardGame || undefined}
          existingGrade={c.grade}
          correctionFeedback={correctionFeedback}
          onGradeApproved={async () => {
            await load();
            setActive(null);
          }}
          onCertUpdated={() => {}}
        />
      </div>
    );
  }
  const toGrade = all.filter((x) => x.card.gradingStatus === "assigned" || x.card.gradingStatus === "unassigned");
  const inReview = all.filter((x) => x.card.gradingStatus === "pending_review");
  const done = all.filter((x) => x.card.gradingStatus === "approved");
  const other = all.filter(
    (x) => !["assigned", "unassigned", "pending_review", "approved"].includes(x.card.gradingStatus)
  );

  const renderRow = ({ card, ref, serviceTier }: { card: GCard; ref: string; serviceTier: string | null }) => (
    <li key={card.certId} className="border border-[#D4AF37]/20 rounded-lg p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {/* Front/back card thumbnails — reuses the grader image source (signed R2
            URLs now returned by /api/grader/queue) and mirrors the admin card-thumb
            approach. Clear "No images yet" placeholder when the card hasn't been
            scanned, so it reads as needs-scanning, not a broken image. */}
        {card.frontUrl || card.backUrl ? (
          <div className="flex items-center gap-1.5 shrink-0">
            {(
              [
                ["Front", card.frontUrl],
                ["Back", card.backUrl],
              ] as const
            ).map(([label, url]) => (
              <div
                key={label}
                title={label}
                className="w-[54px] h-[76px] rounded-md shrink-0 border border-[#D4AF37]/15 bg-[#1a1711] grid place-items-center overflow-hidden"
              >
                {url ? (
                  <img src={url} alt={label} className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="w-4 h-4 text-[#E8E4DC]/30" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0" title="No images — card needs scanning">
            <div className="w-[54px] h-[76px] rounded-md shrink-0 border border-dashed border-[#D4AF37]/20 bg-[#1a1711] grid place-items-center">
              <ImageIcon className="w-4 h-4 text-[#E8E4DC]/25" />
            </div>
            <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/40 whitespace-nowrap">
              No images yet
            </span>
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[#D4AF37] font-mono text-xs">{ref || "—"}</div>
          <div className="font-semibold truncate">
            {/* Lead with the MintVault cert number so the grader can match the row to
                the physical cert — especially for unidentified cards with no name. */}
            <span className="font-mono text-[#D4AF37]">{card.certIdStr}</span>
            <span className="text-[#E8E4DC]/40"> · </span>
            {card.cardName || "Unidentified card"}{" "}
            {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
          </div>
          <div className="text-[#E8E4DC]/50 text-xs">
            {[card.setName, card.year, card.variant].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      {card.gradingStatus === "assigned" && card.assignedToMe ? (
        <button
          onClick={() => setActive({ ref, serviceTier, card })}
          className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C] shrink-0"
        >
          Grade
        </button>
      ) : card.gradingStatus === "pending_review" && card.gradedByMe ? (
        // Submitted but not yet approved — reopen the FULL workstation to correct
        // it. Stays pending_review, never auto-publishes (gated /edit-submission).
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-amber-300">Submitted</span>
          <button
            onClick={() => setActive({ ref, serviceTier, card })}
            data-testid={`btn-edit-submission-${card.certId}`}
            className="border border-[#D4AF37]/50 text-[#D4AF37] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#D4AF37]/10"
          >
            Edit
          </button>
        </div>
      ) : card.gradingStatus === "approved" ? (
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-emerald-400">Approved</span>
          {card.grade && <span className="text-[#D4AF37] text-sm font-bold leading-none">{card.grade}</span>}
          {card.gradedByMe && (
            <button
              onClick={() => setActive({ ref, serviceTier, card })}
              data-testid={`btn-view-approved-${card.certId}`}
              className="border border-[#D4AF37]/50 text-[#D4AF37] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#D4AF37]/10"
            >
              View
            </button>
          )}
        </div>
      ) : card.gradingStatus === "unassigned" ? (
        <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 shrink-0">
          Scanned · awaiting assignment
        </span>
      ) : (
        <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 shrink-0">{card.gradingStatus}</span>
      )}
    </li>
  );

  const section = (title: string, items: typeof all) =>
    items.length === 0 ? null : (
      <section key={title} className="mb-5" data-testid={`grade-section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <h2 className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 font-bold mb-2">
          {title} · {items.length}
        </h2>
        <ul className="space-y-2">{sortRows(items).map(renderRow)}</ul>
      </section>
    );

  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      <GradeAnalytics a={analytics} loading={aLoading} />
      {all.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">
          No cards yet — scan or get assigned a card to begin.
        </p>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-end gap-2">
            <label htmlFor="staff-queue-sort" className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">
              Sort
            </label>
            <select
              id="staff-queue-sort"
              value={queueSort}
              onChange={(e) => updateQueueSort(e.target.value as StaffQueueSort)}
              className="rounded border border-[#D4AF37]/30 bg-black px-2 py-1 text-xs text-[#E8E4DC] outline-none hover:bg-[#D4AF37]/10 focus:border-[#D4AF37]"
            >
              {STAFF_QUEUE_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-black text-[#E8E4DC]">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {section("To grade", toGrade)}
          {section("In review", inReview)}
          {section("Other", other)}
          {section("Done", done)}
        </>
      )}
    </main>
  );
}

// ── SCAN tab — upload raw front/back onto assigned cards ──────────────────────
type SCard = {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  cardNumber: string | null;
  hasFront: boolean;
  hasBack: boolean;
};
type SItem = { submissionId: number; submissionRef: string; cards: SCard[] };

function ScanTab() {
  const [queue, setQueue] = useState<SItem[]>([]);
  const [busyCert, setBusyCert] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/staff/scan/queue", { credentials: "include" });
    if (r.ok) setQueue((await r.json()).items || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(certId: number, side: "front" | "back", file: File) {
    setBusyCert(certId);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append(side, file);
      const r = await fetch(`/api/staff/scan/certificates/${certId}/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setMsg(d.error || "Upload failed");
      } else {
        await load();
      }
    } finally {
      setBusyCert(null);
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      {msg && (
        <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2 mb-3">{msg}</div>
      )}
      {queue.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No submissions awaiting scan.</p>
      ) : (
        queue.map((sub) => (
          <section key={sub.submissionId} className="mb-5">
            <h2 className="text-[#D4AF37] font-mono text-sm mb-2">{sub.submissionRef}</h2>
            <ul className="space-y-2">
              {sub.cards.map((card) => (
                <li
                  key={card.certId}
                  className="border border-[#D4AF37]/20 rounded-lg p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-[#D4AF37] font-mono">{card.certIdStr}</div>
                    <div className="font-semibold truncate text-sm">
                      {card.cardName || "Unidentified"}{" "}
                      {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {(["front", "back"] as const).map((side) => (
                      <label key={side} className="text-[11px] flex flex-col items-center gap-0.5 cursor-pointer">
                        <span
                          className={
                            card[side === "front" ? "hasFront" : "hasBack"] ? "text-emerald-400" : "text-[#E8E4DC]/50"
                          }
                        >
                          {card[side === "front" ? "hasFront" : "hasBack"] ? "✓ " : ""}
                          {side}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          disabled={busyCert === card.certId}
                          className="hidden"
                          onChange={(e) => e.target.files?.[0] && upload(card.certId, side, e.target.files[0])}
                        />
                        <span className="border border-[#D4AF37]/40 rounded px-2 py-0.5 hover:bg-[#D4AF37]/10">
                          upload
                        </span>
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

// ── PRINT tab — the FULL Label Sheet Printing console, reused from the admin
// dashboard (thumbnails, All/Unprinted/Printed tabs, Generate Batch, Claim
// Inserts, Latest Sheet / reprint / PNG / Cut SVG). The SAME component renders
// here; only the API base differs (staff-authed print proxies, capability-gated).
// Printing is a fulfilment step over ALL printable certs — parity with admin.
function PrintTab() {
  return <PrintingConsole apiBase="/api/staff/print" />;
}
