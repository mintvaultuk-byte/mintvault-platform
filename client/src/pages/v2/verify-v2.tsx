import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Check } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import HeroSlabFan, { type SlabContent } from "@/components/v2/hero-slab";

// ── API types ──────────────────────────────────────────────────────────────

interface VerifyResult {
  verified: true;
  certId: string;
  status: string;
  cardGame: string | null;
  cardName: string | null;
  cardSet: string | null;
  cardYear: string | null;
  cardNumber: string | null;
  language: string | null;
  grade: string;
  gradeNumeric: number;
  gradedDate: string | null;
  ownershipStatus: "claimed" | "unclaimed" | string;
  verifyUrl: string;
}

type VerifyStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "verified"; result: VerifyResult }
  | { kind: "not-found"; certId: string }
  | { kind: "rate-limited" }
  | { kind: "error" };

const CERT_PATTERN = /^MV\d+$/;

// ── Methods list (Section I) ───────────────────────────────────────────────

const METHODS = [
  {
    number: "01",
    title: "NFC chip in the slab",
    body: "A small passive chip inside the slab shell. Tap with any NFC-enabled phone (iPhone XS+, most Androids). The chip opens the slab's live registry record — no app, no typing.",
  },
  {
    number: "02",
    title: "Cert number lookup",
    body: "Every slab has a unique cert number (MVXXX) stored in our registry. Type the number here to cross-check any slab, even when NFC isn't working.",
  },
  {
    number: "03",
    title: "Ownership chain",
    body: "Claimed slabs show their ownership chain — who graded it, when, and who claimed it. Transferring ownership leaves an audit trail the registry keeps permanently.",
  },
];

// ── What-you-see items (Section II) ────────────────────────────────────────

const RETURNS_ITEMS = [
  { title: "Card identity", body: "Card name, set, year, card number, and language." },
  { title: "Grade and subgrades", body: "Overall grade plus centering, corners, edges, surface breakdown where applicable." },
  { title: "Ownership status", body: "Claimed (with keeper count) or unclaimed. Current owner shown only if they\u2019ve made their profile public." },
  { title: "Graded date", body: "The exact date MintVault issued the slab." },
  { title: "Cross-grade estimate", body: "How the card might score at PSA, BGS, or other graders. Advisory only." },
];

// ── FAQ (Section IV) ───────────────────────────────────────────────────────

const FAQS = [
  {
    q: "What if the NFC chip doesn\u2019t respond?",
    a: "Your phone needs NFC enabled and the slab held within 2\u20133cm of the centre. If it still doesn\u2019t work, use the cert number manually — both methods return the same data.",
  },
  {
    q: "Can I verify someone else\u2019s MintVault slab?",
    a: "Yes. Verification is public. You\u2019ll see the card and grade; owner identity only shows if that owner has opted to make their profile public.",
  },
  {
    q: "What does \u201Cunclaimed\u201D mean?",
    a: "The slab has been graded and issued but the keeper hasn\u2019t linked it to an account yet. Unclaimed cards are still genuine — claiming is optional.",
  },
  {
    q: "Can you verify slabs from other grading companies?",
    a: "No. This tool only verifies MintVault cert numbers (format MVXXX). For other graders, use their official verification tools.",
  },
  {
    q: "What should I do if verification fails on a slab I own?",
    a: "Email support@mintvaultuk.com with a photo of the slab and any paperwork. If it\u2019s genuine we\u2019ll reissue the cert record; if there\u2019s an issue we\u2019ll investigate.",
  },
];

// ── Result card (inline) ───────────────────────────────────────────────────

function ResultCard({ result }: { result: VerifyResult }) {
  const identityParts = [result.cardSet, result.cardYear, result.cardNumber ? `#${result.cardNumber}` : null].filter(Boolean);
  const identityLine = identityParts.length ? identityParts.join(" \u00b7 ") : null;
  const gradeDisplay = result.gradeNumeric > 0
    ? result.gradeNumeric.toString()
    : result.grade || "\u2014";
  const claimed = result.ownershipStatus === "claimed";

  return (
    <div
      className="mt-8 rounded-xl p-6 md:p-8 transition-opacity duration-300"
      style={{
        backgroundColor: "var(--v2-paper-raised)",
        border: "1px solid var(--v2-gold-soft)",
      }}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6" style={{ borderBottom: "1px solid var(--v2-line)", paddingBottom: "16px" }}>
        <div>
          <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2" style={{ color: "var(--v2-gold)" }}>
            Verified &middot; {result.status}
          </p>
          <p className="font-mono-v2 text-2xl md:text-3xl font-semibold" style={{ color: "var(--v2-ink)" }}>
            {result.certId}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono-v2 text-[9px] uppercase tracking-widest mb-1" style={{ color: "var(--v2-ink-mute)" }}>
            Grade
          </p>
          <p
            className="font-mono-v2 font-semibold leading-none"
            style={{ color: "var(--v2-gold)", fontSize: "clamp(40px, 6vw, 64px)" }}
          >
            {gradeDisplay}
          </p>
          {result.grade && result.gradeNumeric > 0 && (
            <p className="font-body text-xs mt-1" style={{ color: "var(--v2-ink-mute)" }}>
              {result.grade}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
        <div>
          <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-2" style={{ color: "var(--v2-ink)" }}>
            {result.cardName ?? "Card details unavailable"}
          </h3>
          {identityLine && (
            <p className="font-body text-sm mb-2" style={{ color: "var(--v2-ink-soft)" }}>
              {identityLine}
            </p>
          )}
          <div className="flex items-center gap-3 flex-wrap mt-3">
            <span
              className="inline-flex items-center gap-1.5 font-mono-v2 text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full"
              style={
                claimed
                  ? { backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }
                  : { border: "1px solid var(--v2-line)", color: "var(--v2-ink-mute)" }
              }
            >
              {claimed && <Check size={10} />}
              {claimed ? "Claimed" : "Unclaimed"}
            </span>
            {result.gradedDate && (
              <span className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                Graded {result.gradedDate}
              </span>
            )}
          </div>
        </div>
        <Link
          href={`/cert/${result.certId}`}
          className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline whitespace-nowrap self-end"
          style={{ color: "var(--v2-gold)" }}
        >
          View certificate <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function VerifyV2() {
  const [certNumber, setCertNumber] = useState("");
  const [status, setStatus] = useState<VerifyStatus>({ kind: "idle" });
  const [formatError, setFormatError] = useState<string | null>(null);

  const isLoading = status.kind === "loading";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = certNumber.trim().toUpperCase();

    if (!CERT_PATTERN.test(trimmed)) {
      setFormatError("Format: MVXXX (e.g. MV141)");
      return;
    }
    setFormatError(null);
    setStatus({ kind: "loading" });

    try {
      const res = await fetch(`/api/v1/verify/${encodeURIComponent(trimmed)}`);
      if (res.status === 429) {
        setStatus({ kind: "rate-limited" });
        return;
      }
      if (res.status === 404) {
        setStatus({ kind: "not-found", certId: trimmed });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: "error" });
        return;
      }
      const data = (await res.json()) as VerifyResult;
      if (!data.verified) {
        setStatus({ kind: "not-found", certId: trimmed });
        return;
      }
      setStatus({ kind: "verified", result: data });
      setCertNumber("");
    } catch {
      setStatus({ kind: "error" });
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section id="verify" className="relative scroll-mt-20">
        <div className="mx-auto max-w-7xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
          {/* Left — copy + form */}
          <div>
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
              style={{ color: "var(--v2-gold)" }}
            >
              Est. Kent &middot; Verify
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              Every slab,<br />provably real.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Tap, scan, or type the certificate number. We return the grade, the card
              details, and whether ownership is claimed. No login, no account.
            </p>

            {/* Verify form */}
            <form onSubmit={handleSubmit} className="max-w-md">
              <div
                className="flex items-stretch rounded-full overflow-hidden transition-all"
                style={{
                  backgroundColor: "var(--v2-paper-raised)",
                  border: `1px solid ${formatError ? "#b33" : "var(--v2-line)"}`,
                }}
              >
                <input
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={12}
                  value={certNumber}
                  onChange={(e) => {
                    setCertNumber(e.target.value.toUpperCase());
                    if (formatError) setFormatError(null);
                  }}
                  placeholder="MV141"
                  disabled={isLoading}
                  aria-label="Certificate number"
                  className="flex-1 bg-transparent outline-none px-5 py-3 font-mono-v2 text-base"
                  style={{ color: "var(--v2-ink)", minWidth: 0 }}
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 font-body text-sm font-semibold px-5 py-3 transition-all disabled:opacity-70"
                  style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
                >
                  {isLoading ? "Verifying\u2026" : "Verify"}
                  {!isLoading && <ArrowRight size={14} />}
                </button>
              </div>
              {formatError && (
                <p className="font-mono-v2 text-[10px] uppercase tracking-widest mt-2 ml-1" style={{ color: "#b33" }}>
                  {formatError}
                </p>
              )}
              <p className="font-mono-v2 text-[10px] uppercase tracking-wider mt-3 ml-1" style={{ color: "var(--v2-ink-mute)" }}>
                Tip: NFC-enabled phone? Tap the slab to skip the search.
              </p>
            </form>

            {/* Inline result */}
            {status.kind === "verified" && <ResultCard result={status.result} />}
            {status.kind === "not-found" && (
              <p className="mt-6 font-body text-sm max-w-md" style={{ color: "var(--v2-ink-soft)" }}>
                Certificate {status.certId} not recognised. Check the number and try again.
                If the slab is physical, the NFC tag works without typing.
              </p>
            )}
            {status.kind === "rate-limited" && (
              <p className="mt-6 font-body text-sm max-w-md" style={{ color: "var(--v2-ink-soft)" }}>
                Too many verifications &mdash; please wait a moment before trying again.
              </p>
            )}
            {status.kind === "error" && (
              <p className="mt-6 font-body text-sm max-w-md" style={{ color: "var(--v2-ink-soft)" }}>
                Couldn&rsquo;t reach verification. Try again in a moment.
              </p>
            )}
          </div>

          {/* Right — trust-signal slab fan */}
          {(() => {
            const slabs: [SlabContent, SlabContent, SlabContent] = [
              {
                topBadge: "NFC TAP",
                mainLabel: "1 second",
                rightLabel: "Instant",
                footnote: "NO APP NEEDED",
                key: "nfc",
              },
              {
                topBadge: "CERTIFICATE",
                mainLabel: "Signed",
                rightLabel: "Unique",
                footnote: "ONLINE-VERIFIABLE",
                key: "cert",
              },
              {
                topBadge: "OWNERSHIP",
                mainLabel: "Tracked",
                rightLabel: "Chain",
                footnote: "KEEPER HISTORY",
                key: "ownership",
              },
            ];
            return <HeroSlabFan slabs={slabs} />;
          })()}
        </div>
      </section>

      {/* ── SECTION I: HOW IT WORKS (dark) ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="I" label="How It Works" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-16">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "#FFFFFF" }}>
              Three layers.<br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold-soft)" }}>One truth.</span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "rgba(255,255,255,0.6)" }}>
              Every MintVault slab has three ways into the registry: the NFC chip, the
              printed cert number, and the visible ownership chain. Any one opens the
              same record — the tamper-evident slab is what ties that record to the
              card in your hand.
            </p>
          </div>

          <div className="max-w-4xl">
            {METHODS.map((m, i) => (
              <div
                key={m.number}
                className="grid grid-cols-[auto_1fr] gap-6 md:gap-10 py-8 md:py-10"
                style={{
                  borderTop: i === 0 ? "1px solid rgba(255,255,255,0.1)" : undefined,
                  borderBottom: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                <p
                  className="font-display italic font-medium leading-none"
                  style={{ color: "rgba(212, 175, 55, 0.35)", fontSize: "clamp(2rem, 4vw, 3rem)" }}
                >
                  {m.number}
                </p>
                <div>
                  <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "#FFFFFF" }}>
                    {m.title}
                  </h3>
                  <p className="font-body text-sm md:text-base leading-relaxed max-w-xl" style={{ color: "rgba(255,255,255,0.6)" }}>
                    {m.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION II: WHAT YOU SEE ─────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="What You See" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              The full record.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Every verification surfaces the same data a serious collector needs &mdash;
              nothing paywalled, nothing hidden.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            {RETURNS_ITEMS.map((item, i) => (
              <div
                key={item.title}
                style={{
                  borderTop: i === 0 || i === 1 ? "1px solid var(--v2-line)" : undefined,
                  borderBottom: "1px solid var(--v2-line)",
                  paddingTop: "20px",
                  paddingBottom: "20px",
                }}
              >
                <h3 className="font-display italic font-medium text-lg md:text-xl mb-2" style={{ color: "var(--v2-ink)" }}>
                  {item.title}
                </h3>
                <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION III: FOR BUYERS ──────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="For Buyers" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-10" style={{ color: "var(--v2-ink)" }}>
            Before you buy.<br />Verify first.
          </h2>
          <div className="space-y-5 max-w-2xl font-body text-base md:text-lg leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
            <p>
              Graded cards are expensive. Counterfeit slabs exist. Use this tool before you
              send money &mdash; it takes three seconds and costs nothing.
            </p>
            <p>
              If you&rsquo;re buying from a marketplace, vault, or private seller, ask for
              the cert number in advance. Verify it matches the card you&rsquo;re being
              shown. A seller refusing to share the cert number before payment is the
              biggest red flag you&rsquo;ll find.
            </p>
            <p>
              MintVault verification is free, unlimited, and doesn&rsquo;t require an
              account. We never notify sellers when their cert is looked up.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION IV: FAQ ──────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="FAQ" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Verification questions.
          </h2>
          <div className="space-y-10">
            {FAQS.map((item) => (
              <div key={item.q}>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                  {item.q}
                </h3>
                <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION V: FINAL CTA (dark) ──────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center">
          <SectionEyebrow numeral="V" label="Verify" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6" style={{ color: "#FFFFFF" }}>
            Scan. Tap. Type.<br />Know.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            Free, unlimited, no account. Before you buy, before you sell, before you trust.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <a
              href="#verify"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Verify a certificate <ArrowRight size={14} />
            </a>
            <Link
              href="/population"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              Browse the registry <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
