import { useEffect, useRef } from "react";

/**
 * Site-wide vault image background with scroll-driven zoom.
 *
 * Mounts a fixed <div> with the vault image as background, behind all
 * page content (z-index: -1). Scroll position drives transform: scale()
 * — image zooms in as user scrolls down, zooms out on scroll up.
 * Animation is rAF-throttled so we only update once per frame.
 *
 * Mobile / iOS / reduced-motion: bail out of scroll-zoom and just hold
 * scale 1.0 (static image). backdrop-filter on top of a transformed
 * fixed element causes scroll jank on older mobile, so static there.
 *
 * Page sections with opaque backgrounds will completely hide the image.
 * It only shows through where a section is transparent or frosted.
 */
export default function VaultVideoBg() {
  const imageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = imageRef.current;
    if (!el) return;

    const isMobile =
      window.innerWidth < 768 ||
      /iPhone|iPad|Android/i.test(navigator.userAgent);

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (isMobile || reduced) {
      el.style.transform = "scale(1)";
      return;
    }

    let rafId: number | null = null;
    let pending = false;

    const updateScale = () => {
      pending = false;
      const scrollMax = document.body.scrollHeight - window.innerHeight;
      if (scrollMax <= 0) {
        el.style.transform = "scale(1)";
        return;
      }
      const scrollPercent = Math.max(
        0,
        Math.min(1, window.scrollY / scrollMax),
      );
      const scale = 1 + scrollPercent * 0.4;
      el.style.transform = `scale(${scale})`;
    };

    const onScroll = () => {
      if (pending) return;
      pending = true;
      rafId = requestAnimationFrame(updateScale);
    };

    updateScale();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <>
      <div
        ref={imageRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          backgroundImage: "url('/images/hero-vault.webp')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          transform: "scale(1)",
          transformOrigin: "center center",
          transition: "transform 0.1s linear",
          zIndex: -1,
          pointerEvents: "none",
          willChange: "transform",
        }}
      />
      {/* Cream overlay — sits between image and page content for legibility
          on any page section that ends up transparent over the image. */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          background:
            "linear-gradient(180deg, rgba(248,244,232,0.4) 0%, rgba(248,244,232,0.2) 50%, rgba(248,244,232,0.4) 100%)",
          zIndex: -1,
          pointerEvents: "none",
        }}
      />
    </>
  );
}
