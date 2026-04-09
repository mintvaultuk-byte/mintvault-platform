import { Link } from "wouter";
import { ArrowRight, Shield, Nfc, Gem, QrCode, Layers, Lock } from "lucide-react";
import SeoHead from "@/components/seo-head";
import MintVaultWordmark from "@/components/mintvault-wordmark";

const BRAND_ICONS = [
  { icon: <Nfc size={18} className="text-[#B8960C]" />, name: "VaultLock™" },
  { icon: <Lock size={18} className="text-[#B8960C]" />, name: "MintSeal™" },
  { icon: <Gem size={18} className="text-[#B8960C]" />, name: "VaultGlass™" },
  { icon: <QrCode size={18} className="text-[#B8960C]" />, name: "VaultLink™" },
  { icon: <Layers size={18} className="text-[#B8960C]" />, name: "VaultCore™" },
];

function TechSpec({ items }: { items: string[] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full border border-[#D4AF37]/30 bg-[#FFF9E6] text-[#B8960C]"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

export default function TheMintVaultSlabPage() {
  return (
    <>
      <SeoHead
        title="The MintVault Slab — Five Engineered Components"
        description="VaultLock™ NFC, MintSeal™ sonic weld, VaultGlass™ optical-grade acrylic, VaultLink™ QR, and VaultCore™ suspension. Every component engineered for permanence."
        canonical="/about/the-mintvault-slab"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-5xl mx-auto px-6 py-16 md:py-24">
          <div className="flex flex-col md:flex-row items-center gap-12 md:gap-16">

            {/* Slab visual */}
            <div className="flex-shrink-0">
              <div
                className="relative flex flex-col items-center justify-center rounded-2xl"
                style={{
                  width: 220, height: 300,
                  background: "linear-gradient(160deg,#1a1a1a,#2a2200)",
                  border: "2px solid rgba(212,175,55,0.4)",
                  boxShadow: "0 0 60px rgba(212,175,55,0.1), 0 30px 80px rgba(0,0,0,0.3)",
                }}
              >
                <div className="absolute inset-3 border border-[#D4AF37]/20 rounded-xl" />
                <MintVaultWordmark size="sm" />
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] mt-4" style={{ color: "rgba(212,175,55,0.5)" }}>
                  VaultLock™ · VaultLink™
                </p>
              </div>
            </div>

            {/* Text */}
            <div className="flex-1 text-center md:text-left">
              <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Product</p>
              <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
                The MintVault Slab
              </h1>
              <p className="text-xl text-[#B8960C] font-medium mb-6">Five engineered components. One verified slab.</p>
              <p className="text-[#555555] text-base leading-relaxed mb-8">
                Every MintVault slab is built around five proprietary technologies — each engineered to protect, verify, and display your graded card for decades.
              </p>
              {/* Brand name row */}
              <div className="flex flex-wrap justify-center md:justify-start gap-4">
                {BRAND_ICONS.map(({ icon, name }) => (
                  <div key={name} className="flex flex-col items-center gap-1.5">
                    <div className="w-9 h-9 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center">
                      {icon}
                    </div>
                    <span className="text-[9px] font-bold uppercase tracking-widest text-[#B8960C] whitespace-nowrap">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 1 — VaultLock™ */}
      <section className="px-6 py-14 md:py-20 bg-white border-b border-[#E8E4DC]">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
              <Nfc size={22} className="text-[#B8960C]" />
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight">
              VaultLock™ — Tap to Verify
            </h2>
          </div>
          <p className="text-[#555555] text-base leading-relaxed">
            Every MintVault slab contains a VaultLock™ NFC chip, embedded in the back label. Tap any modern smartphone to the slab and the chip instantly opens the cert's Vault report in your browser — no app required. Each chip is hand-tested for read reliability before the slab is sealed.
          </p>
          <TechSpec items={["NTAG213 / NTAG215", "Read range 1–3cm", "Encrypted payload"]} />
        </div>
      </section>

      {/* Section 2 — MintSeal™ */}
      <section className="px-6 py-14 md:py-20 bg-[#FAFAF8] border-b border-[#E8E4DC]">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
              <Lock size={22} className="text-[#B8960C]" />
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight">
              MintSeal™ — Tamper-Evident Sonic Weld
            </h2>
          </div>
          <p className="text-[#555555] text-base leading-relaxed">
            The MintSeal™ is the precision sonic weld that seals every slab. Once sealed, the only way to open it is to break it — and any attempt leaves visible damage along the seam. No cold-opening, no swap-outs, no re-sealing. If you see an unbroken MintSeal™, you're looking at an untouched slab.
          </p>
          <TechSpec items={["20kHz ultrasonic weld", "0.1mm tolerance", "Hand-inspected for seal integrity"]} />
        </div>
      </section>

      {/* Section 3 — VaultGlass™ */}
      <section className="px-6 py-14 md:py-20 bg-white border-b border-[#E8E4DC]">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
              <Gem size={22} className="text-[#B8960C]" />
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight">
              VaultGlass™ — Optical-Grade Case
            </h2>
          </div>
          <p className="text-[#555555] text-base leading-relaxed">
            VaultGlass™ is the UV-stabilised optical-grade acrylic that forms the body of every MintVault slab. Crystal-clear on both faces, scratch-resistant, and treated to resist yellowing over decades of display. The card inside stays exactly as you sealed it — whether that's a month from now or twenty years.
          </p>
          <TechSpec items={["Optical-grade acrylic", "UV-stabilised", "Scratch-resistant", "2.5mm wall thickness"]} />
        </div>
      </section>

      {/* Section 4 — VaultLink™ */}
      <section className="px-6 py-14 md:py-20 bg-[#FAFAF8] border-b border-[#E8E4DC]">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
              <QrCode size={22} className="text-[#B8960C]" />
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight">
              VaultLink™ — Instant Vault Report
            </h2>
          </div>
          <p className="text-[#555555] text-base leading-relaxed">
            Every slab label carries a unique VaultLink™ QR code. Scan it with any phone camera and you're taken straight to the card's full Vault report — grades, subgrades, scans, ownership history, and pop report context. Nothing to download, nothing to log into.
          </p>
          <TechSpec items={["Unique per cert", "Links to mintvaultuk.com/vault/MV[n]", "Scannable from any phone"]} />
        </div>
      </section>

      {/* Section 5 — VaultCore™ */}
      <section className="px-6 py-14 md:py-20 bg-white border-b border-[#E8E4DC]">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
              <Layers size={22} className="text-[#B8960C]" />
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tight">
              VaultCore™ — Zero-Movement Suspension
            </h2>
          </div>
          <p className="text-[#555555] text-base leading-relaxed">
            VaultCore™ is the inner cradle that holds your card motionless inside the slab. Precision-cut to the exact card thickness — 35pt, 75pt, 130pt, or 180pt — so there's no rattle, no drift, no contact between the card and the VaultGlass™ walls. The card floats in the centre of the slab, protected on every side.
          </p>
          <TechSpec items={["Four card-thickness variants", "Zero-contact mounting", "Archival-grade internal material"]} />
        </div>
      </section>

      {/* Dimensions */}
      <section className="px-6 py-12 bg-[#FAFAF8] border-b border-[#E8E4DC]">
        <div className="max-w-2xl mx-auto">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-6 text-center">Specifications</p>
          <div className="rounded-2xl overflow-hidden border border-[#E8E4DC]">
            {[
              { label: "Slab size", value: "6mm × 135mm × 80mm · ~35g" },
              { label: "Card thicknesses supported", value: "35pt · 75pt · 130pt · 180pt" },
              { label: "Case material", value: "VaultGlass™ optical-grade acrylic" },
              { label: "Seal", value: "MintSeal™ 20kHz ultrasonic weld" },
              { label: "Verification", value: "VaultLock™ NFC + VaultLink™ QR + certificate ID" },
            ].map(({ label, value }, i) => (
              <div
                key={label}
                className="flex items-center justify-between px-5 py-3"
                style={{ background: i % 2 === 0 ? "#fff" : "#FAFAF8", borderBottom: i < 4 ? "1px solid #E8E4DC" : "none" }}
              >
                <span className="text-xs font-bold uppercase tracking-wider text-[#888]">{label}</span>
                <span className="text-sm font-medium text-[#1A1A1A] text-right ml-4">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-16 bg-white">
        <div className="max-w-xl mx-auto text-center space-y-4">
          <h2 className="text-2xl font-black text-[#1A1A1A]">
            Ready to seal your cards in a MintVault slab?
          </h2>
          <p className="text-[#666666] text-sm">Every submission gets all five components — VaultLock™, MintSeal™, VaultGlass™, VaultLink™, and VaultCore™.</p>
          <Link href="/submit">
            <button className="gold-shimmer inline-flex items-center gap-2 font-bold text-sm px-8 py-4 rounded-xl">
              Submit for Grading <ArrowRight size={15} />
            </button>
          </Link>
        </div>
      </section>
    </>
  );
}
