import { useLocation } from "wouter";
import AdminDashboard from "./admin-dashboard";
import type { AdminTab } from "@/components/admin/admin-shell";

const ADMIN_DEEP_LINK_TABS = new Set<AdminTab>([
  "dashboard", "certs", "submissions", "intake", "pricing", "promotions",
  "capacity", "printing", "print-queue", "grading", "learning", "capture-health",
  "divergence", "transfers", "scans", "sets",
]);

export default function AdminPage() {
  const [location] = useLocation();
  // Command Centre links use only this fixed existing-admin-tab allow-list; no
  // browser-controlled value can select an arbitrary admin surface.
  const requestedTab = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
  const initialTab = location === "/admin/promotions"
    ? ("promotions" as const)
    : requestedTab && ADMIN_DEEP_LINK_TABS.has(requestedTab as AdminTab)
      ? requestedTab as AdminTab
      : undefined;

  return <AdminDashboard initialTab={initialTab} />;
}
