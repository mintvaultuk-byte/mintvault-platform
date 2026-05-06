import { memo } from "react";

// 35 stars across viewBox 1000x600, mixed radii and twinkle classes (t1-t4).
// Pattern is repeated in both stacked SVGs so the upward drift loops seamlessly.
const STARS = (
  <>
    <circle cx="50"  cy="80"  r="1.2" fill="#fff" className="t1" />
    <circle cx="180" cy="40"  r="0.7" fill="#fff" className="t2" />
    <circle cx="320" cy="110" r="1.5" fill="#fff" className="t3" />
    <circle cx="450" cy="60"  r="0.9" fill="#fff" className="t1" />
    <circle cx="580" cy="130" r="1.0" fill="#fff" className="t4" />
    <circle cx="700" cy="50"  r="1.3" fill="#fff" className="t2" />
    <circle cx="830" cy="100" r="0.6" fill="#fff" className="t3" />
    <circle cx="950" cy="70"  r="1.1" fill="#fff" className="t1" />
    <circle cx="80"  cy="200" r="0.8" fill="#fff" className="t4" />
    <circle cx="220" cy="240" r="1.4" fill="#fff" className="t2" />
    <circle cx="370" cy="180" r="0.5" fill="#fff" className="t1" />
    <circle cx="500" cy="220" r="1.6" fill="#fff" className="t3" />
    <circle cx="640" cy="200" r="0.9" fill="#fff" className="t4" />
    <circle cx="780" cy="240" r="1.2" fill="#fff" className="t1" />
    <circle cx="910" cy="180" r="0.7" fill="#fff" className="t2" />
    <circle cx="40"  cy="330" r="1.1" fill="#fff" className="t3" />
    <circle cx="170" cy="370" r="1.7" fill="#fff" className="t4" />
    <circle cx="290" cy="320" r="0.6" fill="#fff" className="t1" />
    <circle cx="420" cy="380" r="1.3" fill="#fff" className="t2" />
    <circle cx="560" cy="340" r="0.8" fill="#fff" className="t3" />
    <circle cx="690" cy="390" r="1.0" fill="#fff" className="t4" />
    <circle cx="820" cy="320" r="1.4" fill="#fff" className="t1" />
    <circle cx="950" cy="370" r="0.7" fill="#fff" className="t2" />
    <circle cx="100" cy="460" r="1.5" fill="#fff" className="t3" />
    <circle cx="230" cy="500" r="0.9" fill="#fff" className="t4" />
    <circle cx="360" cy="470" r="0.5" fill="#fff" className="t1" />
    <circle cx="490" cy="520" r="1.2" fill="#fff" className="t2" />
    <circle cx="620" cy="460" r="1.8" fill="#fff" className="t3" />
    <circle cx="750" cy="510" r="0.7" fill="#fff" className="t4" />
    <circle cx="880" cy="470" r="1.0" fill="#fff" className="t1" />
    <circle cx="60"  cy="560" r="0.8" fill="#fff" className="t2" />
    <circle cx="200" cy="590" r="1.3" fill="#fff" className="t3" />
    <circle cx="340" cy="540" r="0.6" fill="#fff" className="t4" />
    <circle cx="470" cy="580" r="1.1" fill="#fff" className="t1" />
    <circle cx="610" cy="560" r="1.5" fill="#fff" className="t2" />
  </>
);

function Starfield() {
  return (
    <>
      <style>{`
        @keyframes sf-drift {
          from { transform: translateY(0); }
          to { transform: translateY(-50%); }
        }
        @keyframes sf-twinkle {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 1; }
        }
        .sf-wrap {
          position: absolute;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
        }
        .sf-drift {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 200%;
          animation: sf-drift 60s linear infinite;
        }
        .sf-drift svg {
          display: block;
          width: 100%;
          height: 50%;
        }
        .sf-wrap .t1 { animation: sf-twinkle 2.5s ease-in-out infinite; }
        .sf-wrap .t2 { animation: sf-twinkle 3.5s ease-in-out infinite; animation-delay: 0.6s; }
        .sf-wrap .t3 { animation: sf-twinkle 4.5s ease-in-out infinite; animation-delay: 1.4s; }
        .sf-wrap .t4 { animation: sf-twinkle 5.5s ease-in-out infinite; animation-delay: 2.2s; }
        @media (prefers-reduced-motion: reduce) {
          .sf-drift { animation: none; }
          .sf-wrap .t1,
          .sf-wrap .t2,
          .sf-wrap .t3,
          .sf-wrap .t4 { animation: none; opacity: 0.6; }
        }
      `}</style>
      <div className="sf-wrap" aria-hidden="true">
        <div className="sf-drift">
          <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">{STARS}</svg>
          <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">{STARS}</svg>
        </div>
      </div>
    </>
  );
}

export default memo(Starfield);
