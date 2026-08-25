import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminShell from "@/components/admin/admin-shell";
import { GradingWorkstation } from "@/components/grading-workflow/GradingWorkstation";
import { createCanonicalHarnessFetchFixture } from "./dev-canonical-workstation-harness";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";
import {
  ADMIN_FOCUS_HEADER_CLASS,
  ADMIN_FOCUS_SURFACE_CLASS,
  ADMIN_FOCUS_WORKSTATION_CLASS,
} from "@/components/admin/admin-focus-surface";

/**
 * DEV-ONLY admin focus-surface GEOMETRY harness.
 *
 * The black band the owner reported is a property of the /admin focus SHELL —
 * `.admin-root` → `.admin-focus` → focus surface → [header, workstation] — and
 * of nothing inside the workstation. Reproducing it needs the real ancestry and
 * the real compiled CSS, but not a real certificate: the grading body only ever
 * fills a box whose height the shell has already decided.
 *
 * /admin itself is behind the two-step admin login, so it cannot be measured in
 * an automated pass without handling a password. This route mounts the SAME
 * `AdminShell focus`, the SAME `AdminHeaderRow` primitive and the SAME three
 * exported class constants the route ships, with an over-tall stub standing in
 * for the workstation. It measures the real thing because it IS the real thing;
 * the constants are imported, not copied, so the harness cannot drift from the
 * route it certifies.
 *
 * The stub is deliberately far taller than any viewport. A bound that only
 * holds for short content is not a bound — this proves the surface stays one
 * viewport tall while its child is actively trying to push it open, which is
 * the condition the real grading body creates and the condition under which the
 * pre-2026-08-17 layout inflated the page to 2568px.
 */

function makeHarnessQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const response = await fetch(String(queryKey[0]), { credentials: "include" });
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
          return response.json();
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * The PRE-2026-08-17 class strings, kept verbatim so the black band can still
 * be reproduced and measured on demand (`?legacy=1`) rather than only described
 * in a commit message. This is the before-image for the band measurement and
 * the live demonstration that the 4.5rem guess — not the padding, not
 * `min-h-[100dvh]` — is what produced the dead space.
 *
 * These strings are DEAD to the shipping route (dev-only module, DEV-gated
 * route, constant-folded out of the production bundle). They are deliberately
 * NOT re-exported: nothing may import them back into a real surface.
 */
const LEGACY_SURFACE_CLASS = "flex min-h-[100dvh] flex-col p-2.5";
const LEGACY_HEADER_CLASS = "";
const LEGACY_WORKSTATION_CLASS = "flex min-h-0 flex-col md:h-[calc(100dvh-4.5rem)]";

export default function DevAdminShellGeometryHarness() {
  const legacy = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("legacy") === "1";
  const surfaceClass = legacy ? LEGACY_SURFACE_CLASS : ADMIN_FOCUS_SURFACE_CLASS;
  const headerClass = legacy ? LEGACY_HEADER_CLASS : ADMIN_FOCUS_HEADER_CLASS;
  const workstationClass = legacy ? LEGACY_WORKSTATION_CLASS : ADMIN_FOCUS_WORKSTATION_CLASS;
  const stub = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("stub") === "1";
  const queryClient = useMemo(makeHarnessQueryClient, []);
  // The fixture must be installed BEFORE the workstation mounts, so nothing it
  // requests can escape to a real backend. `ready` gates the first render.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (stub) {
      setReady(true);
      return;
    }
    const originalFetch = window.fetch.bind(window);
    window.fetch = createCanonicalHarnessFetchFixture(originalFetch).fetch;
    setReady(true);
    return () => {
      window.fetch = originalFetch;
    };
  }, [stub]);
  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <AdminShell activeTab="certs" onTabChange={() => {}} onLogout={() => {}} focus>
        {/* Byte-identical composition to admin-dashboard.tsx's focus branch:
            surface → shrink-0 header → flex-1 workstation. */}
        <div className={surfaceClass} data-testid="admin-focus-surface" data-legacy={legacy ? "1" : "0"}>
          <div className={headerClass} data-testid="admin-focus-header">
            <AdminHeaderRow
              testId="grading-header"
              left={
                <>
                  <button className="text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] text-sm transition-colors">
                    &larr; Certificates
                  </button>
                  <span
                    className="text-sm font-bold tracking-wide text-[var(--admin-gold)]"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    MV0000
                  </span>
                </>
              }
              right={
                <div className="flex items-center gap-2">
                  <button className="rounded border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/80">
                    Card Metadata
                  </button>
                  <button className="rounded border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/80">
                    Certificate Tools
                  </button>
                </div>
              }
            />
          </div>
          <div className={workstationClass} data-testid="admin-focus-workstation">
            {stub ? (
              /* Over-tall STUB body (`?stub=1`). A bound that only holds for
                 short content is not a bound — this proves the surface stays one
                 viewport tall while its child actively tries to push it open,
                 which is the condition that inflated the page to 2568px before. */
              <div className="flex min-h-0 h-full flex-col" data-testid="grading-workspace">
                <div className="flex min-h-0 flex-1 flex-col gap-2 min-[540px]:flex-row">
                  <aside
                    className="min-h-0 max-[539px]:basis-1/2 max-[539px]:flex-1 min-[540px]:w-[45%] min-[540px]:shrink-0 rounded border border-[var(--admin-line)] bg-[var(--admin-panel)]"
                    data-testid="grading-preview-panel"
                  >
                    <div className="p-2 text-xs text-[var(--admin-ink-dim)]">card rail (stub)</div>
                  </aside>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel">
                    <div className="shrink-0 space-y-1 text-xs text-[var(--admin-ink-dim)]">stage bar (stub)</div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1" data-testid="grading-scroll-body">
                      {Array.from({ length: 60 }, (_, i) => (
                        <div
                          key={i}
                          className="rounded border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4 text-xs text-[var(--admin-ink-dim)]"
                        >
                          grading body block {i + 1}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* DEFAULT: the REAL GradingWorkstation, driven by the canonical
                 harness's method/path-exact fetch fixture, inside the REAL admin
                 focus shell. This is the only surface in the repo where the card
                 can be measured in the geometry it actually ships in: the
                 canonical harness stacks five workstations on one scrolling
                 page, so `visibleViewportHeight - cardTop` there is a number the
                 production card never sees. */
              <GradingWorkstation
                mode="super-admin"
                apiBase="/api/admin"
                certId={9001}
                certIdStr="MV-0000009001"
                cardName="Charizard"
                cardSet="Base Set"
                cardNumber="4/102"
                cardYear="1999"
                cardLanguage="English"
                cardVariant="Rare Holo · Holo"
                cardGame="pokemon"
                existingGrade="9.5"
                pendingAnalysis={null}
                onPendingAnalysisConsumed={() => {}}
                onManualIdentification={() => {}}
                onGradeApproved={() => {}}
                onCertUpdated={async () => {}}
              />
            )}
          </div>
        </div>
      </AdminShell>
    </QueryClientProvider>
  );
}
