import { Link } from "wouter";
import {
  Star, Truck, Database, ClipboardList, Package, Search, Wifi,
  Zap, Shield, Menu, Plus, Home, CreditCard, CheckCircle,
  Share2, Camera, BarChart2, Contact
} from "lucide-react";

/* ── Inline SVG icons for card-type strip ───────────────────── */
function PokemonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M2 12h20M12 2a10 10 0 0 1 8.66 5H3.34A10 10 0 0 1 12 2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" fill="none"/>
    </svg>
  );
}

export default function HomePage() {
  return (
    <div className="bg-[#131313] text-[#e5e2e1] font-sans overflow-x-hidden min-h-screen">

      {/* ── Top Nav ───────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 bg-[#131313]/80 backdrop-blur-lg border-b border-[#f2ca50]/5">
        <div className="flex items-center gap-4">
          <Menu size={22} className="text-[#f2ca50]" />
          <span className="text-xl font-bold tracking-tighter text-[#f2ca50] uppercase">MintVault</span>
        </div>
        <div className="hidden md:flex gap-8 items-center">
          <Link href="/" className="text-[#f2ca50] font-bold uppercase text-sm tracking-tight">Home</Link>
          <Link href="/cert" className="text-[#e5e2e1] hover:text-[#d4af37] transition-colors duration-300 uppercase text-sm tracking-tight">Verify</Link>
          <Link href="/why-mintvault" className="text-[#e5e2e1] hover:text-[#d4af37] transition-colors duration-300 uppercase text-sm tracking-tight">Dashboard</Link>
          <Link href="/pricing" className="text-[#e5e2e1] hover:text-[#d4af37] transition-colors duration-300 uppercase text-sm tracking-tight">Pricing</Link>
        </div>
        <Link href="/submit">
          <button className="bg-[#f2ca50] text-[#3c2f00] px-6 py-2 rounded-lg font-bold uppercase text-xs tracking-widest active:scale-95 transition-transform">
            Submit
          </button>
        </Link>
      </header>

      <main className="pt-24 pb-32">

        {/* ── Hero ──────────────────────────────────────────────────── */}
        <section className="relative min-h-[580px] flex flex-col items-center justify-center px-6 overflow-hidden">
          {/* Background light leaks */}
          <div className="absolute top-0 -left-1/4 w-[500px] h-[500px] bg-[#f2ca50]/10 blur-[120px] rounded-full pointer-events-none" />
          <div className="absolute bottom-0 -right-1/4 w-[500px] h-[500px] bg-[#d4af37]/10 blur-[120px] rounded-full pointer-events-none" />

          <div className="max-w-4xl w-full text-center relative z-10">

            {/* Eyebrow badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full border border-[#f2ca50]/20 bg-[#f2ca50]/5 mb-8">
              <CheckCircle size={14} className="text-[#f2ca50]" />
              <span className="text-[#f2ca50] text-[10px] uppercase tracking-[0.2em] font-bold">UK's #1 Technical Grader</span>
            </div>

            <h1 className="text-5xl md:text-7xl font-black tracking-tighter text-[#e5e2e1] mb-6 leading-[0.9]">
              UK'S MOST <span className="text-[#f2ca50]">TRUSTED</span> CARD GRADING SERVICE
            </h1>

            <p className="text-lg md:text-xl text-[#e5e2e1]/70 max-w-2xl mx-auto mb-12 font-medium">
              NFC-enabled slabs, QR authentication, and 100% transparent grading. Secure your legacy with the gold standard of protection.
            </p>

            <div className="flex flex-col md:flex-row gap-4 justify-center items-center mb-16">
              <Link href="/submit">
                <button
                  className="w-full md:w-auto px-10 py-5 rounded-xl text-[#3c2f00] font-black uppercase tracking-widest text-sm shadow-[0_20px_40px_rgba(242,202,80,0.2)]"
                  style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
                >
                  Submit Your Cards
                </button>
              </Link>
              <Link href="/why-mintvault#grading-scale">
                <button className="w-full md:w-auto px-10 py-5 rounded-xl border border-[#f2ca50]/20 text-[#f2ca50] font-bold uppercase tracking-widest text-sm hover:bg-[#f2ca50]/5 transition-colors">
                  View Grading Scale
                </button>
              </Link>
            </div>

            {/* Trust bar */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-8 border-t border-[#4d4635]/30">
              <div className="flex items-center justify-center gap-3">
                <div className="flex text-[#f2ca50] gap-0.5">
                  {[...Array(5)].map((_, i) => <Star key={i} size={16} fill="#f2ca50" />)}
                </div>
                <span className="text-xs uppercase tracking-widest font-bold opacity-60">Trustpilot 5-Stars</span>
              </div>
              <div className="flex items-center justify-center gap-3">
                <Database size={18} className="text-[#f2ca50]" />
                <span className="text-xs uppercase tracking-widest font-bold opacity-60">10,000+ Cards Graded</span>
              </div>
              <div className="flex items-center justify-center gap-3">
                <Truck size={18} className="text-[#f2ca50]" />
                <span className="text-xs uppercase tracking-widest font-bold opacity-60">Royal Mail Insured</span>
              </div>
            </div>
          </div>

        </section>

        {/* ── How It Works ──────────────────────────────────────────── */}
        <section className="py-24 px-6 bg-[#1c1b1b]">
          <div className="max-w-7xl mx-auto">

            <div className="flex flex-col md:flex-row justify-between items-end mb-16 gap-4">
              <div className="max-w-xl">
                <span className="text-[#d4af37] font-bold uppercase tracking-[0.3em] text-[10px] mb-4 block">The Process</span>
                <h2 className="text-4xl md:text-5xl font-black tracking-tighter leading-none">
                  HOW THE VAULT <span className="text-[#ffe088]">PROTECTS</span> YOU
                </h2>
              </div>
              <div className="text-[#e5e2e1]/40 font-mono text-xs uppercase tracking-widest">Efficiency through technology</div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[
                { step: "01", Icon: ClipboardList, title: "Submit Online",  desc: "Fill our digital submission form. Select your service level and insurance requirements in seconds." },
                { step: "02", Icon: Package,       title: "Post Insured",   desc: "Send your assets to our UK facility via Royal Mail Special Delivery for fully insured transit." },
                { step: "03", Icon: Search,        title: "Expert Grading", desc: "Our master graders analyze centring, surface, edges, and corners under high-spec microscopy." },
                { step: "04", Icon: Wifi,          title: "Tap-To-Verify",  desc: "Receive your NFC-equipped slab. Simply tap your phone to verify the grade and authenticity." },
              ].map(({ step, Icon, title, desc }) => (
                <div
                  key={step}
                  className="flex flex-col bg-[#201f1f] p-8 rounded-2xl border border-transparent hover:border-[#f2ca50]/20 transition-all duration-500"
                >
                  {/* Icon — fixed height so all cards align */}
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 flex-shrink-0"
                    style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
                  >
                    <Icon size={22} className="text-[#3c2f00]" />
                  </div>
                  <div className="font-mono text-[#f2ca50]/40 text-xs mb-2">STEP {step}</div>
                  <h3 className="text-lg font-bold mb-3 uppercase tracking-tight">{title}</h3>
                  <p className="text-[#e5e2e1]/60 text-sm leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── The MintVault Edge ────────────────────────────────────── */}
        <section className="py-24 px-6 overflow-hidden">
          <div className="max-w-7xl mx-auto">

            <div className="text-center mb-20">
              <h2 className="text-4xl md:text-6xl font-black tracking-tighter uppercase mb-4">
                THE <span className="text-[#f2ca50]">MINTVAULT</span> EDGE
              </h2>
              <p className="text-[#e5e2e1]/60 max-w-xl mx-auto uppercase tracking-widest text-[10px] font-bold">
                Engineered for Collectors, by Collectors
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">

              {/* NFC — 7 cols */}
              <div className="md:col-span-7 bg-[#201f1f] p-10 rounded-3xl relative overflow-hidden group">
                <h3 className="text-3xl font-bold mb-4 uppercase tracking-tighter">NFC &amp; QR Authentication</h3>
                <p className="text-[#e5e2e1]/60 max-w-sm mb-8">
                  Every slab contains an encrypted NFC chip. Instant verification with no app required. Pure security in the palm of your hand.
                </p>
                <Contact size={96} className="text-[#f2ca50]/10 absolute -bottom-4 -right-4 group-hover:scale-110 transition-transform duration-700" />
                <div className="absolute inset-0 bg-gradient-to-br from-[#f2ca50]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </div>

              {/* No Conflict — 5 cols */}
              <div className="md:col-span-5 bg-[#2a2a2a] p-10 rounded-3xl flex flex-col justify-between border-t border-[#f2ca50]/20">
                <div>
                  <Shield size={32} className="text-[#f2ca50] mb-6" />
                  <h3 className="text-2xl font-bold mb-2 uppercase tracking-tighter">No Conflict of Interest</h3>
                  <p className="text-[#e5e2e1]/60 text-sm">
                    We do not buy, sell, or trade cards. Our grading is purely technical, unbiased, and objective. Every time.
                  </p>
                </div>
              </div>

              {/* Subgrades — 5 cols */}
              <div className="md:col-span-5 bg-[#353534] p-10 rounded-3xl">
                <h3 className="text-2xl font-bold mb-6 uppercase tracking-tighter">Subgrade Transparency</h3>
                <ul className="space-y-4 font-mono">
                  {[["CENTRING","9.5"],["SURFACE","10.0"],["EDGES","9.0"],["CORNERS","9.5"]].map(([label, val], i, arr) => (
                    <li key={label} className={`flex justify-between text-xs pb-2 ${i < arr.length - 1 ? "border-b border-white/5" : ""}`}>
                      <span className="text-[#e5e2e1]/80">{label}</span>
                      <span className="text-[#f2ca50] font-bold">{val}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Fast Turnaround — 7 cols */}
              <div
                className="md:col-span-7 p-10 rounded-3xl flex items-center justify-between"
                style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
              >
                <div className="text-[#3c2f00]">
                  <h3 className="text-3xl font-black mb-2 uppercase tracking-tighter">Fast UK Turnaround</h3>
                  <p className="font-medium opacity-80">10-Day Standard. 48-Hour Priority. No international shipping delays.</p>
                </div>
                <Zap size={64} className="text-[#3c2f00]/20 flex-shrink-0" />
              </div>

            </div>
          </div>
        </section>

        {/* ── What We Grade ─────────────────────────────────────────── */}
        <section className="py-24 bg-[#0e0e0e] overflow-hidden">
          <div className="max-w-7xl mx-auto px-6">
            <div className="flex gap-16 items-center opacity-40 grayscale animate-[scroll_25s_linear_infinite] whitespace-nowrap">
              {[
                "Pokémon", "Sports Cards", "Yu-Gi-Oh", "One Piece", "Magic TCG",
                "Pokémon", "Sports Cards", "Yu-Gi-Oh", "One Piece", "Magic TCG",
              ].map((name, i) => (
                <div key={i} className="flex items-center gap-3 flex-shrink-0">
                  <PokemonIcon />
                  <span className="text-2xl font-black uppercase tracking-tighter">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

      </main>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="w-full bg-[#1c1b1b] pt-20 pb-32">
        <div className="max-w-7xl mx-auto px-8 grid grid-cols-1 md:grid-cols-4 gap-12">

          <div className="col-span-1">
            <span className="text-lg font-bold text-[#f2ca50] uppercase tracking-tighter mb-4 block">MintVault</span>
            <p className="text-[#e5e2e1]/70 text-sm leading-relaxed mb-6">
              Redefining high-end card grading for the modern UK collector through technical precision and absolute security.
            </p>
            <div className="flex gap-4">
              <BarChart2 size={20} className="text-[#f2ca50] cursor-pointer hover:opacity-70 transition-opacity" />
              <Camera size={20} className="text-[#f2ca50] cursor-pointer hover:opacity-70 transition-opacity" />
              <Share2 size={20} className="text-[#f2ca50] cursor-pointer hover:opacity-70 transition-opacity" />
            </div>
          </div>

          <div>
            <h4 className="text-[#f2ca50] font-bold text-xs uppercase tracking-widest mb-6">Services</h4>
            <ul className="space-y-4">
              <li><Link href="/submit" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Submit</Link></li>
              <li><Link href="/pricing" className="text-[#f2ca50] underline decoration-[#f2ca50]/30 text-sm hover:text-white transition-all">Pricing</Link></li>
              <li><Link href="/cert" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Verify</Link></li>
              <li><Link href="/pricing" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Bulk Discounts</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-[#f2ca50] font-bold text-xs uppercase tracking-widest mb-6">Resources</h4>
            <ul className="space-y-4">
              <li><Link href="/guides" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Guides</Link></li>
              <li><Link href="/why-mintvault#grading-scale" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Grading Scale</Link></li>
              <li><Link href="/why-mintvault" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Why MintVault</Link></li>
              <li><Link href="/cert" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Certificate Lookup</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-[#f2ca50] font-bold text-xs uppercase tracking-widest mb-6">Legal</h4>
            <ul className="space-y-4">
              <li><Link href="/terms-and-conditions" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Terms of Service</Link></li>
              <li><Link href="/liability-and-insurance" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Liability &amp; Insurance</Link></li>
              <li><Link href="/claim" className="text-[#e5e2e1]/70 text-sm hover:text-white transition-all">Claims</Link></li>
            </ul>
          </div>

        </div>

        <div className="max-w-7xl mx-auto px-8 mt-20 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
          <span className="text-[#e5e2e1]/40 text-xs font-mono tracking-tighter">
            © 2024 MINTVAULT UK. ALL RIGHTS RESERVED. NO CONFLICT OF INTEREST.
          </span>
          <div className="flex items-center gap-6 opacity-30">
            <CreditCard size={18} />
          </div>
        </div>
      </footer>

      {/* ── Mobile Bottom Nav ─────────────────────────────────────── */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center h-20 px-4 bg-[#131313]/90 backdrop-blur-xl border-t border-[#f2ca50]/10 md:hidden">
        <Link href="/" className="flex flex-col items-center justify-center text-[#f2ca50]">
          <Home size={22} />
          <span className="text-[10px] uppercase tracking-widest mt-1">Home</span>
        </Link>
        <Link href="/cert" className="flex flex-col items-center justify-center text-[#e5e2e1]/60">
          <CheckCircle size={22} />
          <span className="text-[10px] uppercase tracking-widest mt-1">Verify</span>
        </Link>
        <Link href="/why-mintvault" className="flex flex-col items-center justify-center text-[#e5e2e1]/60">
          <Database size={22} />
          <span className="text-[10px] uppercase tracking-widest mt-1">Dashboard</span>
        </Link>
        <Link href="/pricing" className="flex flex-col items-center justify-center text-[#e5e2e1]/60">
          <CreditCard size={22} />
          <span className="text-[10px] uppercase tracking-widest mt-1">Pricing</span>
        </Link>
      </nav>

      {/* ── Mobile FAB ────────────────────────────────────────────── */}
      <div className="fixed bottom-24 right-6 md:hidden z-40">
        <Link href="/submit">
          <button
            className="w-14 h-14 rounded-full flex items-center justify-center text-[#3c2f00] shadow-2xl active:scale-90 transition-transform"
            style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
          >
            <Plus size={28} />
          </button>
        </Link>
      </div>

    </div>
  );
}
