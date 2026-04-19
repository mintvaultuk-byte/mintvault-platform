import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import { ArrowRight } from "lucide-react";

export default function V2TestPage() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* Hero */}
      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-6 text-center" style={{ paddingTop: "var(--v2-space-section)", paddingBottom: "var(--v2-space-section)" }}>
          <h1
            className="font-display italic font-medium leading-tight mb-6"
            style={{ fontSize: "var(--v2-text-6xl)", color: "var(--v2-ink)" }}
          >
            The standard for<br />graded collectibles.
          </h1>
          <p
            className="font-body text-lg leading-relaxed max-w-xl mx-auto mb-10"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            AI-powered precision grading with tamper-evident NFC certification.
            Every card verified, every grade transparent.
          </p>
          <div className="flex items-center justify-center gap-4">
            <a
              href="/submit"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-colors"
              style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
            >
              Submit a card
              <ArrowRight size={14} />
            </a>
            <a
              href="/tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-colors"
              style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
            >
              Try AI Pre-Grade
            </a>
          </div>
        </section>

        {/* Token test strip */}
        <section
          className="border-t border-b mx-auto max-w-4xl px-6 py-12"
          style={{ borderColor: "var(--v2-line)" }}
        >
          <p className="font-body text-xs uppercase tracking-widest mb-6" style={{ color: "var(--v2-ink-mute)" }}>
            Phase 1 — Token &amp; Type Test
          </p>
          <div className="space-y-3">
            <p className="font-display italic font-medium" style={{ fontSize: "var(--v2-text-3xl)", color: "var(--v2-ink)" }}>
              Fraunces italic — display headings
            </p>
            <p className="font-body font-normal" style={{ fontSize: "var(--v2-text-base)", color: "var(--v2-ink-soft)" }}>
              Geist — body text, labels, navigation. Clean and geometric.
            </p>
            <p className="font-mono-v2 font-normal" style={{ fontSize: "var(--v2-text-sm)", color: "var(--v2-ink-mute)" }}>
              JetBrains Mono — cert IDs, code, data: MV-0000000132
            </p>
          </div>
          <div className="flex items-center gap-4 mt-8">
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-ink)" }} title="--v2-ink" />
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-ink-soft)" }} title="--v2-ink-soft" />
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-ink-mute)" }} title="--v2-ink-mute" />
            <div className="w-12 h-12 rounded-lg border" style={{ backgroundColor: "var(--v2-paper)", borderColor: "var(--v2-line)" }} title="--v2-paper" />
            <div className="w-12 h-12 rounded-lg border" style={{ backgroundColor: "var(--v2-paper-sunk)", borderColor: "var(--v2-line)" }} title="--v2-paper-sunk" />
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-gold)" }} title="--v2-gold" />
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-gold-soft)" }} title="--v2-gold-soft" />
            <div className="w-12 h-12 rounded-lg" style={{ backgroundColor: "var(--v2-panel-dark)" }} title="--v2-panel-dark" />
          </div>
        </section>
      </main>

      <FooterV2 />
    </div>
  );
}
