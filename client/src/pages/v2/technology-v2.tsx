import { Link } from "wouter";
import { ArrowRight, Nfc, Lock, Gem, QrCode, Layers } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";

// ── Hero-row component list (right column) ───────────────────────────────

const HERO_COMPONENTS: { name: string; short: string; icon: JSX.Element }[] = [
  { name: "VaultLock",  short: "NFC",     icon: <Nfc size={18} /> },
  { name: "MintSeal",   short: "Seal",    icon: <Lock size={18} /> },
  { name: "VaultGlass", short: "Shell",   icon: <Gem size={18} /> },
  { name: "VaultLink",  short: "QR",      icon: <QrCode size={18} /> },
  { name: "VaultCore",  short: "Cradle",  icon: <Layers size={18} /> },
];

// ── Spec sections ────────────────────────────────────────────────────────

function SpecCard({
  icon,
  specs,
  onDark,
}: {
  icon: JSX.Element;
  specs: string[];
  onDark: boolean;
}) {
  return (
    <div
      className="rounded-xl p-8"
      style={{
        backgroundColor: onDark
          ? "rgba(255,255,255,0.03)"
          : "var(--v2-paper-raised)",
        border: onDark
          ? "1px solid rgba(255,255,255,0.08)"
          : "1px solid var(--v2-line)",
      }}
    >
      <div
        className="w-14 h-14 rounded-xl flex items-center justify-center"
        style={{
          backgroundColor: onDark
            ? "rgba(212,175,55,0.1)"
            : "rgba(212,175,55,0.08)",
          color: "var(--v2-gold)",
        }}
      >
        {icon}
      </div>
      <ul
        className="mt-6 space-y-2 font-mono-v2 text-[11px] uppercase tracking-widest"
        style={{ color: onDark ? "rgba(255,255,255,0.7)" : "var(--v2-ink-soft)" }}
      >
        {specs.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <span style={{ color: "var(--v2-gold)" }}>&middot;</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComponentSection({
  numeral,
  label,
  headline,
  body,
  icon,
  specs,
  onDark,
  bgVar,
}: {
  numeral: string;
  label: string;
  headline: string;
  body: string;
  icon: JSX.Element;
  specs: string[];
  onDark: boolean;
  bgVar: string;
}) {
  const headlineColour = onDark ? "#FFFFFF" : "var(--v2-ink)";
  const bodyColour = onDark ? "rgba(255,255,255,0.65)" : "var(--v2-ink-soft)";
  return (
    <section style={{ backgroundColor: bgVar }}>
      <div className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <SectionEyebrow numeral={numeral} label={label} className="mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-10 md:gap-16 items-start">
          {/* Left: narrative */}
          <div>
            <h2
              className="font-display italic font-medium leading-tight"
              style={{
                fontSize: "clamp(2.5rem, 5vw, 3.75rem)",
                color: headlineColour,
              }}
            >
              {headline}
            </h2>
            <p
              className="font-body text-base md:text-lg leading-relaxed mt-6 max-w-md"
              style={{ color: bodyColour }}
            >
              {body}
            </p>
          </div>
          {/* Right: spec card */}
          <SpecCard icon={icon} specs={specs} onDark={onDark} />
        </div>
      </div>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function TechnologyV2() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ─────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-7xl px-6 pt-12 md:pt-20 pb-16 md:pb-24 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
          {/* Left — copy */}
          <div>
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
              style={{ color: "var(--v2-gold)" }}
            >
              Est. Kent &middot; Technology
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              Five engineered components.<br />One verified slab.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Every MintVault slab is built around five purpose-designed components.
              NFC tap-to-verify, sonic weld seal, optical-grade acrylic, QR cert
              lookup, and a zero-movement cradle. Each is engineered to protect,
              verify, and display a graded card for decades.
            </p>
            <p
              className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              Designed for permanence &middot; Made in Kent
            </p>
          </div>

          {/* Right — 5 component rows */}
          <div className="flex flex-col gap-3">
            {HERO_COMPONENTS.map((c) => (
              <div
                key={c.name}
                className="flex items-center gap-4 p-3 rounded-lg"
                style={{
                  backgroundColor: "var(--v2-paper-raised)",
                  border: "1px solid var(--v2-line-soft)",
                }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor: "rgba(212,175,55,0.08)",
                    color: "var(--v2-gold)",
                  }}
                >
                  {c.icon}
                </div>
                <div className="min-w-0">
                  <p className="font-body font-semibold text-sm" style={{ color: "var(--v2-ink)" }}>
                    {c.name}
                  </p>
                  <p
                    className="font-mono-v2 text-[9px] uppercase tracking-widest"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    {c.short}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION I: VaultLock (dark) ─────────────────────────── */}
      <ComponentSection
        numeral="I"
        label="VaultLock"
        headline="Tap to verify."
        body="Every MintVault slab has a passive NFC chip embedded behind the label. Tap a modern smartphone to the slab and the cert's Vault report opens in your browser. No app. No login. No setup. Each chip is hand-tested for read reliability before the slab is sealed."
        icon={<Nfc size={48} />}
        specs={[
          "NTAG213 or NTAG215 chip",
          "Read range 1–3cm",
          "Passive — no battery",
          "Hand-tested pre-seal",
        ]}
        onDark={true}
        bgVar="var(--v2-panel-dark)"
      />

      {/* ── SECTION II: MintSeal ─────────────────────────────────── */}
      <ComponentSection
        numeral="II"
        label="MintSeal"
        headline="Sealed, not stuck."
        body="The MintSeal is a precision 20kHz ultrasonic weld that seals every slab at assembly. Once sealed, the only way to open the slab is to break it — and any attempt leaves visible damage along the seam. No cold-opening, no swap-outs, no re-sealing. An unbroken MintSeal is the first visual indicator that a slab has not been opened since grading."
        icon={<Lock size={48} />}
        specs={[
          "20kHz ultrasonic weld",
          "Tamper-evident seam",
          "Hand-inspected post-seal",
          "Tolerance ±0.1mm",
        ]}
        onDark={false}
        bgVar="var(--v2-paper)"
      />

      {/* ── SECTION III: VaultGlass ──────────────────────────────── */}
      <ComponentSection
        numeral="III"
        label="VaultGlass"
        headline="Clear, for decades."
        body="VaultGlass is the UV-stabilised optical-grade acrylic that forms the shell of every slab. Crystal-clear on both faces, scratch-resistant, and treated to resist yellowing over decades of display. The card inside stays exactly as you sealed it — whether that's a month from now or twenty years."
        icon={<Gem size={48} />}
        specs={[
          "Optical-grade acrylic",
          "UV-stabilised",
          "Scratch-resistant surface",
          "2.5mm wall thickness",
        ]}
        onDark={false}
        bgVar="var(--v2-paper-raised)"
      />

      {/* ── SECTION IV: VaultLink (dark) ─────────────────────────── */}
      <ComponentSection
        numeral="IV"
        label="VaultLink"
        headline="Scan, verify, done."
        body="Every slab label carries a VaultLink QR code unique to the cert. Scan with any phone camera and the cert's full Vault report opens immediately — grades, subgrades, card scans, and pop report context. Nothing to download, nothing to log into. Works alongside the NFC tap for redundancy."
        icon={<QrCode size={48} />}
        specs={[
          "Unique per cert",
          "Opens /vault/MV[id]",
          "No app required",
          "Printed with the label",
        ]}
        onDark={true}
        bgVar="var(--v2-panel-dark)"
      />

      {/* ── SECTION V: VaultCore ─────────────────────────────────── */}
      <ComponentSection
        numeral="V"
        label="VaultCore"
        headline="Zero movement."
        body="VaultCore is the inner cradle that holds the card motionless inside the slab. Precision-cut to the exact card thickness — 35pt, 75pt, 130pt, or 180pt — so there's no rattle, no drift, and no contact between the card face and the VaultGlass walls. The card floats in the centre of the slab, protected on every side."
        icon={<Layers size={48} />}
        specs={[
          "Four card-thickness profiles",
          "Zero-contact mounting",
          "Archival-grade material",
          "Cut to ±0.05mm",
        ]}
        onDark={false}
        bgVar="var(--v2-paper)"
      />

      {/* ── SECTION VI: SPECIFICATIONS ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-3xl px-6 py-20 md:py-28">
          <SectionEyebrow numeral="VI" label="Specifications" className="mb-6" />
          <h2
            className="font-display italic font-medium leading-tight mb-10"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
          >
            The full spec.
          </h2>
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--v2-line)" }}>
            {[
              { label: "Slab dimensions",            value: "6mm × 135mm × 80mm, ~35g" },
              { label: "Card thicknesses supported", value: "35pt · 75pt · 130pt · 180pt" },
              { label: "Case material",              value: "VaultGlass optical-grade acrylic" },
              { label: "Seal",                       value: "MintSeal 20kHz ultrasonic weld" },
              { label: "Verification",               value: "VaultLock NFC + VaultLink QR + cert ID" },
              { label: "Designed in",                value: "Kent, UK" },
            ].map((row, i, arr) => (
              <div
                key={row.label}
                className="flex flex-col md:flex-row md:items-center md:justify-between gap-1 md:gap-4 px-5 py-4"
                style={{
                  backgroundColor: i % 2 === 0 ? "var(--v2-paper)" : "var(--v2-paper-raised)",
                  borderBottom: i < arr.length - 1 ? "1px solid var(--v2-line-soft)" : undefined,
                }}
              >
                <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                  {row.label}
                </p>
                <p className="font-body text-sm font-medium md:text-right" style={{ color: "var(--v2-ink)" }}>
                  {row.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION VII: FINAL CTA (dark) ───────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-20 md:py-28 text-center">
          <SectionEyebrow numeral="VII" label="Next" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight mb-6"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#FFFFFF" }}
          >
            Five components.<br />Every submission.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            Every MintVault submission ships in a slab with all five components.
            No tiers, no upgrades, no premium shells. One standard.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/submit"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Submit a card <ArrowRight size={14} />
            </Link>
            <Link
              href="/v2-pricing"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              See pricing <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
