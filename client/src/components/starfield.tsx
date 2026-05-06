import { memo, useMemo } from "react";

// 3-layer parallax sparkle starfield with shooting stars.
// Stars render as 4-point sparkle <symbol> shapes (not plain dots), pulse
// via scale+opacity, and randomise positions per mount. Front-layer stars
// also carry a cream-coloured core for visible depth contrast.
//
// All sparkle paths fill MintVault gold (#D4AF37). Front-layer core is cream
// (#fff5dc). Shooting stars alternate white and gold streaks, four total,
// staggered so the screen sees one cross every ~2-3 seconds on average.

interface StarShape {
  cx: number;
  cy: number;
  size: number;
  cls: string;
  key: number;
}

function generateStars(
  count: number,
  sizeMin: number,
  sizeMax: number,
  classes: string[],
): StarShape[] {
  return Array.from({ length: count }, (_, i) => ({
    cx: Math.random() * 1000,
    cy: Math.random() * 600,
    size: sizeMin + Math.random() * (sizeMax - sizeMin),
    cls: classes[Math.floor(Math.random() * classes.length)],
    key: i,
  }));
}

function StarLayer({
  stars,
  opacity,
  driftClass,
  symbolId,
}: {
  stars: StarShape[];
  opacity: number;
  driftClass: string;
  symbolId: string;
}) {
  const uses = stars.map((s) => (
    <use
      key={s.key}
      href={`#${symbolId}`}
      x={s.cx - s.size / 2}
      y={s.cy - s.size / 2}
      width={s.size}
      height={s.size}
      className={s.cls}
    />
  ));
  return (
    <div className="sf-layer" style={{ opacity }}>
      <div className={driftClass}>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
          {uses}
        </svg>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
          {uses}
        </svg>
      </div>
    </div>
  );
}

function Starfield() {
  const stars = useMemo(
    () => ({
      far:   generateStars(180, 3, 5, ["t1", "t2", "t3", "t4"]),
      mid:   generateStars(130, 4, 7, ["t1", "t2", "t3", "t4"]),
      front: generateStars(60,  5, 7, ["tb1", "tb2"]),
    }),
    [],
  );

  return (
    <>
      <style>{`
        @keyframes sf-drift {
          from { transform: translateY(0); }
          to   { transform: translateY(-50%); }
        }
        @keyframes sf-twinkle {
          0%, 100% { opacity: 0.4; transform: scale(0.85); }
          50%      { opacity: 1;   transform: scale(1); }
        }
        @keyframes sf-twinkle-bright {
          0%, 100% { opacity: 0.6; transform: scale(0.9); }
          50%      { opacity: 1;   transform: scale(1.05); }
        }
        @keyframes sf-shoot {
          0%   { transform: translate(-120px, -60px) rotate(25deg); opacity: 0; }
          8%   { opacity: 0; }
          12%  { opacity: 1; }
          35%  { transform: translate(800px, 250px) rotate(25deg); opacity: 1; }
          38%  { opacity: 0; }
          100% { transform: translate(800px, 250px) rotate(25deg); opacity: 0; }
        }
        @keyframes sf-shoot2 {
          0%   { transform: translate(-150px, 0px) rotate(20deg); opacity: 0; }
          8%   { opacity: 0; }
          12%  { opacity: 1; }
          35%  { transform: translate(900px, 350px) rotate(20deg); opacity: 1; }
          38%  { opacity: 0; }
          100% { transform: translate(900px, 350px) rotate(20deg); opacity: 0; }
        }

        .sf-wrap {
          position: absolute;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
        }
        .sf-layer {
          position: absolute;
          inset: 0;
        }
        .sf-drift-far,
        .sf-drift-mid,
        .sf-drift-front {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 200%;
        }
        .sf-drift-far   { animation: sf-drift 120s linear infinite; }
        .sf-drift-mid   { animation: sf-drift  70s linear infinite; }
        .sf-drift-front { animation: sf-drift  40s linear infinite; }
        .sf-drift-far svg,
        .sf-drift-mid svg,
        .sf-drift-front svg {
          display: block;
          width: 100%;
          height: 50%;
        }

        /* Sparkle stars need transform-box so scale animates around their own
           bounding-box centre rather than the SVG viewport origin. */
        .sf-wrap .t1, .sf-wrap .t2, .sf-wrap .t3, .sf-wrap .t4,
        .sf-wrap .tb1, .sf-wrap .tb2 {
          transform-origin: center;
          transform-box: fill-box;
        }
        .sf-wrap .t1  { animation: sf-twinkle 2.5s ease-in-out infinite; }
        .sf-wrap .t2  { animation: sf-twinkle 3.5s ease-in-out infinite; animation-delay: 0.6s; }
        .sf-wrap .t3  { animation: sf-twinkle 4.5s ease-in-out infinite; animation-delay: 1.4s; }
        .sf-wrap .t4  { animation: sf-twinkle 5.5s ease-in-out infinite; animation-delay: 2.2s; }
        .sf-wrap .tb1 { animation: sf-twinkle-bright 3s ease-in-out infinite; }
        .sf-wrap .tb2 { animation: sf-twinkle-bright 4s ease-in-out infinite; animation-delay: 1s; }

        /* 4 shooters — 2 white via sf-shoot (25° angle), 2 gold via sf-shoot2 (20° angle).
           Staggered durations + delays so on average one streak crosses every ~2-3s. */
        .shooter-1, .shooter-2, .shooter-3, .shooter-4 {
          position: absolute;
          left: 0;
          width: 80px;
          pointer-events: none;
          transform-origin: left center;
          opacity: 0;
        }
        .shooter-1 {
          top: 15%;
          height: 1.2px;
          background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.9) 100%);
          animation: sf-shoot 7s ease-out infinite;
        }
        .shooter-2 {
          top: 35%;
          height: 1.5px;
          background: linear-gradient(90deg, transparent 0%, #D4AF37 100%);
          animation: sf-shoot2 9s ease-out infinite;
          animation-delay: 3s;
        }
        .shooter-3 {
          top: 55%;
          height: 1.2px;
          background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.9) 100%);
          animation: sf-shoot 8s ease-out infinite;
          animation-delay: 5s;
        }
        .shooter-4 {
          top: 75%;
          height: 1.5px;
          background: linear-gradient(90deg, transparent 0%, #D4AF37 100%);
          animation: sf-shoot2 10s ease-out infinite;
          animation-delay: 7s;
        }

        @media (prefers-reduced-motion: reduce) {
          .sf-drift-far,
          .sf-drift-mid,
          .sf-drift-front { animation: none; }
          .sf-wrap .t1, .sf-wrap .t2, .sf-wrap .t3, .sf-wrap .t4,
          .sf-wrap .tb1, .sf-wrap .tb2 {
            animation: none;
            opacity: 0.6;
            transform: none;
          }
          .shooter-1, .shooter-2, .shooter-3, .shooter-4 {
            animation: none;
            opacity: 0;
          }
        }
      `}</style>

      {/* Sparkle symbol defs — defined once, referenced by all layer SVGs via <use>. */}
      <svg
        aria-hidden="true"
        style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
      >
        <defs>
          <symbol id="sf-star-sm" viewBox="-5 -5 10 10">
            <path d="M0,-5 L1,-1 L5,0 L1,1 L0,5 L-1,1 L-5,0 L-1,-1 Z" fill="#D4AF37" />
          </symbol>
          <symbol id="sf-star-lg" viewBox="-8 -8 16 16">
            <path d="M0,-8 L1.5,-1.5 L8,0 L1.5,1.5 L0,8 L-1.5,1.5 L-8,0 L-1.5,-1.5 Z" fill="#D4AF37" />
            <circle r="0.8" fill="#fff5dc" />
          </symbol>
        </defs>
      </svg>

      <div className="sf-wrap" aria-hidden="true">
        <StarLayer stars={stars.far}   opacity={0.55} driftClass="sf-drift-far"   symbolId="sf-star-sm" />
        <StarLayer stars={stars.mid}   opacity={0.75} driftClass="sf-drift-mid"   symbolId="sf-star-sm" />
        <StarLayer stars={stars.front} opacity={1.0}  driftClass="sf-drift-front" symbolId="sf-star-lg" />
        <div className="shooter-1" />
        <div className="shooter-2" />
        <div className="shooter-3" />
        <div className="shooter-4" />
      </div>
    </>
  );
}

export default memo(Starfield);
