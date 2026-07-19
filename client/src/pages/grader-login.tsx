import { useEffect } from "react";
import { useLocation } from "wouter";

/** Legacy grader login — unified into the staff login. Redirects to /staff/login. */
export default function GraderLoginPage() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/staff/login", { replace: true });
  }, [navigate]);
  return (
    <div className="min-h-screen bg-[var(--admin-bg)] flex items-center justify-center">
      <div className="animate-pulse h-8 w-40 bg-[var(--admin-gold)]/10 rounded" />
    </div>
  );
}
