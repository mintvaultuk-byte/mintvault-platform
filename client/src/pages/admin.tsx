import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import AdminDashboard from "./admin-dashboard";

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authReason, setAuthReason] = useState<string>("");
  const [location, navigate] = useLocation();
  // Deep-link: /admin/promotions opens the dashboard on the Promotions tab.
  const initialTab = location === "/admin/promotions" ? ("promotions" as const) : undefined;

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const res = await fetch("/api/admin/session", { credentials: "include" });
        if (!res.ok) {
          let reason = "";
          try {
            reason = (await res.json())?.reason || "";
          } catch {
            reason = "";
          }
          if (!cancelled) {
            setAuthReason(reason);
            setAuthenticated(false);
          }
          return;
        }
        const data = await res.json();
        if (!data.authenticated) {
          if (!cancelled) {
            setAuthReason(data.reason || "");
            setAuthenticated(false);
          }
          return;
        }

        const statsRes = await fetch("/api/admin/stats", { credentials: "include" });
        if (statsRes.status === 401) {
          if (!cancelled) setAuthenticated(false);
          return;
        }

        if (!cancelled) setAuthenticated(true);
      } catch {
        if (!cancelled) setAuthenticated(false);
      }
    }

    checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authenticated === false) {
      // Preserve the full path + query (e.g. /admin?search=MV430 from the
      // scanner "Grade" deep link) through the login round-trip — wouter's
      // `location` is the pathname only, so append the live query string.
      const search = typeof window !== "undefined" ? window.location.search : "";
      const target = (location || "/admin") + search;
      const reason = authReason ? `&reason=${encodeURIComponent(authReason)}` : "";
      navigate(`/admin/login?next=${encodeURIComponent(target)}${reason}`, { replace: true });
    }
  }, [authenticated, navigate, location, authReason]);

  if (authenticated !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse">
          <div className="h-8 bg-[#D4AF37]/10 rounded w-32 mx-auto" />
        </div>
      </div>
    );
  }

  return <AdminDashboard onLogout={() => navigate("/cert")} initialTab={initialTab} />;
}
