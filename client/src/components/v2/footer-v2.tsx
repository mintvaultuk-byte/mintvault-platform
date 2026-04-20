import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { COMPANY } from "@shared/company";

const FOOTER_COLS = [
  {
    title: "Grading",
    links: [
      { label: "Submit a card", href: "/submit" },
      { label: "Grading standards", href: "/grading" },
      { label: "AI Pre-Grade", href: "/tools/estimate" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Technology",
    links: [
      { label: "How it works", href: "/technology" },
      { label: "NFC verification", href: "/verify" },
      { label: "Population report", href: "/registry" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Vault Club", href: "/club" },
      { label: "Journal", href: "/journal" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Contact",
    links: [
      { label: COMPANY.supportEmail, href: `mailto:${COMPANY.supportEmail}` },
      { label: `${COMPANY.tradingAddress.city}, England`, href: "#" },
    ],
  },
];

const LEGAL_LINKS = [
  { label: "Website Terms",            href: "/legal/website-terms" },
  { label: "Submission Agreement",     href: "/legal/submission-agreement" },
  { label: "Guarantee & Correction",   href: "/legal/guarantee-and-correction-policy" },
  { label: "Privacy Policy",           href: "/legal/privacy-policy" },
  { label: "Cookies Policy",           href: "/legal/cookies" },
  { label: "Shipping Requirements",    href: "/legal/shipping-requirements" },
  { label: "Grading Standards",        href: "/legal/grading-standards" },
  { label: "Cancellation",             href: "/legal/cancel" },
  { label: "Dispute Resolution (ADR)", href: "/legal/adr" },
];

export default function FooterV2() {
  const flags = useFeatureFlags();
  const cols = flags.legalPagesLive
    ? [...FOOTER_COLS, { title: "Legal", links: LEGAL_LINKS }]
    : FOOTER_COLS;

  return (
    <footer
      className="border-t"
      style={{
        backgroundColor: "var(--v2-paper-sunk)",
        borderColor: "var(--v2-line)",
      }}
    >
      <div className="mx-auto max-w-7xl px-6 py-16">
        {/* Columns */}
        <div className={`grid grid-cols-2 gap-8 mb-12 ${flags.legalPagesLive ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
          {cols.map((col) => (
            <div key={col.title}>
              <p
                className="font-body text-xs font-semibold uppercase tracking-widest mb-4"
                style={{ color: "var(--v2-ink-mute)" }}
              >
                {col.title}
              </p>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="font-body text-sm no-underline transition-colors hover:underline"
                      style={{ color: "var(--v2-ink-soft)" }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom strip */}
        <div
          className="border-t pt-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
          style={{ borderColor: "var(--v2-line)" }}
        >
          {/* Mark */}
          <span
            className="font-display italic text-lg font-medium"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            {COMPANY.tradingName}
          </span>

          {/* Legal line */}
          <p
            className="font-body text-xs leading-relaxed"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            &copy; 2026 {COMPANY.legalName} &middot; Registered in England &amp; Wales
            &middot; Company No. {COMPANY.companyNumber}
            &middot; ICO Reg. {COMPANY.icoRegistrationNumber}
          </p>
        </div>
      </div>
    </footer>
  );
}
