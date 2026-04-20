import { useEffect, useState } from "react";

const STORAGE_KEY = "mv_cookie_acknowledged";

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      // localStorage unavailable (private browsing, etc.) — show banner, no persistence
      setVisible(true);
    }
  }, []);

  async function acknowledge() {
    try {
      await fetch("/api/cookies/acknowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      // Non-blocking — localStorage write is the source of truth for dismissal
    }
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()); } catch {}
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie notice"
      className="fixed bottom-0 left-0 right-0 z-[200] border-t"
      style={{
        backgroundColor: "var(--v2-paper)",
        borderColor: "var(--v2-line)",
      }}
    >
      <div className="mx-auto max-w-7xl px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <p
          className="font-body text-sm flex-1 leading-relaxed"
          style={{ color: "var(--v2-ink-soft)" }}
        >
          We use strictly necessary cookies to make this site work. No analytics or tracking.
        </p>
        <button
          type="button"
          onClick={acknowledge}
          data-testid="button-cookie-acknowledge"
          className="font-body text-sm font-semibold px-5 py-2 rounded-full whitespace-nowrap transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
        >
          I understand
        </button>
      </div>
    </div>
  );
}
