import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/v2-tokens.css";
import "./styles/admin-tokens.css";

// v2 fonts: Fraunces (display italic), Geist (body), JetBrains Mono (code)
import "@fontsource/fraunces/400-italic.css";
import "@fontsource/fraunces/500-italic.css";
import "@fontsource/fraunces/600-italic.css";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource-variable/geist";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

createRoot(document.getElementById("root")!).render(<App />);

// PWA: register the minimal service worker ONLY on portal routes, so the
// staff/admin portal becomes installable (own window / dock icon). Marketing-only
// visitors never register a worker, so the public site's behaviour is unchanged.
// The worker does no caching (see public/sw.js) — the portal can't serve stale code.
if ("serviceWorker" in navigator && /^\/(staff|grader|admin)(\/|$)/.test(window.location.pathname)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker registration failed:", err);
    });
  });
}
