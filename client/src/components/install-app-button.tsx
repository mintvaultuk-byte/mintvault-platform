import { useEffect, useState } from "react";

/**
 * "Install app" button for the staff / admin portal PWA.
 *
 * Captures the browser's `beforeinstallprompt` so a staff member (grader, printer)
 * or admin can install the portal as a standalone app — its own window / Mac dock
 * icon — from inside the product rather than hunting through the browser menu.
 *
 * Renders NOTHING unless the browser is actively offering installation, so it
 * hides gracefully when: already installed, the browser doesn't support the
 * prompt (Safari/Firefox), or the install criteria aren't met yet.
 *
 * Scope note: this is the web PORTAL only (grade / print / queue). It does NOT
 * drive the USB scanner — that's the separate Electron desktop app.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function InstallAppButton({ className, label = "Install app" }: { className?: string; label?: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Already launched as an installed app → nothing to offer.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) {
      setHidden(true);
      return;
    }

    const onPrompt = (e: Event) => {
      // Stop Chrome's default mini-infobar; we surface our own button instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setHidden(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
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
        setDeferred(null); // one-shot: the event can only be used once
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
