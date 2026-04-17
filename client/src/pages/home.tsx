import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  Truck, ClipboardList, Package, Search, Wifi,
  Zap, Shield, Plus, Home, CreditCard, CheckCircle,
  ChevronDown, Star, ArrowRight, ShoppingCart, Scan,
  Upload, Sparkles, FileCheck
} from "lucide-react";
import SeoHead from "@/components/seo-head";
import SiteHeader from "@/components/header";
import FadeIn from "@/components/fade-in";

/* ── 3D slab tilt ───────────────────────────────────────────────────── */
function SlabTilt({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const glareRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useRef(typeof window !== "undefined" && window.matchMedia("(hover: none)").matches);

  useEffect(() => {
    if (isMobile.current) return;
    const el = containerRef.current;
    const glare = glareRef.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (rect.width / 2);
      const dy = (e.clientY - cy) / (rect.height / 2);
      const maxDeg = 6;
      el.style.transform = `perspective(700px) rotateY(${dx * maxDeg}deg) rotateX(${-dy * maxDeg}deg)`;
      if (glare) {
        glare.style.opacity = "1";
        const gx = 50 + dx * 30;
        const gy = 50 + dy * 30;
        glare.style.background = `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.18) 0%, transparent 65%)`;
      }
    };

    const onLeave = () => {
      el.style.transform = "perspective(700px) rotateY(0deg) rotateX(0deg)";
      if (glare) glare.style.opacity = "0";
    };

    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div ref={containerRef} className="slab-tilt-container relative">
      {children}
      <div ref={glareRef} className="slab-glare" />
    </div>
  );
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  return (
    <div className="bg-white text-[#1A1A1A] font-sans overflow-x-hidden min-h-screen">
      <SeoHead
        title="MintVault - UK Card Grading with Verified Ownership | VaultLock™ NFC Slabs"
        description="The only UK card grading service with a verified ownership registry. VaultLock™ NFC slabs, VaultLink™ QR authentication, and ownership certificates. Submit today."
        canonical="https://mintvaultuk.com/"
      />

      <SiteHeader />

      <main className="pb-24">

        {/* ── Hero ──────────────────────────────────────────────────── */}
        <section className="relative min-h-[85vh] flex flex-col items-center justify-center px-6 overflow-hidden bg-[#FAFAF8] border-b border-[#E8E4DC]">

          <div className="max-w-4xl w-full text-center relative z-10">

            {/* Eyebrow badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-[#D4AF37]/40 bg-[#D4AF37]/08 mb-8">
              <CheckCircle size={13} className="text-[#D4AF37]" />
              <span className="text-[#B8960C] text-[10px] uppercase tracking-[0.2em] font-bold">UK's Only Verified Ownership Grader</span>
            </div>

            <h1 className="text-4xl md:text-6xl font-black tracking-tight text-[#0F0F0F] mb-6 leading-[1.05]">
              THE ONLY UK GRADER WITH<br />
              <span style={{ color: "#D4AF37" }}>VERIFIED OWNERSHIP</span>
            </h1>

            <p className="text-lg md:text-xl text-[#555555] max-w-2xl mx-auto mb-10 font-medium leading-relaxed">
              Every graded card gets a VaultLock™ NFC slab, a VaultLink™ QR-verified certificate, and a registered ownership record. Prove who owns your card at any point in time.
            </p>

            <div className="flex flex-col md:flex-row gap-4 justify-center items-center mb-14">
              <Link href="/submit">
                <button className="btn-gold w-full md:w-auto px-10 py-4 rounded-xl uppercase tracking-widest text-sm inline-flex items-center gap-2 justify-center">
                  Submit Cards <ArrowRight size={14} />
                </button>
              </Link>
              <Link href="/cert">
                <button className="relative z-[3] w-full md:w-auto px-10 py-4 rounded-xl bg-transparent border border-[#1A1A1A]/30 text-[#1A1A1A] font-bold uppercase tracking-widest text-sm hover:border-[#B8960C] hover:text-[#B8960C] transition-colors inline-flex items-center gap-2 justify-center">
                  Verify <ArrowRight size={14} />
                </button>
              </Link>
            </div>

            {/* Trust bar */}
            <div className="reveal-on-scroll grid grid-cols-2 md:grid-cols-4 gap-4 pt-8 border-t border-[#E8E4DC]">
              {[
                { icon: <Shield size={16} className="text-[#B8960C]" />, label: "UK-Based Facility" },
                { icon: <Wifi size={16} className="text-[#B8960C]" />, label: "VaultLock™ NFC Slabs" },
                { icon: <Truck size={16} className="text-[#B8960C]" />, label: "Royal Mail Insured" },
                { icon: <CheckCircle size={16} className="text-[#B8960C]" />, label: "Verified Ownership Registry" },
              ].map(({ icon, label }) => (
                <div key={label} className="flex items-center justify-center gap-2">
                  {icon}
                  <span className="text-xs uppercase tracking-widest font-bold text-[#777777]">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── AI Pre-Grade Checker CTA ──────────────────────────────── */}
        <section className="py-16 md:py-20 px-6 bg-white border-b border-[#E8E4DC] relative overflow-hidden">
          {/* Gold accent lines */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#D4AF37]/30 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#D4AF37]/30 to-transparent" />
          <div className="max-w-2xl mx-auto text-center space-y-5">
            <div>
              <p className="text-[#B8960C] text-[10px] font-black uppercase tracking-[0.3em] mb-3">AI-Powered</p>
              <h2 className="text-3xl md:text-4xl font-black text-[#1A1A1A] leading-tight">
                AI Pre-Grade Checker
              </h2>
              <p className="text-[#555555] text-base mt-3">Upload a photo. Get an instant AI condition report.</p>
            </div>

            {/* 3-step flow */}
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                { icon: <Upload size={30} strokeWidth={1.5} />, label: "Upload Photo" },
                { icon: <Sparkles size={30} strokeWidth={1.5} />, label: "AI Analyses" },
                { icon: <FileCheck size={30} strokeWidth={1.5} />, label: "Get Results" },
              ].map(({ icon, label }) => (
                <div key={label} className="flex flex-col items-center gap-2">
                  <div className="flex items-center justify-center" style={{ color: "#B8860B" }}>{icon}</div>
                  <p className="text-[#888888] text-[11px] font-semibold uppercase tracking-wider">{label}</p>
                </div>
              ))}
            </div>

            <div className="flex justify-center">
              <Link href="/tools/estimate">
                <button className="btn-gold w-full sm:w-auto sm:px-16 flex items-center justify-center py-5 rounded-2xl text-lg uppercase tracking-widest">
                  Grade My Card
                </button>
              </Link>
            </div>
            <p className="text-[#888888] text-xs">First estimate free — no account needed</p>
          </div>
        </section>

        {/* ── How It Works summary ─────────────────────────────────── */}
        <section className="py-10 md:py-16 px-6 bg-white border-b border-[#E8E4DC]">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-10">
              <p className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3">Simple Process</p>
              <h2 className="text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A]">
                How It Works
              </h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {[
                { icon: <ShoppingCart size={20} className="text-[#B8960C]" />, step: "01", title: "Choose a tier", desc: "Pick your grading speed — Grading from £19/card." },
                { icon: <Package size={20} className="text-[#B8960C]" />, step: "02", title: "Post your cards", desc: "Send to our Rochester facility via insured post." },
                { icon: <Scan size={20} className="text-[#B8960C]" />, step: "03", title: "We grade them", desc: "6400 DPI scans, AI analysis, expert assessment." },
                { icon: <Truck size={20} className="text-[#B8960C]" />, step: "04", title: "Delivered back", desc: "VaultLock™ NFC slab + insured tracked Royal Mail return." },
              ].map(({ icon, step, title, desc }, i) => (
                <FadeIn key={step} delay={i * 100}>
                  <div className="flex flex-col items-center text-center gap-3 p-5 rounded-2xl bg-white card-elevated">
                    <div className="w-12 h-12 rounded-2xl bg-[#FFF9E6] border border-[#D4AF37]/30 flex items-center justify-center">
                      {icon}
                    </div>
                    <div>
                      <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest mb-0.5">Step {step}</p>
                      <p className="font-bold text-[#1A1A1A] text-sm">{title}</p>
                      <p className="text-[#888888] text-xs mt-1 leading-relaxed">{desc}</p>
                    </div>
                  </div>
                </FadeIn>
              ))}
            </div>
            <div className="text-center mt-8">
              <Link href="/how-it-works">
                <button className="inline-flex items-center gap-2 text-[#B8960C] font-semibold text-sm hover:text-[#D4AF37] transition-colors">
                  Learn more about our process <ArrowRight size={14} />
                </button>
              </Link>
            </div>
          </div>
        </section>

        {/* ── How Ownership Works ───────────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 bg-[#FAFAF8] border-b border-[#E8E4DC]">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-12">
              <p className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3">What Makes Us Different</p>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A]">
                The Ownership Journey
              </h2>
              <p className="text-[#555555] mt-3 max-w-xl mx-auto text-sm">
                We're the only UK grader that can prove who owns a card at any point in time — combining VaultLock™, VaultLink™, and a registered ownership record.
              </p>
            </div>
            <div className="flex flex-col md:flex-row items-start gap-0 md:gap-0">
              {[
                { step: "01", title: "Submit", desc: "Send your cards to our UK facility via insured post." },
                { step: "02", title: "Grade", desc: "Expert grading on our professional 1–10 scale." },
                { step: "03", title: "Claim", desc: "Use your one-time claim code to register ownership." },
                { step: "04", title: "Own", desc: "Receive your VaultLock™ NFC slab and ownership certificate PDF." },
                { step: "05", title: "Transfer", desc: "Sell with confidence — transfer ownership via email verification." },
              ].map(({ step, title, desc }, i, arr) => (
                <div key={step} className="flex md:flex-col items-center md:items-center flex-1 gap-4 md:gap-0 mb-6 md:mb-0">
                  <div className="flex flex-col md:flex-row items-center w-full md:w-auto">
                    <div className="w-10 h-10 rounded-full bg-[#D4AF37] flex items-center justify-center text-[#1A1400] font-black text-xs flex-shrink-0">
                      {step}
                    </div>
                    {i < arr.length - 1 && (
                      <div className="hidden md:block h-px flex-1 bg-[#D4AF37]/30 mx-3" style={{ minWidth: "20px" }} />
                    )}
                  </div>
                  <div className="text-left md:text-center md:mt-4 md:px-2">
                    <p className="font-bold text-[#1A1A1A] text-sm">{title}</p>
                    <p className="text-[#555555] text-xs mt-1 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Slab Showcase ─────────────────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 overflow-hidden bg-white border-b border-[#E8E4DC]">
          <div className="relative z-[3] max-w-5xl mx-auto bg-[#FAFAF8] rounded-3xl border border-[#E8E4DC]" style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
            <div className="flex flex-col lg:flex-row items-center gap-12 p-8 lg:p-14">

              {/* Left — copy */}
              <div className="flex-1 text-center lg:text-left">
                <span className="reveal-on-scroll text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-4 block">The MintVault Slab</span>
                <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight leading-tight mb-6 text-[#1A1A1A]">
                  Engineered for<br /><span className="gold-shimmer-text">Permanence</span>
                </h2>
                <p className="reveal-on-scroll text-[#555555] text-base leading-relaxed mb-8 max-w-md mx-auto lg:mx-0">
                  Every MintVault slab is precision-manufactured with VaultGlass™ UV-resistant acrylic and a MintSeal™ tamper-evident seal. Your card is protected for decades, not years.
                </p>
                <div className="reveal-on-scroll flex flex-wrap gap-2 justify-center lg:justify-start">
                  {["VaultLock™", "VaultGlass™", "MintSeal™", "VaultLink™"].map((f) => (
                    <span key={f} className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full bg-[#FFF9E6] border border-[#D4AF37]/30 text-[#B8960C]">
                      {f}
                    </span>
                  ))}
                </div>
              </div>

              {/* Right — slab photo */}
              <div className="flex-1 flex items-center justify-center relative">
                <SlabTilt>
                  <div style={{ animation: "slabFloat 5s ease-in-out infinite" }} className="relative">
                    <img
                      src="/images/premium-slab-closeup.webp"
                      alt="MintVault graded card slab — UV-resistant acrylic with NFC chip"
                      className="w-[240px] h-auto rounded-xl object-cover"
                      style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.15)" }}
                    />
                  </div>
                </SlabTilt>
                {/* Callout annotations */}
                <div className="absolute top-10 -left-4 lg:-left-16 flex items-center gap-2">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[#888888] whitespace-nowrap">UV-Resistant</span>
                  <div className="h-px w-8 bg-[#D4AF37]/40" />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]/60" />
                </div>
                <div className="absolute top-1/3 -right-2 lg:-right-16 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]/60" />
                  <div className="h-px w-8 bg-[#D4AF37]/40" />
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[#888888] whitespace-nowrap">VaultLock™</span>
                </div>
                <div className="absolute bottom-16 -left-4 lg:-left-16 flex items-center gap-2">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[#888888] whitespace-nowrap">VaultLink™</span>
                  <div className="h-px w-8 bg-[#D4AF37]/40" />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]/60" />
                </div>
                <div className="absolute bottom-4 -right-2 lg:-right-20 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]/60" />
                  <div className="h-px w-8 bg-[#D4AF37]/40" />
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[#888888] whitespace-nowrap">Tamper-Evident</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Features ──────────────────────────────────────────────── */}
        <section className="py-16 md:py-20 px-6 bg-white border-b border-[#E8E4DC]">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-12">
              <p className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3">Why Collectors Choose MintVault</p>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A]">
                The MintVault Advantage
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-5">

              {/* NFC — 7 cols */}
              <div className="reveal-on-scroll md:col-span-7 glass-card p-8 rounded-2xl relative overflow-hidden group" data-delay="1">
                <h3 className="text-xl font-bold mb-3 text-[#1A1A1A]">VaultLock™ &amp; VaultLink™</h3>
                <p className="text-[#555555] max-w-sm mb-6 text-sm leading-relaxed">
                  Every slab contains a VaultLock™ NFC chip. Instant verification with no app required. Tap and prove authenticity in seconds.
                </p>
                <div className="absolute -bottom-4 -right-4 group-hover:scale-110 transition-transform duration-700">
                  <div className="nfc-pulse w-20 h-20 flex items-center justify-center">
                    <Wifi size={60} className="text-[#D4AF37]/20" />
                  </div>
                </div>
              </div>

              {/* No Conflict — 5 cols */}
              <div className="reveal-on-scroll md:col-span-5 glass-card p-8 rounded-2xl flex flex-col justify-between" data-delay="2">
                <div>
                  <Shield size={28} className="text-[#D4AF37] mb-4" />
                  <h3 className="text-xl font-bold mb-2 text-[#1A1A1A]">No Conflict of Interest</h3>
                  <p className="text-[#555555] text-sm leading-relaxed">
                    We do not buy, sell, or trade cards. Our grading is purely technical, unbiased, and objective. Every time.
                  </p>
                </div>
              </div>

              {/* Ownership Registry — 5 cols */}
              <div className="reveal-on-scroll md:col-span-5 glass-card p-8 rounded-2xl" data-delay="3">
                <h3 className="text-xl font-bold mb-5 text-[#1A1A1A]">Ownership Registry</h3>
                <ul className="space-y-3 font-mono">
                  {[["REGISTERED OWNER","You"],["CERTIFICATE","Verifiable"],["TRANSFER","Email Verified"],["STATUS","Active"]].map(([label, val], i, arr) => (
                    <li key={label} className={`flex justify-between text-xs pb-2 ${i < arr.length - 1 ? "border-b border-[#E8E4DC]" : ""}`}>
                      <span className="text-[#555555]">{label}</span>
                      <span className="text-[#D4AF37] font-bold">{val}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Fast Turnaround — 7 cols */}
              <div
                className="reveal-on-scroll md:col-span-7 p-8 rounded-2xl flex items-center justify-between bg-white border border-[#D4AF37]/30"
                data-delay="4"
              >
                <div className="text-[#1A1A1A]">
                  <h3 className="text-2xl font-black mb-2 tracking-tight">Fast UK Turnaround</h3>
                  <p className="font-medium text-[#555555] text-sm">5 to 40 working days depending on tier. No international shipping delays.</p>
                </div>
                <Zap size={56} className="text-[#D4AF37]/20 flex-shrink-0" />
              </div>
            </div>
          </div>
        </section>

        {/* ── Your Card, Provably Yours ─────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 bg-[#FFF9E6] border-b border-[#D4AF37]/20">
          <div className="max-w-5xl mx-auto flex flex-col lg:flex-row items-center gap-12">
            <div className="flex-1">
              <p className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-4">Ownership Registry</p>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A] mb-6">
                Your Card,<br />Provably Yours
              </h2>
              <p className="text-[#555555] leading-relaxed mb-6">
                Every MintVault-graded card is registered in our ownership registry. When you claim your card, you become the verified owner — with a certificate of authenticity emailed to you.
              </p>
              <p className="text-[#555555] leading-relaxed mb-8">
                When you sell, you transfer ownership through a two-step email-verified process. The new owner gets their own certificate. The registry is permanent and tamper-proof.
              </p>
              <div className="flex gap-3 flex-wrap">
                <Link href="/claim">
                  <button className="gold-shimmer px-6 py-3 rounded-xl text-[#1A1400] font-bold text-sm uppercase tracking-widest">
                    Claim Ownership
                  </button>
                </Link>
                <Link href="/ownership">
                  <button className="px-6 py-3 rounded-xl border border-[#D4AF37]/50 bg-white text-[#B8960C] font-bold text-sm uppercase tracking-widest hover:bg-[#FFF9E6] transition-colors">
                    Learn More
                  </button>
                </Link>
              </div>
            </div>
            <div className="flex-1">
              <div className="bg-white rounded-2xl border border-[#D4AF37]/20 p-6" style={{ boxShadow: "0 4px 20px rgba(212,175,55,0.12)" }}>
                {[
                  { label: "Certificate ID", value: "MV-0000000042", gold: true },
                  { label: "Card", value: "Charizard Base Set" },
                  { label: "Grade", value: "9 — Mint" },
                  { label: "Owner", value: "Registered & Verified" },
                  { label: "Registry Status", value: "✓ Claimed", green: true },
                  { label: "NFC Status", value: "✓ Active" },
                ].map(({ label, value, gold, green }) => (
                  <div key={label} className="flex justify-between items-center py-2.5 border-b border-[#E8E4DC] last:border-0">
                    <span className="text-[#888888] text-sm">{label}</span>
                    <span className={`text-sm font-semibold ${gold ? "text-[#D4AF37] font-mono" : green ? "text-emerald-600" : "text-[#1A1A1A]"}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Stolen Card Protection ───────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 bg-white border-b border-[#E8E4DC]">
          <div className="max-w-5xl mx-auto flex flex-col lg:flex-row items-center gap-12">
            <div className="flex-1">
              <p className="text-red-500 font-bold uppercase tracking-[0.3em] text-[10px] mb-4">Theft Protection</p>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A] mb-6">
                Stolen? We'll<br />Flag It Instantly.
              </h2>
              <p className="text-[#555555] leading-relaxed mb-6">
                If your graded card is stolen, report it to our registry and we'll flag its certificate. Any buyer who scans the VaultLink™ QR code or VaultLock™ NFC chip on the slab sees a red warning — making fraudulent resale much harder.
              </p>
              <p className="text-[#555555] leading-relaxed mb-8">
                Reports are email-verified to prevent false flags. Once confirmed, the warning is live instantly — no delay, no gatekeeping.
              </p>
              <Link href="/stolen-card-protection">
                <button className="px-6 py-3 rounded-xl border border-red-400/50 bg-red-50 text-red-600 font-bold text-sm uppercase tracking-widest hover:bg-red-100 transition-colors">
                  Learn About Stolen Protection
                </button>
              </Link>
            </div>
            <div className="flex-1">
              <div className="rounded-2xl border border-red-200 p-6 bg-red-50" style={{ boxShadow: "0 4px 20px rgba(200,50,50,0.07)" }}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs font-bold uppercase tracking-widest text-red-600">Stolen Alert Active</span>
                </div>
                {[
                  { label: "Certificate ID", value: "MV-0000000099", gold: true },
                  { label: "Card", value: "Charizard 1st Edition" },
                  { label: "Grade", value: "8 — Very Good–Mint" },
                  { label: "Status", value: "⚠ Reported Stolen", red: true },
                  { label: "Registry", value: "Flagged — do not buy" },
                ].map(({ label, value, gold, red }) => (
                  <div key={label} className="flex justify-between items-center py-2.5 border-b border-red-100 last:border-0">
                    <span className="text-[#888888] text-sm">{label}</span>
                    <span className={`text-sm font-semibold ${gold ? "text-[#D4AF37] font-mono" : red ? "text-red-600 font-bold" : "text-[#1A1A1A]"}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Grading Process ───────────────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 bg-white border-b border-[#E8E4DC]">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-12">
              <p className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3">The Process</p>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A]">
                How It Works
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[
                { step: "01", Icon: ClipboardList, title: "Submit Online",  desc: "Fill our digital submission form. Select your service level and insurance requirements.", href: "/submit" },
                { step: "02", Icon: Package,       title: "Post Insured",   desc: "Send via Royal Mail Special Delivery to our UK facility. Fully insured transit.", href: "/pricing" },
                { step: "03", Icon: Search,        title: "Expert Grading", desc: "Our graders analyse centering, surface, edges, and corners with precision.", href: "/why-mintvault#grading-scale" },
                { step: "04", Icon: Wifi,          title: "Tap-To-Verify",  desc: "Receive your VaultLock™ NFC slab. Tap to verify the grade, ownership, and authenticity.", href: "/cert" },
              ].map(({ step, Icon, title, desc, href }, i) => (
                <Link key={step} href={href}>
                  <div className="reveal-on-scroll glass-card p-6 rounded-2xl cursor-pointer h-full" data-delay={String(i + 1)}>
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center mb-5 flex-shrink-0"
                      style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}
                    >
                      <Icon size={20} className="text-[#3c2f00]" />
                    </div>
                    <div className="font-mono text-[#D4AF37] text-xs mb-2">STEP {step}</div>
                    <h3 className="text-sm font-bold mb-2 text-[#1A1A1A] uppercase tracking-tight">{title}</h3>
                    <p className="text-[#555555] text-xs leading-relaxed">{desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* ── Pricing CTA ───────────────────────────────────────────── */}
        <section className="py-8 md:py-16 px-6 bg-[#FAFAF8] border-b border-[#E8E4DC]">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="reveal-on-scroll text-3xl font-black tracking-tight text-[#1A1A1A] mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-[#555555] mb-8 max-w-xl mx-auto">
              From £19 per card. All tiers include grading, labelling, encapsulation, and fully insured Royal Mail return. Bulk discounts from 10 cards.
            </p>
            <div className="flex gap-4 justify-center">
              <Link href="/pricing">
                <button className="gold-shimmer px-8 py-3.5 rounded-xl text-[#1A1400] font-bold uppercase tracking-widest text-sm">
                  View Pricing
                </button>
              </Link>
              <Link href="/submit">
                <button className="flex items-center gap-2 px-8 py-3.5 rounded-xl border border-[#D4AF37]/40 text-[#B8960C] font-bold uppercase tracking-widest text-sm hover:bg-[#FFF9E6] transition-colors">
                  Submit Now <ArrowRight size={14} />
                </button>
              </Link>
            </div>
          </div>
        </section>

        {/* ── Comparison ────────────────────────────────────────────── */}
        <section className="py-10 md:py-20 px-6 bg-[#FAFAF8] border-b border-[#E8E4DC]">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-12">
              <span className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3 block">Why Switch</span>
              <h2 className="reveal-on-scroll text-3xl md:text-4xl font-black tracking-tight text-[#1A1A1A]">
                The Clear Choice
              </h2>
              <p className="text-[#555555] text-sm mt-4 max-w-xl mx-auto">
                UK collectors deserve a grading service built for them — not one built for another market and shipped internationally.
              </p>
            </div>

            <div className="reveal-on-scroll overflow-x-auto bg-white rounded-2xl border border-[#E8E4DC] p-1" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
              <table className="w-full min-w-[480px]">
                <thead>
                  <tr>
                    <th className="text-left pb-4 pt-4 px-4 text-[#888888] text-xs uppercase tracking-widest font-bold w-[40%]">Feature</th>
                    <th className="pb-4 pt-4 text-center">
                      <div className="inline-flex flex-col items-center gap-1">
                        <span className="text-[#D4AF37] font-black text-sm uppercase tracking-widest">MintVault</span>
                        <span className="text-[#888888] text-[10px] font-mono">UK-BASED</span>
                      </div>
                    </th>
                    <th className="pb-4 pt-4 text-center">
                      <div className="inline-flex flex-col items-center gap-1">
                        <span className="text-[#555555] font-bold text-sm uppercase tracking-widest">Other UK Graders</span>
                        <span className="text-[#888888] text-[10px] font-mono">DOMESTIC</span>
                      </div>
                    </th>
                    <th className="pb-4 pt-4 text-center">
                      <div className="inline-flex flex-col items-center gap-1">
                        <span className="text-[#555555] font-bold text-sm uppercase tracking-widest">International</span>
                        <span className="text-[#888888] text-[10px] font-mono">OVERSEAS</span>
                      </div>
                    </th>
                  </tr>
                  <tr>
                    <td colSpan={4} className="pb-2 px-4">
                      <div className="h-px bg-[#E8E4DC]" />
                    </td>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["VaultLock™ Verification",         "✓", "✗", "✗"],
                    ["UK-Based Grading Facility",       "✓", "✓", "✗"],
                    ["No Conflict of Interest",         "✓", "~", "~"],
                    ["Flat Transparent Pricing",        "✓", "~", "✗"],
                    ["VaultLink™ QR Authentication",    "✓", "✓", "✗"],
                    ["Insured Return Shipping (Royal Mail)", "✓", "✓", "✗"],
                    ["Insurance Included",              "✓", "~", "✗"],
                    ["No Value Upcharges",              "✓", "✗", "✗"],
                    ["15-Day Standard Turnaround",      "✓", "~", "✗"],
                    ["No Import / Customs Risk",        "✓", "✓", "✗"],
                    ["Verified Ownership Registry",     "✓", "✗", "✗"],
                  ].map(([feature, mv, uk, intl], i) => (
                    <tr key={i} className={i % 2 === 0 ? "bg-[#FAFAF8]" : "bg-white"}>
                      <td className="py-3 px-4 text-[#555555] text-sm rounded-l-lg">{feature}</td>
                      <td className="py-3 text-center text-base font-bold">
                        <span className={mv === "✓" ? "compare-check" : mv === "~" ? "compare-partial" : "compare-cross"}>
                          {mv === "✓" ? "✓" : mv === "~" ? "◐" : "✗"}
                        </span>
                      </td>
                      <td className="py-3 text-center text-base font-bold">
                        <span className={uk === "✓" ? "compare-partial" : uk === "~" ? "compare-partial" : "compare-cross"}>
                          {uk === "✓" ? "✓" : uk === "~" ? "◐" : "✗"}
                        </span>
                      </td>
                      <td className="py-3 text-center text-base font-bold rounded-r-lg">
                        <span className={intl === "✓" ? "compare-partial" : intl === "~" ? "compare-partial" : "compare-cross"}>
                          {intl === "✓" ? "✓" : intl === "~" ? "◐" : "✗"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-center mt-6">
              <span className="text-[#888888] text-[10px] font-mono">✓ confirmed · ◐ partial / varies · ✗ not available</span>
            </div>
          </div>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────────── */}
        <section className="py-20 px-6 bg-white">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-12">
              <span className="text-[#B8960C] font-bold uppercase tracking-[0.3em] text-[10px] mb-3 block">Got Questions</span>
              <h2 className="reveal-on-scroll text-3xl font-black tracking-tight text-[#1A1A1A]">
                Frequently Asked
              </h2>
            </div>

            <div className="reveal-on-scroll space-y-2">
              {[
                {
                  q: "How long does grading take?",
                  a: "Vault Queue is 40 working days, Standard is 15 working days, and Express is 5 working days — all from the date we receive your cards. You'll receive email updates at each stage — received, graded, and dispatched.",
                },
                {
                  q: "What does the pricing include?",
                  a: "All tiers include grading, label production, slab encapsulation, and fully insured Royal Mail Special Delivery return shipping. There are no hidden fees. Grading starts at £19 per card.",
                },
                {
                  q: "How does VaultLock™ verification work?",
                  a: "Every slab contains a VaultLock™ NFC chip. Simply tap your phone to the chip area — any modern iOS or Android device instantly opens the certificate page showing grade, certificate details, and ownership status. No app required.",
                },
                {
                  q: "How does the ownership registry work?",
                  a: "After you receive your graded slab, you use a one-time claim code (included with your submission) to register as the owner. Your name is recorded in our registry and you receive a certificate of authenticity by email. When you sell the card, you transfer ownership via a two-step email-verified process.",
                },
                {
                  q: "Do you accept international submissions?",
                  a: "Yes. We accept submissions from collectors worldwide. Return shipping to international addresses is fully insured via tracked courier. Contact us for a return shipping quote before submitting.",
                },
                {
                  q: "What cards do you grade?",
                  a: "We grade all trading cards including Pokémon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, sports cards, and more. If you're unsure whether your card qualifies, email us before submitting.",
                },
              ].map(({ q, a }, i) => (
                <div key={i} className="glass-card rounded-xl overflow-hidden">
                  <button
                    onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                    className="w-full flex items-center justify-between px-6 py-5 text-left hover:bg-[#FAFAF8] transition-colors"
                  >
                    <span className="text-[#1A1A1A] text-sm font-semibold pr-6">{q}</span>
                    <ChevronDown
                      size={16}
                      className={`text-[#D4AF37] shrink-0 transition-transform duration-300 ${faqOpen === i ? "rotate-180" : ""}`}
                    />
                  </button>
                  {faqOpen === i && (
                    <div className="px-6 pb-5 text-[#555555] text-sm leading-relaxed border-t border-[#E8E4DC] pt-4">
                      {a}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── What We Grade ticker ──────────────────────────────────── */}
        <section className="py-16 bg-[#FAFAF8] border-t border-[#E8E4DC] overflow-hidden">
          <div className="max-w-7xl mx-auto px-6">
            <div className="flex gap-16 items-center opacity-60 animate-[scroll_25s_linear_infinite] whitespace-nowrap">
              {[
                "Pokémon", "Sports Cards", "Yu-Gi-Oh!", "One Piece", "Magic: The Gathering",
                "Pokémon", "Sports Cards", "Yu-Gi-Oh!", "One Piece", "Magic: The Gathering",
              ].map((name, i) => (
                <div key={i} className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[#D4AF37] text-base">✦</span>
                  <span className="text-xl font-black uppercase tracking-tighter text-[#1A1A1A]">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

      </main>

      {/* ── Mobile Bottom Nav ─────────────────────────────────────── */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center h-16 px-4 bg-white/95 backdrop-blur-xl border-t border-[#E8E4DC] md:hidden">
        <Link href="/" className="flex flex-col items-center justify-center text-[#B8960C]">
          <Home size={20} />
          <span className="text-[9px] uppercase tracking-widest mt-1 text-[#555555]">Home</span>
        </Link>
        <Link href="/cert" className="flex flex-col items-center justify-center">
          <CheckCircle size={20} className="text-[#888888]" />
          <span className="text-[9px] uppercase tracking-widest mt-1 text-[#888888]">Verify</span>
        </Link>
        <Link href="/pricing" className="flex flex-col items-center justify-center">
          <CreditCard size={20} className="text-[#888888]" />
          <span className="text-[9px] uppercase tracking-widest mt-1 text-[#888888]">Pricing</span>
        </Link>
        <Link href="/dashboard" className="flex flex-col items-center justify-center">
          <ClipboardList size={20} className="text-[#888888]" />
          <span className="text-[9px] uppercase tracking-widest mt-1 text-[#888888]">Dashboard</span>
        </Link>
      </nav>

      {/* ── Mobile FAB ────────────────────────────────────────────── */}
      <div className="fixed bottom-20 right-5 md:hidden z-40">
        <Link href="/submit">
          <button className="gold-shimmer w-12 h-12 rounded-full flex items-center justify-center text-[#1A1400] active:scale-90 transition-transform">
            <Plus size={24} />
          </button>
        </Link>
      </div>

    </div>
  );
}
