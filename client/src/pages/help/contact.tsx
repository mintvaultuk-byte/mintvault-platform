import { useState } from "react";
import { Mail, MapPin, Clock, Instagram, Facebook, AlertCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";
import { COMPANY, formatPostalAddress } from "@shared/company";
import { apiRequest } from "@/lib/queryClient";

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      // The form's <select name="subject"> already uses canonical topic
      // values (submission / grading / cert-vault / ownership /
      // returns-shipping / payment / other) matching the server zod schema.
      await apiRequest("POST", "/api/contact", {
        name: form.name,
        email: form.email,
        topic: form.subject,
        message: form.message,
      });
      setSubmitted(true);
    } catch (err: any) {
      // 4xx / 5xx / network. Surface a generic actionable message; the
      // exact server-side validation detail (if 400) is logged but not
      // pushed to the customer to keep the UI simple.
      setErrorMessage(
        "Couldn't send your message. Please email hello@mintvaultuk.com directly or try again."
      );
      console.error("[contact-form] submit failed:", err?.message || err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <SeoHead
        title="Contact Us | MintVault UK"
        description="Get in touch with the MintVault team. Questions about grading, submissions, or your certificate? We aim to respond within 24 hours."
        canonical="/help/contact"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-20 text-center">
          <p className="text-[#FFCB05] text-xs font-bold uppercase tracking-[0.25em] mb-4">Help</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
            Contact Us
          </h1>
          <p className="text-lg text-[#666666]">We'd love to hear from you</p>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-12">

          {/* Contact form — 3/5 */}
          <div className="md:col-span-3">
            <p className="text-[#FFCB05] text-xs font-bold uppercase tracking-[0.2em] mb-6">Send a Message</p>

            {submitted ? (
              <div className="p-8 rounded-2xl bg-[#FFF9E6] border border-[#FFCB05]/30 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-[#FFCB05]/20 border border-[#FFCB05]/30 flex items-center justify-center mx-auto">
                  <Mail size={20} className="text-[#FFCB05]" />
                </div>
                <p className="font-bold text-[#1A1A1A] text-lg">Message sent</p>
                <p className="text-[#666666] text-sm">Thanks for getting in touch. We'll get back to you within 24 hours during business days.</p>
                <button
                  onClick={() => { setSubmitted(false); setErrorMessage(null); setForm({ name: "", email: "", subject: "", message: "" }); }}
                  className="text-[#FFCB05] text-sm font-semibold hover:underline mt-2"
                >
                  Send another message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-[#888] mb-2">Name</label>
                    <input
                      type="text"
                      name="name"
                      value={form.name}
                      onChange={handleChange}
                      required
                      placeholder="Your name"
                      className="w-full px-4 py-3 rounded-xl border border-[#E8E4DC] bg-white text-[#1A1A1A] text-sm placeholder:text-[#BBBBBB] focus:outline-none focus:border-[#FFCB05] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-[#888] mb-2">Email</label>
                    <input
                      type="email"
                      name="email"
                      value={form.email}
                      onChange={handleChange}
                      required
                      placeholder="your@email.com"
                      className="w-full px-4 py-3 rounded-xl border border-[#E8E4DC] bg-white text-[#1A1A1A] text-sm placeholder:text-[#BBBBBB] focus:outline-none focus:border-[#FFCB05] transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#888] mb-2">Subject</label>
                  <select
                    name="subject"
                    value={form.subject}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-3 rounded-xl border border-[#E8E4DC] bg-white text-[#1A1A1A] text-sm focus:outline-none focus:border-[#FFCB05] transition-colors"
                  >
                    <option value="" disabled>Select a topic</option>
                    <option value="submission">Submission enquiry</option>
                    <option value="grading">Grading question</option>
                    <option value="cert-vault">Certificate / Vault</option>
                    <option value="ownership">Ownership registry</option>
                    <option value="returns-shipping">Returns & shipping</option>
                    <option value="payment">Payment</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#888] mb-2">Message</label>
                  <textarea
                    name="message"
                    value={form.message}
                    onChange={handleChange}
                    required
                    rows={6}
                    placeholder="Tell us how we can help..."
                    className="w-full px-4 py-3 rounded-xl border border-[#E8E4DC] bg-white text-[#1A1A1A] text-sm placeholder:text-[#BBBBBB] focus:outline-none focus:border-[#FFCB05] transition-colors resize-none"
                  />
                </div>

                {errorMessage && (
                  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="contact-form-error">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <p className="leading-relaxed">{errorMessage}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="gold-shimmer w-full font-bold text-sm px-6 py-4 rounded-xl disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? "Sending…" : "Send Message"}
                </button>
              </form>
            )}
          </div>

          {/* Info sidebar — 2/5 */}
          <div className="md:col-span-2 space-y-8">

            {/* Direct contact */}
            <div>
              <p className="text-[#FFCB05] text-xs font-bold uppercase tracking-[0.2em] mb-5">Direct Contact</p>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FFF9E6] border border-[#FFCB05]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Mail size={15} className="text-[#FFCB05]" />
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-[#888] mb-1">Email</p>
                    <a href="mailto:hello@mintvaultuk.com" className="text-sm text-[#1A1A1A] font-medium hover:text-[#FFCB05] transition-colors">
                      hello@mintvaultuk.com
                    </a>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FFF9E6] border border-[#FFCB05]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <MapPin size={15} className="text-[#FFCB05]" />
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-[#888] mb-1">Postal address</p>
                    <p className="text-sm text-[#1A1A1A] font-medium">{COMPANY.postalAddress.displayName}</p>
                    {formatPostalAddress(COMPANY.postalAddress, { multiline: true, includeDisplayName: false })
                      .split("\n")
                      .map((line, i) => (
                        <p key={i} className="text-sm text-[#666666]">{line}</p>
                      ))}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FFF9E6] border border-[#FFCB05]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Clock size={15} className="text-[#FFCB05]" />
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-[#888] mb-1">Response Time</p>
                    <p className="text-sm text-[#1A1A1A]">We aim to respond to all enquiries within 24 hours during business days.</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Social */}
            <div>
              <p className="text-[#FFCB05] text-xs font-bold uppercase tracking-[0.2em] mb-5">Follow Us</p>
              <div className="space-y-3">
                <a
                  href="https://www.instagram.com/mint_vault/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-[#E8E4DC] bg-white hover:border-[#FFCB05]/40 transition-colors group"
                >
                  <Instagram size={16} className="text-[#888] group-hover:text-[#FFCB05] transition-colors" />
                  <span className="text-sm font-medium text-[#555555] group-hover:text-[#1A1A1A] transition-colors">@mint_vault</span>
                </a>
                <a
                  href="https://facebook.com/mintvaultuk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-[#E8E4DC] bg-white hover:border-[#FFCB05]/40 transition-colors group"
                >
                  <Facebook size={16} className="text-[#888] group-hover:text-[#FFCB05] transition-colors" />
                  <span className="text-sm font-medium text-[#555555] group-hover:text-[#1A1A1A] transition-colors">MintVault UK</span>
                </a>
                <a
                  href="https://tiktok.com/@mintvaultuk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-[#E8E4DC] bg-white hover:border-[#FFCB05]/40 transition-colors group"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[#888] group-hover:text-[#FFCB05] transition-colors">
                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.75a4.85 4.85 0 0 1-1.01-.06z"/>
                  </svg>
                  <span className="text-sm font-medium text-[#555555] group-hover:text-[#1A1A1A] transition-colors">@mintvaultuk</span>
                </a>
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
