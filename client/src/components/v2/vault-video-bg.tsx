/**
 * Site-wide static vault image background.
 *
 * Mounts a fixed <div> with the vault image as background, behind all
 * page content (z-index: -1). No overlay, no scroll animation — image
 * holds full-viewport behind every page.
 */
export default function VaultVideoBg() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,6,4,0.75) 0%, rgba(8,6,4,0.65) 40%, rgba(8,6,4,0.85) 100%), url('/images/hero-vault.webp')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        zIndex: -1,
        pointerEvents: "none",
      }}
    />
  );
}
