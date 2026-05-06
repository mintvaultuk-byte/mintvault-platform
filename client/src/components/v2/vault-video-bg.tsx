import { useEffect, useRef } from "react";

/**
 * Site-wide vault video background.
 *
 * Mounts a fixed <video> element behind all page content (z-index: -1).
 * Scroll position drives video.currentTime — vault door opens as user
 * scrolls down, reverses on scroll up. Animation is rAF-throttled so we
 * only seek once per frame regardless of scroll event frequency.
 *
 * Mobile / iOS / reduced-motion: bail out of scroll-driven mode and just
 * leave the video paused at frame 0 (currentTime updates are unreliable
 * on mobile Safari even with playsInline).
 *
 * Page sections with opaque backgrounds will completely hide the video.
 * It only shows through where a section is transparent — currently just
 * the homepage hero. Mounting site-wide is a deliberate design choice;
 * if perf becomes an issue, gate this component on the homepage route.
 */
export default function VaultVideoBg() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isMobile =
      window.innerWidth < 768 ||
      /iPhone|iPad|Android/i.test(navigator.userAgent);

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // On mobile or with reduced motion, just hold the first frame.
    if (isMobile || reduced) {
      video.currentTime = 0;
      return;
    }

    let rafId: number | null = null;
    let pending = false;

    const updateVideoTime = () => {
      pending = false;
      const scrollMax = document.body.scrollHeight - window.innerHeight;
      if (scrollMax <= 0) {
        video.currentTime = 0;
        return;
      }
      const scrollPercent = Math.max(
        0,
        Math.min(1, window.scrollY / scrollMax),
      );
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        video.currentTime = scrollPercent * duration;
      }
    };

    const onScroll = () => {
      if (pending) return;
      pending = true;
      rafId = requestAnimationFrame(updateVideoTime);
    };

    const onMetadata = () => {
      // Set initial frame to current scroll position, then track scroll.
      updateVideoTime();
      window.addEventListener("scroll", onScroll, { passive: true });
    };

    if (video.readyState >= 1 /* HAVE_METADATA */) {
      onMetadata();
    } else {
      video.addEventListener("loadedmetadata", onMetadata);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScroll);
      video.removeEventListener("loadedmetadata", onMetadata);
    };
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        src="/videos/hero-vault.mp4"
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          objectFit: "cover",
          zIndex: -1,
          pointerEvents: "none",
        }}
      />
      {/* Cream overlay — sits between video and page content for legibility
          on any page section that ends up transparent over the video. */}
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
