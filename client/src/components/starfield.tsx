import { memo, useMemo } from "react";

// 3-layer parallax starfield with randomised positions and shooting stars.
// Far layer drifts slowest, front layer fastest — creates depth via differential
// motion. Star coordinates regenerate on each component mount, so the layout
// differs per page navigation.
//
// All stars render in MintVault gold (#D4AF37). Shooter A is white, Shooter B
// is gold — provides a subtle accent contrast.

interface StarShape {
  cx: number;
  cy: number;
  r: number;
  cls: string;
  key: number;
}

function generateStars(
  count: number,
  rMin: number,
  rMax: number,
  classes: string[],
): StarShape[] {
  return Array.from({ length: count }, (_, i) => ({
    cx: Math.random() * 1000,
    cy: Math.random() * 600,
    r: rMin + Math.random() * (rMax - rMin),
    cls: classes[Math.floor(Math.random() * classes.length)],
    key: i,
  }));
}

function StarLayer({
  stars,
  opacity,
  driftClass,
}: {
  stars: StarShape[];
  opacity: number;
  driftClass: string;
}) {
  const circles = stars.map((s) => (
    <circle
      key={s.key}
      cx={s.cx}
      cy={s.cy}
      r={s.r}
      fill="#D4AF37"
      className={s.cls}
    />
  ));
  return (
    <div className="sf-layer" style={{ opacity }}>
      <div className={driftClass}>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
          {circles}
        </svg>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
          {circles}
        </svg>
      </div>
    </div>
  );
}

function Starfield() {
  const stars = useMemo(
    () => ({
      far: generateStars(30, 0.3, 0.5, ["t1", "t2", "t3", "t4"]),
      mid: generateStars(22, 0.8, 1.0, ["t1", "t2", "t3", "t4"]),
      front: generateStars(12, 1.6, 2.0, ["tb1", "tb2"]),
    }),
    [],
  );

  return (
    <>
      <style>{`
        @keyframes sf-drift {
          from { transform: translateY(0); }
          to { transform: translateY(-50%); }
        }
        @keyframes sf-twinkle {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        @keyframes sf-twinkle-bright {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes sf-shoot {
          0%   { transform: translate(-120px, -60px) rotate(25deg); opacity: 0; }
          8%   { opacity: 0; }
          12%  { opacity: 1; }
          42%  { transform: translate(800px, 250px) rotate(25deg); opacity: 1; }
          46%  { opacity: 0; }
          100% { transform: translate(800px, 250px) rotate(25deg); opacity: 0; }
        }
        @keyframes sf-shoot2 {
          0%   { transform: translate(-150px, 0px) rotate(20deg); opacity: 0; }
          8%   { opacity: 0; }
          12%  { opacity: 1; }
          37%  { transform: translate(900px, 350px) rotate(20deg); opacity: 1; }
          41%  { opacity: 0; }
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

        .sf-wrap .t1  { animation: sf-twinkle 2.5s ease-in-out infinite; }
        .sf-wrap .t2  { animation: sf-twinkle 3.5s ease-in-out infinite; animation-delay: 0.6s; }
        .sf-wrap .t3  { animation: sf-twinkle 4.5s ease-in-out infinite; animation-delay: 1.4s; }
        .sf-wrap .t4  { animation: sf-twinkle 5.5s ease-in-out infinite; animation-delay: 2.2s; }
        .sf-wrap .tb1 { animation: sf-twinkle-bright 3s ease-in-out infinite; }
        .sf-wrap .tb2 { animation: sf-twinkle-bright 4s ease-in-out infinite; animation-delay: 1s; }

        .shooter-a, .shooter-b {
          position: absolute;
          left: 0;
          width: 80px;
          pointer-events: none;
          transform-origin: left center;
        }
        .shooter-a {
          top: 25%;
          height: 1.2px;
          background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.9) 100%);
          animation: sf-shoot 11s ease-out infinite;
          animation-delay: 2s;
          opacity: 0;
        }
        .shooter-b {
          top: 50%;
          height: 1.5px;
          background: linear-gradient(90deg, transparent 0%, #D4AF37 100%);
          animation: sf-shoot2 16s ease-out infinite;
          animation-delay: 8s;
          opacity: 0;
        }

        @media (prefers-reduced-motion: reduce) {
          .sf-drift-far,
          .sf-drift-mid,
          .sf-drift-front { animation: none; }
          .sf-wrap .t1, .sf-wrap .t2, .sf-wrap .t3, .sf-wrap .t4,
          .sf-wrap .tb1, .sf-wrap .tb2 { animation: none; opacity: 0.6; }
          .shooter-a, .shooter-b { animation: none; opacity: 0; }
        }
      `}</style>
      <div className="sf-wrap" aria-hidden="true">
        <StarLayer stars={stars.far}   opacity={0.4}  driftClass="sf-drift-far" />
        <StarLayer stars={stars.mid}   opacity={0.75} driftClass="sf-drift-mid" />
        <StarLayer stars={stars.front} opacity={1.0}  driftClass="sf-drift-front" />
        <div className="shooter-a" />
        <div className="shooter-b" />
      </div>
    </>
  );
}

export default memo(Starfield);
