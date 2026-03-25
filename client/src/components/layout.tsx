import { useState } from "react";
import { Link } from "wouter";
import { Menu, X, ChevronDown, ChevronUp } from "lucide-react";
import { BUILD_STAMP } from "@/lib/constants";
import logoPath from "@assets/file_000000002550720aada646b736a25622_1772023165771.png";

const whyMenuItems = [
  { label: "Why Grade", href: "/why-mintvault#why-grade" },
  { label: "Our Labels", href: "/why-mintvault#our-labels" },
  { label: "Grading Scale", href: "/why-mintvault#grading-scale" },
  { label: "Population Report", href: "/why-mintvault#population-report" },
  { label: "Blog", href: "/why-mintvault#authority" },
];

const exploreMenuItems = [
  { label: "Our Labels", href: "/labels", isRoute: true },
  { label: "Grading Reports", href: "/reports", isRoute: true },
  { label: "Population Report", href: "/population", isRoute: true },
  { label: "Certificate Lookup", href: "/cert", isRoute: true },
  { label: "Supported TCGs", href: "/tcg", isRoute: true },
  { label: "Guides & Articles", href: "/guides", isRoute: true },
];

const footerServices = [
  { label: "Pokemon Card Grading UK", href: "/pokemon-card-grading-uk" },
  { label: "Trading Card Grading UK", href: "/trading-card-grading-uk" },
  { label: "Card Grading Service UK", href: "/card-grading-service-uk" },
  { label: "PSA Alternative UK", href: "/psa-alternative-uk" },
  { label: "How to Grade Cards", href: "/how-to-grade-pokemon-cards" },
  { label: "TCG Grading UK", href: "/tcg-grading-uk" },
];

const footerGuides = [
  { label: "How to Grade Pokemon Cards", href: "/guides/how-to-grade-pokemon-cards-uk" },
  { label: "What Cards Are Worth Grading", href: "/guides/what-pokemon-cards-are-worth-grading" },
  { label: "Grading Costs Explained", href: "/guides/pokemon-card-grading-costs-explained" },
  { label: "Raw vs Graded Cards", href: "/guides/raw-vs-graded-pokemon-cards" },
  { label: "Beginner's Collecting Guide", href: "/guides/beginners-guide-pokemon-card-collecting-uk" },
  { label: "All Guides", href: "/guides" },
];

const footerCompany = [
  { label: "Pricing", href: "/" },
  { label: "Submit Cards", href: "/submit" },
  { label: "Certificate Lookup", href: "/cert" },
  { label: "Track Submission", href: "/track" },
  { label: "Why MintVault", href: "/why-mintvault" },
  { label: "Terms & Conditions", href: "/terms-and-conditions" },
  { label: "Liability & Insurance", href: "/liability-and-insurance" },
];

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);

  const closeMenu = () => {
    setMenuOpen(false);
    setWhyOpen(false);
    setExploreOpen(false);
  };

  return (
    <header className="sticky top-0 z-50 bg-black/95 backdrop-blur-sm border-b border-[#D4AF37]/20">
      <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
        <button
          data-testid="button-menu"
          onClick={() => {
            setMenuOpen(!menuOpen);
            if (menuOpen) {
              setWhyOpen(false);
              setExploreOpen(false);
            }
          }}
          className="text-[#D4AF37] p-1"
          aria-label="Menu"
        >
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <Link href="/" data-testid="link-home">
          <img
            src={logoPath}
            alt="MintVault UK - Professional Pokemon and Trading Card Grading"
            className="h-10 w-auto"
            data-testid="img-header-logo"
          />
        </Link>

        <div className="flex items-center gap-3">
        </div>
      </div>

      {menuOpen && (
        <nav className="border-t border-[#D4AF37]/20 bg-black/98 px-4 py-4" data-testid="nav-mobile-menu">
          <ul className="space-y-3">
            <li>
              <Link href="/" onClick={closeMenu} className="text-[#D4AF37] text-lg block py-1" data-testid="link-pricing">
                Pricing
              </Link>
            </li>

            <li>
              <button
                onClick={() => setWhyOpen(!whyOpen)}
                className="flex items-center justify-between w-full text-[#D4AF37] text-lg py-1"
                data-testid="button-why-dropdown"
              >
                <span>Why MintVault</span>
                {whyOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>
              {whyOpen && (
                <ul className="ml-4 mt-2 space-y-2 border-l border-[#D4AF37]/20 pl-4" data-testid="nav-why-submenu">
                  {whyMenuItems.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        onClick={closeMenu}
                        className="text-[#D4AF37]/70 hover:text-[#D4AF37] text-base block py-0.5 transition-colors"
                        data-testid={`link-why-${item.label.toLowerCase().replace(/\s/g, "-")}`}
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>

            <li>
              <button
                onClick={() => setExploreOpen(!exploreOpen)}
                className="flex items-center justify-between w-full text-[#D4AF37] text-lg py-1"
                data-testid="button-explore-dropdown"
              >
                <span>Explore MintVault</span>
                {exploreOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>
              {exploreOpen && (
                <ul className="ml-4 mt-2 space-y-2 border-l border-[#D4AF37]/20 pl-4" data-testid="nav-explore-submenu">
                  {exploreMenuItems.map((item) => (
                    <li key={item.label}>
                      <Link
                        href={item.href}
                        onClick={closeMenu}
                        className="text-[#D4AF37]/70 hover:text-[#D4AF37] text-base block py-0.5 transition-colors"
                        data-testid={`link-explore-${item.label.toLowerCase().replace(/\s/g, "-")}`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>

            <li>
              <Link href="/cert" onClick={closeMenu} className="text-[#D4AF37] text-lg block py-1" data-testid="link-cert-lookup">
                Certificate Lookup
              </Link>
            </li>

            <li>
              <Link href="/guides" onClick={closeMenu} className="text-[#D4AF37] text-lg block py-1" data-testid="link-guides">
                Guides
              </Link>
            </li>

            <li>
              <Link href="/submit" onClick={closeMenu} className="text-[#D4AF37] text-lg block py-1 font-semibold" data-testid="link-submit">
                Submit Cards
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[#D4AF37]/20 bg-black mt-16">
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-10">
          <div>
            <h4 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest mb-4">Services</h4>
            <ul className="space-y-2">
              {footerServices.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-xs transition-colors" data-testid={`link-footer-${link.href.slice(1)}`}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest mb-4">Guides</h4>
            <ul className="space-y-2">
              {footerGuides.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-xs transition-colors">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest mb-4">Company</h4>
            <ul className="space-y-2">
              {footerCompany.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-xs transition-colors">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="text-center border-t border-[#D4AF37]/10 pt-8">
          <h3 className="text-[#D4AF37] text-sm font-semibold mb-3 tracking-wide">
            Join our email list
          </h3>
          <div className="flex gap-2 max-w-md mx-auto mb-6">
            <input
              type="email"
              placeholder="Enter your email"
              data-testid="input-email"
              className="flex-1 bg-transparent border border-[#D4AF37]/40 rounded px-4 py-2 text-white text-sm placeholder:text-[#D4AF37]/40 focus:outline-none focus:border-[#D4AF37] transition-colors"
            />
            <button
              data-testid="button-subscribe"
              className="border border-[#D4AF37] bg-black text-[#D4AF37] px-4 py-2 rounded font-medium text-sm tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10"
            >
              Subscribe
            </button>
          </div>

          <p className="text-[#D4AF37]/40 text-xs mb-3">
            MintVault UK — Professional Trading Card Grading Service
          </p>
          <p className="text-[#D4AF37]/50 text-xs mb-2" data-testid="text-copyright">
            © 2026 MintVault. All rights reserved.
          </p>
          <p className="text-[#D4AF37]/30 text-xs font-mono" data-testid="text-build-stamp">
            BUILD: {BUILD_STAMP}
          </p>
        </div>
      </div>
    </footer>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black flex flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
