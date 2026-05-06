/**
 * Site-wide static vault image background.
 *
 * Mounts a fixed <div> with the vault image as background, behind all
 * page content (z-index: -1). No scroll-driven animation — image holds
 * full-viewport on every page.
 *
 * Page sections with opaque backgrounds will completely hide the image.
 * It only shows through where a section is transparent or frosted.
 */
export default function VaultVideoBg() {
  return (
    <>
      <div
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
          zIndex: -1,
          pointerEvents: "none",
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
