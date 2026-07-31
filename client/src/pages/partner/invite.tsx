import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";

export default function PartnerInvitePage() {
  const [, navigate] = useLocation();
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? "", []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      await apiRequest("POST", "/api/partner/invitations/accept", { token, password });
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
              <div className="space-y-2">
                <Label htmlFor="partner-invite-password">Password</Label>
                <Input
                  id="partner-invite-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-partner-invite-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-invite-confirm">Confirm password</Label>
                <Input
                  id="partner-invite-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  data-testid="input-partner-invite-confirm"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-partner-invite-error">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={!token || submitting}
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
