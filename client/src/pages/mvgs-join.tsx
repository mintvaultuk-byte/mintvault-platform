/**
 * /mvgs/join — public interest-capture stub for grading companies that
 * want to become MVGS Compliant. Pre-launch placeholder: no membership
 * flow yet, just a single form posting to /api/mvgs/interest.
 *
 * Design mirrors /standard exactly (dark bg, gold accents, terms.tsx-
 * style sectioning) so the two pages feel like one document family.
 */

import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import SeoHead from "@/components/seo-head";
import { apiRequest } from "@/lib/queryClient";

type Status = "idle" | "submitting" | "ok" | "error";

export default function MvgsJoinPage() {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setErrMsg(null);
    if (!company.trim() || !email.trim()) {
      setErrMsg("Company name and contact email are required.");
      return;
    }
    setStatus("submitting");
    try {
      const r = await apiRequest("POST", "/api/mvgs/interest", {
        company: company.trim(),
        email:   email.trim(),
        message: message.trim() || undefined,
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        setStatus("error");
        setErrMsg(j?.error ?? "Submission failed. Please try again.");
        return;
      }
      setStatus("ok");
    } catch (err: any) {
      setStatus("error");
      setErrMsg(err?.message ?? "Network error. Please try again.");
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ccc]">
      <SeoHead
        title="Become MVGS Compliant | MintVault"
        description="Apply for MintVault Grading Standard compliance. Membership for trading-card grading companies. Pre-launch interest list."
        canonical="/mvgs/join"
      />

      <div className="px-4 py-10 max-w-2xl mx-auto">
        <Link href="/standard">
          <button
            className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors mb-8"
            data-testid="button-back-standard"
          >
            <ArrowLeft size={16} /> Back to MVGS Standard
          </button>
        </Link>

        <h1
          className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest mb-3 text-center"
          data-testid="text-mvgs-join-title"
        >
          BECOME MVGS COMPLIANT
        </h1>
        <p className="text-[#aaa] text-sm md:text-base text-center mb-2 leading-relaxed">
          Join the open grading standard.
        </p>
        <p className="text-[#888] text-xs text-center mb-12">
          MintVault MVGS membership for grading companies — coming soon.
        </p>

        {status === "ok" ? (
          <div
            className="border border-[#D4AF37]/40 rounded-lg p-8 text-center bg-[#D4AF37]/5"
            data-testid="success-state"
          >
            <p className="text-[#D4AF37] text-lg font-bold tracking-wider">
              We'll be in touch.
            </p>
            <p className="text-[#888] text-xs mt-3">
              Your interest has been logged. We'll reach out as the membership
              process opens up.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div>
              <label
                htmlFor="company"
                className="block text-[#D4AF37] text-[10px] uppercase tracking-widest font-bold mb-2"
              >
                Grading Company Name
              </label>
              <input
                id="company"
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                disabled={status === "submitting"}
                maxLength={200}
                required
                className="w-full bg-[#111] border border-[#333] rounded-lg px-4 py-3 text-[#ccc] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors disabled:opacity-50"
                data-testid="input-company"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-[#D4AF37] text-[10px] uppercase tracking-widest font-bold mb-2"
              >
                Contact Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={status === "submitting"}
                maxLength={254}
                required
                className="w-full bg-[#111] border border-[#333] rounded-lg px-4 py-3 text-[#ccc] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors disabled:opacity-50"
                data-testid="input-email"
              />
            </div>

            <div>
              <label
                htmlFor="message"
                className="block text-[#D4AF37] text-[10px] uppercase tracking-widest font-bold mb-2"
              >
                Anything else? <span className="text-[#666] normal-case font-normal">(optional)</span>
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === "submitting"}
                maxLength={2000}
                rows={4}
                className="w-full bg-[#111] border border-[#333] rounded-lg px-4 py-3 text-[#ccc] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors disabled:opacity-50 resize-y"
                data-testid="textarea-message"
              />
            </div>

            {errMsg && (
              <p className="text-red-400 text-xs" data-testid="text-error">{errMsg}</p>
            )}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="w-full inline-flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-widest px-6 py-3 rounded-lg bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90 disabled:opacity-50 transition-opacity"
              data-testid="btn-submit"
            >
              {status === "submitting" ? (
                <><Loader2 size={14} className="animate-spin" /> Sending…</>
              ) : (
                "Register Interest"
              )}
            </button>
          </form>
        )}

        <p className="text-[#666] text-xs text-center mt-10">
          Read the full <Link href="/standard" className="text-[#D4AF37]/70 hover:text-[#D4AF37] underline">MVGS specification</Link>.
        </p>
      </div>
    </div>
  );
}
