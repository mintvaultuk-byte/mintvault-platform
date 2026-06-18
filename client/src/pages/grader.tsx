import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Restricted-grader dashboard. Shows ONLY this grader's assigned cards and is
 * strictly PII-free — every datum comes from /api/grader/* endpoints that never
 * return a customer name/email/address. There are NO links to admin, customers,
 * pop reports, other graders or settings. Server-side guards back every call;
 * this UI is a convenience, not the security boundary.
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
};
type QueueItem = {
  submissionId: number;
  submissionRef: string;
  gradingStatus: string;
  cardCount: number;
  serviceTier: string | null;
  cards: Card[];
};

const GRADE_TYPES = [
  { value: "numeric", label: "Numeric (1–10)" },
  { value: "authentic_altered", label: "Authentic Altered (AA)" },
  { value: "not_original", label: "Not Graded (NO)" },
];

export default function GraderPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string>("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [active, setActive] = useState<{ item: QueueItem; card: Card } | null>(null);

  // ── Gate ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/grader/session", { credentials: "include" });
        const data = await res.json();
        if (!cancelled) {
          setAuthed(!!data.authenticated);
          setEmail(data.email || "");
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

  const loadQueue = useCallback(async () => {
    const res = await fetch("/api/grader/queue", { credentials: "include" });
    if (res.ok) setQueue((await res.json()).items || []);
  }, []);

  useEffect(() => {
    if (authed) loadQueue();
  }, [authed, loadQueue]);

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

      {active ? (
        <GraderGradeView
          item={active.item}
          card={active.card}
          onBack={() => setActive(null)}
          onSubmitted={async () => {
            await loadQueue();
            setActive(null);
          }}
        />
      ) : (
        <main className="max-w-3xl mx-auto px-4 py-6">
          {queue.length === 0 ? (
            <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No cards assigned to you right now.</p>
          ) : (
            <ul className="space-y-3">
              {queue.map((item) =>
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
                      <StatusChip status={item.gradingStatus} />
                      <button
                        onClick={() => setActive({ item, card })}
                        disabled={item.gradingStatus !== "assigned"}
                        className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C] disabled:opacity-40"
                      >
                        {item.gradingStatus === "assigned" ? "Grade" : "Submitted"}
                      </button>
                    </div>
                  </li>
                ))
              )}
            </ul>
          )}
        </main>
      )}
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

// ── Single-card grading view ──────────────────────────────────────────────────
function GraderGradeView({
  item,
  card,
  onBack,
  onSubmitted,
}: {
  item: QueueItem;
  card: Card;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [form, setForm] = useState({
    overall_grade: card.grade || "",
    grade_type: "numeric",
    grade_centering: "",
    grade_corners: "",
    grade_edges: "",
    grade_surface: "",
    auth_status: "genuine",
    grade_explanation: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [imgRes, grRes] = await Promise.all([
        fetch(`/api/grader/certificates/${card.certId}/images`, { credentials: "include" }),
        fetch(`/api/grader/certificates/${card.certId}/grading`, { credentials: "include" }),
      ]);
      if (imgRes.ok) setImages((await imgRes.json()).urls || {});
      if (grRes.ok) {
        const g = await grRes.json();
        setForm((f) => ({
          ...f,
          overall_grade: g.grade ?? f.overall_grade,
          grade_centering: g.centeringScore ?? "",
          grade_corners: g.cornersScore ?? "",
          grade_edges: g.edgesScore ?? "",
          grade_surface: g.surfaceScore ?? "",
          auth_status: g.authStatus || "genuine",
          grade_explanation: g.gradeExplanation || "",
        }));
      }
    })();
  }, [card.certId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grader/certificates/${card.certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "Submit failed");
        return;
      }
      onSubmitted();
    } catch (e: any) {
      setError(e.message || "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const front = images.front_display || images.front_original;
  const back = images.back_display || images.back_original;

  return (
    <main className="max-w-5xl mx-auto px-4 py-5">
      <button onClick={onBack} className="text-[#D4AF37] text-xs mb-3 hover:underline">
        ← Back to queue
      </button>
      <div className="text-xs text-[#D4AF37] font-mono">{item.submissionRef}</div>
      <h2 className="text-lg font-bold mb-4">
        {card.cardName || "Unidentified card"}{" "}
        {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
      </h2>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="grid grid-cols-2 gap-2">
          {[front, back].map((src, i) =>
            src ? (
              <img
                key={i}
                src={src}
                alt={i === 0 ? "front" : "back"}
                className="w-full rounded border border-[#D4AF37]/20"
              />
            ) : (
              <div
                key={i}
                className="aspect-[3/4] rounded border border-[#D4AF37]/10 flex items-center justify-center text-[#E8E4DC]/30 text-xs"
              >
                No scan
              </div>
            )
          )}
        </div>

        <div className="space-y-3">
          {error && (
            <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2">{error}</div>
          )}
          <Field label="Grade type">
            <select value={form.grade_type} onChange={(e) => set("grade_type", e.target.value)} className="gr-input">
              {GRADE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {form.grade_type === "numeric" && (
            <>
              <Field label="Overall grade">
                <input
                  value={form.overall_grade}
                  onChange={(e) => set("overall_grade", e.target.value)}
                  className="gr-input"
                  placeholder="e.g. 9.5"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Centering">
                  <input
                    value={form.grade_centering}
                    onChange={(e) => set("grade_centering", e.target.value)}
                    className="gr-input"
                  />
                </Field>
                <Field label="Corners">
                  <input
                    value={form.grade_corners}
                    onChange={(e) => set("grade_corners", e.target.value)}
                    className="gr-input"
                  />
                </Field>
                <Field label="Edges">
                  <input
                    value={form.grade_edges}
                    onChange={(e) => set("grade_edges", e.target.value)}
                    className="gr-input"
                  />
                </Field>
                <Field label="Surface">
                  <input
                    value={form.grade_surface}
                    onChange={(e) => set("grade_surface", e.target.value)}
                    className="gr-input"
                  />
                </Field>
              </div>
            </>
          )}
          <Field label="Authenticity">
            <select value={form.auth_status} onChange={(e) => set("auth_status", e.target.value)} className="gr-input">
              <option value="genuine">Genuine</option>
              <option value="altered">Altered</option>
              <option value="counterfeit">Counterfeit</option>
            </select>
          </Field>
          <Field label="Grade notes (public)">
            <textarea
              value={form.grade_explanation}
              onChange={(e) => set("grade_explanation", e.target.value)}
              className="gr-input min-h-[60px]"
            />
          </Field>
          <button
            onClick={submit}
            disabled={busy}
            className="w-full bg-[#D4AF37] text-[#1A1400] font-bold py-2.5 rounded hover:bg-[#B8960C] disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit for review"}
          </button>
          <p className="text-[#E8E4DC]/40 text-[11px] text-center">
            Submitting sends this card to an admin for approval.
          </p>
        </div>
      </div>
      <style>{`.gr-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:6px 8px;color:#E8E4DC;font-size:13px;outline:none}.gr-input:focus{border-color:#D4AF37}`}</style>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[#E8E4DC]/70 text-[11px]">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
