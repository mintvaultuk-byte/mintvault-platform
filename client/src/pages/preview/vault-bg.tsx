// Preview-only route — /preview/vault-bg
// Static CSS vault scene for visual review before shipping the bg to
// showroom / dashboard / showrooms. No auth, no API, no shared imports.
// Sample white card tile floats centre-screen so we can see how content
// reads against the bg.

export default function VaultBgPreviewPage() {
  return (
    <>
      <style>{`
        /* ── Animations — beam pulse only ───────────────────────────── */
        @keyframes vbg-beam-1 {
          0%, 100% { opacity: 0.3; }
          50%      { opacity: 0.6; }
        }
        @keyframes vbg-beam-2 {
          0%, 100% { opacity: 0.35; }
          50%      { opacity: 0.55; }
        }
        @keyframes vbg-beam-3 {
          0%, 100% { opacity: 0.3; }
          50%      { opacity: 0.5; }
        }

        /* ── Page wrapper — provides perspective for walls/bars ─────── */
        .vbg-page {
          position: relative;
          width: 100%;
          min-height: 100vh;
          overflow: hidden;
          perspective: 800px;
          perspective-origin: 50% 40%;
          background: linear-gradient(180deg, #0a1820 0%, #0a0e1a 50%, #1a0e08 100%);
        }

        /* ── Atmospheric haze — soft middle band ────────────────────── */
        .vbg-haze {
          position: absolute;
          left: 0;
          right: 0;
          top: 35%;
          height: 30%;
          background: radial-gradient(ellipse at center, rgba(80, 140, 160, 0.08) 0%, transparent 70%);
          filter: blur(40px);
          pointer-events: none;
        }

        /* ── Side walls — rotated for vanishing-point perspective ───── */
        .vbg-wall {
          position: absolute;
          top: 0;
          bottom: 25%;
          width: 35%;
          pointer-events: none;
          background: linear-gradient(180deg, rgba(15, 30, 38, 0.85) 0%, rgba(40, 26, 14, 0.6) 100%);
        }
        .vbg-wall-left {
          left: 0;
          transform: rotateY(35deg);
          transform-origin: left center;
        }
        .vbg-wall-right {
          right: 0;
          transform: rotateY(-35deg);
          transform-origin: right center;
        }

        /* ── Gold bar stacks — repeating-gradient texture ───────────── */
        /* One "row" = 10px: 1.5px dark shadow + 7.5px bevelled gold + 1px gap. */
        /* Columns separated every 19px (17px bar + 2px shadow). */
        /* Mask fades top half to transparent so bars recede into wall shadow. */
        .vbg-bars {
          position: absolute;
          bottom: 25%;
          width: 35%;
          height: 50%;
          pointer-events: none;
          background:
            repeating-linear-gradient(
              90deg,
              transparent 0,
              transparent 17px,
              rgba(0, 0, 0, 0.5) 17px,
              rgba(0, 0, 0, 0.5) 19px
            ),
            repeating-linear-gradient(
              0deg,
              rgba(0, 0, 0, 0.75) 0,
              rgba(0, 0, 0, 0.75) 1.5px,
              #b8860b 1.5px,
              #f5d76e 5px,
              #b8860b 9px,
              rgba(0, 0, 0, 0.75) 10px
            );
          -webkit-mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.4) 25%, black 55%);
          mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.4) 25%, black 55%);
        }
        .vbg-bars-left {
          left: 0;
          transform: rotateY(35deg);
          transform-origin: left center;
        }
        .vbg-bars-right {
          right: 0;
          transform: rotateY(-35deg);
          transform-origin: right center;
        }

        /* ── Ceiling skylight — bright cream glow at top centre ─────── */
        .vbg-skylight {
          position: absolute;
          top: 0;
          left: 35%;
          width: 30%;
          height: 40px;
          background: radial-gradient(ellipse at center, rgba(255, 245, 220, 0.6) 0%, transparent 70%);
          filter: blur(8px);
          pointer-events: none;
        }

        /* ── Light beams — three cones from skylight, staggered pulse ── */
        .vbg-beam {
          position: absolute;
          top: 30px;
          left: 50%;
          height: 120%;
          background: linear-gradient(180deg, rgba(255, 240, 200, 0.35) 0%, transparent 80%);
          pointer-events: none;
          transform-origin: top center;
        }
        .vbg-beam-1 {
          width: 90px;
          margin-left: -200px;
          transform: rotate(-3deg);
          filter: blur(15px);
          animation: vbg-beam-1 5s ease-in-out infinite;
        }
        .vbg-beam-2 {
          width: 120px;
          margin-left: -60px;
          transform: rotate(0deg);
          filter: blur(25px);
          animation: vbg-beam-2 7s ease-in-out infinite;
        }
        .vbg-beam-3 {
          width: 90px;
          margin-left: 80px;
          transform: rotate(3deg);
          filter: blur(15px);
          animation: vbg-beam-3 9s ease-in-out infinite;
        }

        /* ── Floor — bottom 25% with warm gold reflection in centre ── */
        .vbg-floor {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 25%;
          background:
            radial-gradient(ellipse at center bottom, rgba(212, 175, 55, 0.18) 0%, transparent 60%),
            linear-gradient(0deg, #2a1a08 0%, #0a0e1a 100%);
          pointer-events: none;
        }

        /* ── Vignette — darken corners ─────────────────────────────── */
        .vbg-vignette {
          position: absolute;
          inset: 0;
          background: radial-gradient(ellipse at center, transparent 50%, rgba(0, 0, 0, 0.4) 100%);
          pointer-events: none;
        }

        /* ── Sample card tile — centre-floating reference ──────────── */
        .vbg-card-wrap {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 10;
          width: 200px;
        }
        .vbg-card {
          background: white;
          border: 1px solid #E8E4DC;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        }
        .vbg-card-image {
          aspect-ratio: 2.5 / 3.5;
          background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #1a1a1a;
          font-family: system-ui, sans-serif;
          font-weight: 900;
          font-size: 56px;
        }
        .vbg-card-info {
          padding: 10px 12px;
        }
        .vbg-card-title {
          font-size: 12px;
          font-weight: 700;
          color: #1a1a1a;
          margin: 0;
          line-height: 1.3;
        }
        .vbg-card-grade {
          color: #D4AF37;
          font-weight: 900;
          font-size: 14px;
          margin-left: 4px;
        }
        .vbg-card-set {
          font-size: 10px;
          color: #999999;
          margin: 2px 0 0;
        }

        /* ── Mobile fallback — disable perspective on narrow viewports ── */
        @media (max-width: 640px) {
          .vbg-page { perspective: none; }
          .vbg-wall-left,
          .vbg-wall-right,
          .vbg-bars-left,
          .vbg-bars-right { transform: none; }
        }

        /* ── Reduced motion — freeze all beam pulses at mid opacity ── */
        @media (prefers-reduced-motion: reduce) {
          .vbg-beam-1,
          .vbg-beam-2,
          .vbg-beam-3 {
            animation: none;
            opacity: 0.4;
          }
        }
      `}</style>

      <h1 className="sr-only">Vault background preview</h1>

      <div className="vbg-page">
        <div className="vbg-wall vbg-wall-left" aria-hidden="true" />
        <div className="vbg-wall vbg-wall-right" aria-hidden="true" />
        <div className="vbg-bars vbg-bars-left" aria-hidden="true" />
        <div className="vbg-bars vbg-bars-right" aria-hidden="true" />
        <div className="vbg-haze" aria-hidden="true" />
        <div className="vbg-skylight" aria-hidden="true" />
        <div className="vbg-beam vbg-beam-1" aria-hidden="true" />
        <div className="vbg-beam vbg-beam-2" aria-hidden="true" />
        <div className="vbg-beam vbg-beam-3" aria-hidden="true" />
        <div className="vbg-floor" aria-hidden="true" />
        <div className="vbg-vignette" aria-hidden="true" />

        <div className="vbg-card-wrap">
          <div className="vbg-card">
            <div className="vbg-card-image">V</div>
            <div className="vbg-card-info">
              <p className="vbg-card-title">
                Voltorb<span className="vbg-card-grade">· Grade 7</span>
              </p>
              <p className="vbg-card-set">Base · 2000</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
