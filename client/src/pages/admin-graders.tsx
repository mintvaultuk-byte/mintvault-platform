import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Admin surface for the restricted-grader system: create grader accounts and
 * assign / reassign / unassign batches of submissions. Admin-gated (every call
 * hits requireAdmin server-side). Assignment takes a batch of submission IDs and
 * a grader; the existing submissions grid can deep-link multi-selected IDs here.
 */
type Grader = { id: string; email: string; displayName: string | null; createdAt: string };

export default function AdminGradersPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [graders, setGraders] = useState<Grader[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "include" });
        const d = await res.json();
        setAuthed(res.ok && d.authenticated === true);
      } catch {
        setAuthed(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/graders", { replace: true });
  }, [authed, navigate]);

  const loadGraders = useCallback(async () => {
    const res = await fetch("/api/admin/graders", { credentials: "include" });
    if (res.ok) setGraders((await res.json()).graders || []);
  }, []);
  useEffect(() => {
    if (authed) loadGraders();
  }, [authed, loadGraders]);

  // create grader
  const [nEmail, setNEmail] = useState("");
  const [nPw, setNPw] = useState("");
  const [nName, setNName] = useState("");
  async function createGrader(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const res = await fetch("/api/admin/graders", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: nEmail, password: nPw, display_name: nName }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || "Failed to create grader");
    setMsg(`Grader created: ${d.email}`);
    setNEmail("");
    setNPw("");
    setNName("");
    loadGraders();
  }

  // assignment
  const [aGrader, setAGrader] = useState("");
  const [aIds, setAIds] = useState("");
  function parseIds(s: string): number[] {
    return s
      .split(/[\s,]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  async function doAssign(action: "assign" | "reassign" | "unassign") {
    setMsg(null);
    setErr(null);
    const ids = parseIds(aIds);
    if (!ids.length) return setErr("Enter one or more submission IDs");
    if (action !== "unassign" && !aGrader) return setErr("Pick a grader");
    const res = await fetch(`/api/admin/graders/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grader_id: aGrader, submission_ids: ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || `${action} failed`);
    setMsg(`${action} ok — ${d.count} submission(s) updated`);
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC] px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[#D4AF37] text-xl font-extrabold">Graders</h1>
          <button
            onClick={() => navigate("/admin")}
            className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
          >
            ← Admin
          </button>
        </div>
        {msg && (
          <div className="text-emerald-400 text-xs bg-emerald-950/40 border border-emerald-900 rounded px-3 py-2">
            {msg}
          </div>
        )}
        {err && <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2">{err}</div>}

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Create grader account</h2>
          <form onSubmit={createGrader} className="grid sm:grid-cols-4 gap-2 items-end">
            <input
              className="ag-input"
              placeholder="Email"
              type="email"
              value={nEmail}
              onChange={(e) => setNEmail(e.target.value)}
              required
            />
            <input
              className="ag-input"
              placeholder="Password (≥10)"
              type="text"
              value={nPw}
              onChange={(e) => setNPw(e.target.value)}
              required
            />
            <input
              className="ag-input"
              placeholder="Display name"
              value={nName}
              onChange={(e) => setNName(e.target.value)}
            />
            <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-2 rounded text-sm hover:bg-[#B8960C]">
              Create
            </button>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Assign submissions</h2>
          <div className="space-y-2">
            <select className="ag-input" value={aGrader} onChange={(e) => setAGrader(e.target.value)}>
              <option value="">Select grader…</option>
              {graders.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName ? `${g.displayName} — ${g.email}` : g.email}
                </option>
              ))}
            </select>
            <textarea
              className="ag-input min-h-[60px]"
              placeholder="Submission IDs (comma or space separated, e.g. 1201 1202 1203)"
              value={aIds}
              onChange={(e) => setAIds(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={() => doAssign("assign")}
                className="bg-[#D4AF37] text-[#1A1400] font-bold px-4 py-2 rounded text-sm hover:bg-[#B8960C]"
              >
                Assign
              </button>
              <button
                onClick={() => doAssign("reassign")}
                className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
              >
                Reassign
              </button>
              <button
                onClick={() => doAssign("unassign")}
                className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
              >
                Unassign
              </button>
            </div>
          </div>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Grader accounts ({graders.length})</h2>
          {graders.length === 0 ? (
            <p className="text-[#E8E4DC]/50 text-xs">No graders yet.</p>
          ) : (
            <ul className="text-sm divide-y divide-[#D4AF37]/10">
              {graders.map((g) => (
                <li key={g.id} className="py-2 flex justify-between">
                  <span>{g.displayName || "—"}</span>
                  <span className="text-[#E8E4DC]/60">{g.email}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <style>{`.ag-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:8px;color:#E8E4DC;font-size:13px;outline:none}.ag-input:focus{border-color:#D4AF37}`}</style>
    </div>
  );
}
