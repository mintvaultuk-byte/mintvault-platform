import { useState } from "react";
import { useLocation } from "wouter";
import { Shield, AlertTriangle, CheckCircle, Mail, Search } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function StolenCardProtectionPage() {
  const [location] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const verified = params.get("verified");
  const cert = params.get("cert");

  const [reportCertId, setReportCertId] = useState("");
  const [, navigate] = useLocation();

  return (
      <div className="bg-white min-h-screen">
        <SeoHead
          title="Stolen Card Protection | MintVault UK"
          description="MintVault UK's stolen card registry flags stolen graded cards on our public verification system. Report a stolen card or look up a certificate's stolen status."
          canonical="https://mintvaultuk.com/stolen-card-protection"
        />

        {/* Hero */}
        <div className="relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0A0A0A 0%,#1A1200 100%)" }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(212,175,55,0.12) 0%, transparent 70%)" }} />
          <div className="relative max-w-3xl mx-auto px-4 py-20 text-center">
            <div className="inline-flex items-center gap-2 bg-red-900/30 border border-red-700/40 rounded-full px-4 py-1.5 mb-6">
              <AlertTriangle size={13} className="text-red-400" />
              <span className="text-xs font-bold uppercase tracking-widest text-red-400">Theft Prevention</span>
            </div>
            <h1 className="text-4xl md:text-5xl font-black text-white mb-4" style={{ letterSpacing: "-0.02em" }}>
              Stolen Card Protection
            </h1>
            <p className="text-[#B8A060] text-lg max-w-xl mx-auto">
              If your graded card is stolen, MintVault can flag its certificate so any buyer who scans the QR code or NFC chip sees an instant warning.
            </p>
          </div>
        </div>

        {/* Verification result banners */}
        {verified === "true" && cert && (
          <div className="bg-emerald-50 border-b border-emerald-200 py-4 px-4 text-center">
            <p className="text-sm font-bold text-emerald-700 flex items-center justify-center gap-2">
              <CheckCircle size={16} />
              Certificate {cert} has been flagged as stolen. A warning now appears on its public Vault page.
            </p>
          </div>
        )}
        {verified === "already" && (
          <div className="bg-amber-50 border-b border-amber-200 py-4 px-4 text-center">
            <p className="text-sm text-amber-700">This report has already been verified.</p>
          </div>
        )}

        <div className="max-w-3xl mx-auto px-4 py-16 space-y-16">

          {/* How it works */}
          <section>
            <h2 className="text-2xl font-black text-[#1A1A1A] mb-2" style={{ letterSpacing: "-0.02em" }}>How It Works</h2>
            <p className="text-[#666666] mb-8 text-sm">Three steps from theft to protected:</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { step: "1", title: "Report", desc: "Submit a stolen report below with your name, email, and the certificate ID on the label." },
                { step: "2", title: "Verify", desc: "We email you a one-click verification link. Click it to confirm the report is genuine." },
                { step: "3", title: "Protected", desc: "A bright red banner appears on the certificate's Vault page and any NFC/QR scan shows a stolen warning." },
              ].map(({ step, title, desc }) => (
                <div key={step} className="border border-[#E8E4DC] rounded-xl p-5">
                  <div className="w-8 h-8 rounded-full bg-[#D4AF37] text-[#1A1400] font-black text-sm flex items-center justify-center mb-3">{step}</div>
                  <h3 className="font-bold text-[#1A1A1A] mb-1">{title}</h3>
                  <p className="text-xs text-[#888888] leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Report form */}
          <section id="report">
            <h2 className="text-2xl font-black text-[#1A1A1A] mb-2" style={{ letterSpacing: "-0.02em" }}>Report a Stolen Card</h2>
            <p className="text-[#666666] text-sm mb-6">The certificate ID is printed on your MintVault label (e.g. MV1, MV-0000000001).</p>
            <ReportForm />
          </section>

          {/* Check status */}
          <section id="check">
            <h2 className="text-2xl font-black text-[#1A1A1A] mb-2" style={{ letterSpacing: "-0.02em" }}>Check a Certificate</h2>
            <p className="text-[#666666] text-sm mb-6">Enter a certificate ID to check whether it has been reported stolen.</p>
            <div className="flex gap-3 max-w-sm">
              <input
                value={reportCertId}
                onChange={e => setReportCertId(e.target.value)}
                onKeyDown={e => e.key === "Enter" && reportCertId.trim() && navigate(`/cert/${reportCertId.trim().toUpperCase()}`)}
                placeholder="e.g. MV1"
                className="flex-1 border border-[#E8E4DC] rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
              />
              <button
                onClick={() => reportCertId.trim() && navigate(`/cert/${reportCertId.trim().toUpperCase()}`)}
                className="px-4 py-2.5 rounded-lg text-sm font-bold text-[#1A1400] flex items-center gap-2 transition-all"
                style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
              >
                <Search size={14} />
                Look Up
              </button>
            </div>
          </section>

          {/* FAQ */}
          <section id="stolen-cards">
            <h2 className="text-2xl font-black text-[#1A1A1A] mb-6" style={{ letterSpacing: "-0.02em" }}>Frequently Asked Questions</h2>
            <div className="space-y-5">
              {[
                {
                  q: "Does the stolen flag stop anyone from buying the card?",
                  a: "It doesn't block a sale directly, but any buyer who scans the QR code or NFC chip on the slab will see a prominent red stolen warning before they complete the purchase. This significantly deters fraudulent resale through legitimate channels.",
                },
                {
                  q: "What if the report is false or mistaken?",
                  a: "All reports require email verification, which reduces false reports. If a report is made in error, contact us at mintvaultuk@gmail.com and we will review and clear the flag after identity confirmation.",
                },
                {
                  q: "Should I still report the theft to the police?",
                  a: "Yes — always file a police report for a stolen item. MintVault's registry is an additional layer of protection; it doesn't replace official theft reporting. Your police reference number can be helpful if you later need us to clear a flag or assist with a recovery.",
                },
              ].map(({ q, a }) => (
                <div key={q} className="border border-[#E8E4DC] rounded-xl p-5">
                  <h3 className="font-bold text-[#1A1A1A] mb-2 text-sm">{q}</h3>
                  <p className="text-[#666666] text-sm leading-relaxed">{a}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Ownership callout */}
          <section className="rounded-2xl p-8 text-center" style={{ background: "linear-gradient(135deg,#0A0A0A,#1A1200)", border: "1px solid #D4AF37" }}>
            <Shield size={32} className="text-[#D4AF37] mx-auto mb-4" />
            <h2 className="text-2xl font-black text-white mb-3" style={{ letterSpacing: "-0.02em" }}>Register Your Ownership</h2>
            <p className="text-[#B8A060] text-sm max-w-md mx-auto mb-6">
              Claiming ownership of your graded card links it to your identity — making it much easier to prove provenance if your card is ever stolen or disputed.
            </p>
            <a
              href="/claim"
              className="inline-block px-8 py-3 rounded-xl font-bold text-[#1A1400] text-sm transition-all"
              style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            >
              Claim Your Card
            </a>
          </section>

        </div>
      </div>
  );
}

// ── Report form component ──────────────────────────────────────────────────────

function ReportForm() {
  const [certId, setCertId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/stolen/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certId: certId.trim().toUpperCase(), reporterName: name, reporterEmail: email, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit report");
      setDone(true);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded-xl p-6 text-center max-w-md">
        <CheckCircle size={24} className="text-emerald-500 mx-auto mb-3" />
        <p className="font-bold text-[#1A1A1A] mb-1">Report Submitted</p>
        <p className="text-sm text-[#666666]">Check your inbox — we've sent a verification link to <strong>{email}</strong>. Click it to confirm and flag the certificate.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      <div>
        <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Certificate ID *</label>
        <input
          required
          value={certId}
          onChange={e => setCertId(e.target.value)}
          placeholder="e.g. MV1 or MV-0000000001"
          className="w-full border border-[#E8E4DC] rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
        />
      </div>
      <div>
        <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Your Name *</label>
        <input
          required
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Full name"
          className="w-full border border-[#E8E4DC] rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
        />
      </div>
      <div>
        <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Your Email *</label>
        <input
          required
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full border border-[#E8E4DC] rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
        />
        <p className="text-xs text-[#AAAAAA] mt-1">We'll send a verification link here.</p>
      </div>
      <div>
        <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Description (optional)</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Briefly describe how the card was stolen"
          rows={3}
          className="w-full border border-[#E8E4DC] rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37] resize-none"
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="px-6 py-3 rounded-xl font-bold text-sm text-white disabled:opacity-50 transition-all"
        style={{ background: "linear-gradient(135deg,#c0392b,#e74c3c)" }}
      >
        {submitting ? "Submitting…" : "Submit Report"}
      </button>
    </form>
  );
}
