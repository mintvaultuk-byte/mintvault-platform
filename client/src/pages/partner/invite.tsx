import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff } from "lucide-react";

export default function PartnerInvitePage() {
  const [, navigate] = useLocation();
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? "", []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    email: string;
    partnerName: string;
    roleCode: string;
    expiresAt: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [organisationPending, setOrganisationPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    setPreviewLoading(true);
    apiRequest("GET", `/api/partner/invitations/preview?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((body) => {
        if (!live) return;
        setPreview(body);
        setError(null);
      })
      .catch(() => {
        if (live) setError("This invitation is invalid or has expired. Ask MintVault to resend it.");
      })
      .finally(() => {
        if (live) setPreviewLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (error === "Passwords do not match." && password === confirm) {
      setError(null);
    }
  }, [confirm, error, password]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Choose a password with at least 10 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/partner/invitations/accept", { token, password });
      const body = (await res.json().catch(() => ({}))) as { organisationStatus?: string };
      setOrganisationPending(body.organisationStatus === "PENDING");
      setDone(true);
    } catch {
      setError("This invitation could not be accepted. Ask MintVault to resend it.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle data-testid="text-partner-invite-title">Set up Partner access</CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4" data-testid="partner-invite-done">
              {organisationPending && (
                <p className="text-sm font-medium text-amber-600" data-testid="text-partner-invite-org-pending">
                  Your account is ready, but your shop is awaiting activation.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Your password has been set. Next, sign in and set up an authenticator app. Two-step verification is
                required on every MintVault Partner account, so you will not be able to use the Portal until it is set
                up — it only takes a minute, and you will be taken straight there.
              </p>
              <Button
                className="w-full"
                onClick={() => navigate("/partner/login?setup=1")}
                data-testid="button-partner-invite-login"
              >
                Sign in and set up two-factor
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" data-testid="form-partner-invite">
              {previewLoading ? (
                <p className="text-sm text-muted-foreground" data-testid="text-partner-invite-loading">
                  Checking invitation...
                </p>
              ) : preview ? (
                <div className="rounded-md border p-3 text-sm" data-testid="partner-invite-preview">
                  <p>
                    Shop: <strong>{preview.partnerName}</strong>
                  </p>
                  <p>
                    Email: <strong>{preview.email}</strong>
                  </p>
                  <p>Role: {preview.roleCode}</p>
                  <p>Expires: {new Date(preview.expiresAt).toLocaleString()}</p>
                </div>
              ) : null}
              <div className="text-sm text-muted-foreground" data-testid="text-partner-invite-password-policy">
                Use at least 10 characters. This password is created by you and is never shown to MintVault admins.
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-invite-password">Password</Label>
                <div className="relative">
                  <Input
                    id="partner-invite-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-12"
                    data-testid="input-partner-invite-password"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid="button-partner-invite-toggle-password"
                  >
                    {showPassword ? <EyeOff aria-hidden="true" size={20} /> : <Eye aria-hidden="true" size={20} />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-invite-confirm">Confirm password</Label>
                <div className="relative">
                  <Input
                    id="partner-invite-confirm"
                    type={showConfirm ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="pr-12"
                    data-testid="input-partner-invite-confirm"
                  />
                  <button
                    type="button"
                    aria-label={showConfirm ? "Hide confirm password" : "Show confirm password"}
                    aria-pressed={showConfirm}
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid="button-partner-invite-toggle-confirm"
                  >
                    {showConfirm ? <EyeOff aria-hidden="true" size={20} /> : <Eye aria-hidden="true" size={20} />}
                  </button>
                </div>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-partner-invite-error">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={!token || submitting || previewLoading || !preview}
                data-testid="button-partner-invite-submit"
              >
                {submitting ? "Setting password..." : "Set password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
