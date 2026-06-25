import { useEffect, useState } from "react";

/**
 * "Install app" button for the staff / admin portal PWA.
 *
 * Captures the browser's `beforeinstallprompt` so a staff member (grader, printer)
 * or admin can install the portal as a standalone app — its own window / Mac dock
 * icon — from inside the product rather than hunting through the browser menu.
 *
 * Mount timing: this button lives in a lazy-loaded, auth-gated portal page, so it
 * mounts LATE — after Chrome may already have fired `beforeinstallprompt`. An
 * early-capture snippet in index.html stashes that event on `window` before React
 * boots; we read the stash on mount AND keep a live listener (for slow loads), so
 * the button shows reliably on first load without a hard refresh.
 *
 * Renders NOTHING unless an install offer is actually available — so it hides
 * gracefully when already installed, on browsers that don't support the prompt
 * (Safari/Firefox), or when the install criteria aren't met yet.
 *
 * Scope note: this is the web PORTAL only (grade / print / queue). It does NOT
 * drive the USB scanner — that's the separate Electron desktop app.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    // Set by the early-capture snippet in index.html, before React mounts.
    __deferredInstallPrompt?: BeforeInstallPromptEvent | null;
    __pwaInstalled?: boolean;
  }
}

export default function InstallAppButton({
  className,
  label = "Install app",
}: {
  className?: string;
  label?: string;
}) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Already launched as / already an installed app → nothing to offer.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone || window.__pwaInstalled) {
      setHidden(true);
      return;
    }

    // (1) The event may have fired — and been stashed by index.html — before this
    //     late-mounting component existed. Pick it up immediately.
    if (window.__deferredInstallPrompt) {
      setDeferred(window.__deferredInstallPrompt);
    }

    // (2) Keep listening live too, for slow loads where the event fires after mount
    //     (covers both the native event and the early-capture's CustomEvent relay).
    const onPrompt = (e: Event) => {
      e.preventDefault();
      window.__deferredInstallPrompt = e as BeforeInstallPromptEvent;
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onAvailable = () => {
      if (window.__deferredInstallPrompt) setDeferred(window.__deferredInstallPrompt);
    };
    const onInstalled = () => {
      window.__deferredInstallPrompt = null;
      setDeferred(null);
      setHidden(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("pwa-install-available", onAvailable);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("pwa-installed", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("pwa-install-available", onAvailable);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("pwa-installed", onInstalled);
    };
  }, []);

  // Hidden when installed / unsupported / not-yet-installable — graceful no-op.
  if (hidden || !deferred) return null;

  return (
    <button
      type="button"
      className={className}
      title="Install this portal as an app — opens in its own window"
      data-testid="button-install-pwa"
      onClick={async () => {
        const e = deferred;
        setDeferred(null);
        window.__deferredInstallPrompt = null; // one-shot: the event is consumed
        try {
          await e.prompt();
          await e.userChoice;
        } catch {
          /* user dismissed or prompt no longer valid — nothing to do */
        }
      }}
    >
      {label}
    </button>
  );
}
