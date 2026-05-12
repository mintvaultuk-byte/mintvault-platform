import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function VerifyEmailPage() {
  const queryClient = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";

  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState("");

  // Auto-consume the token on mount
  useEffect(() => {
    if (!token) { setStatus("error"); return; }

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
      method: "GET",
      redirect: "manual", // we handle redirects ourselves
    })
      .then((res) => {
        // Server redirects on success — a manual redirect or 2xx both count
        if (res.ok || res.status === 302 || res.type === "opaqueredirect") {
          setStatus("success");
          queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
        } else {
          setStatus("error");
        }
      })
      .catch(() => setStatus("error"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/resend-verification", {}),
    onSuccess: () => setResendSent(true),
    onError: () => setResendError("Failed to resend. Please try again."),
  });

  return (
    <>
      <SeoHead
        title="Verify Email | MintVault UK"
        description="Email verification for your MintVault account."
        canonical="https://mintvaultuk.com/verify-email"
      />
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-md bg-white rounded-2xl border border-[#E8E4DC] shadow-lg p-8 md:p-10 text-center">

          {status === "pending" && (
            <>
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
                <Loader2 size={24} className="text-[#D4AF37] animate-spin" />
              </div>
              <h1 className="text-xl font-black text-[#1A1A1A] mb-2">
                Verifying…
              </h1>
              <p className="text-sm text-[#888888]">Just a moment while we confirm your email.</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
                <CheckCircle size={24} className="text-[#D4AF37]" />
              </div>
              <h1 className="text-xl font-black text-[#1A1A1A] mb-3">
                Email Verified
              </h1>
              <p className="text-sm text-[#666666] mb-6">
                Your email address has been confirmed. Your account is fully active.
              </p>
              <Link href="/dashboard">
                <button
                  className="px-8 py-3 rounded-xl font-bold text-sm text-[#1A1400] transition-all"
                  style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                >
                  Go to Dashboard
                </button>
              </Link>
            </>
          )}

          {status === "error" && (
            <>
              <div className="w-14 h-14 rounded-full bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-5">
                <XCircle size={24} className="text-red-500" />
              </div>
              <h1 className="text-xl font-black text-[#1A1A1A] mb-3">
                Link Expired or Invalid
              </h1>
              <p className="text-sm text-[#666666] mb-6">
                This verification link has expired or has already been used. Request a new one below.
              </p>

              {resendSent ? (
                <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4">
                  A new verification link has been sent to your inbox.
                </div>
              ) : (
                <>
                  {resendError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
                      {resendError}
                    </p>
                  )}
                  <button
                    onClick={() => resendMutation.mutate()}
                    disabled={resendMutation.isPending}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm text-[#1A1400] disabled:opacity-60 transition-all mb-4"
                    style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                  >
                    {resendMutation.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Resend Verification Email
                  </button>
                </>
              )}

              <p className="text-xs text-[#888888] mt-2">
                <Link href="/dashboard" className="text-[#B8960C] font-semibold hover:text-[#D4AF37]">
                  Go to Dashboard
                </Link>
              </p>
            </>
          )}

        </div>
      </div>
    </>
  );
}
