/**
 * Partner Portal — "set a new password" page, reached from the single-use link in the reset email.
 *
 * Maps onto POST /api/partner/auth/password-reset/consume { token, newPassword }. The token comes
 * from the query string, is held in memory only, and is never rendered on screen or put into any
 * other request. The server derives the account from the token — this page never sends an email,
 * user id or organisation, so it cannot be pointed at somebody else's account.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { partnerPasswordReset, PARTNER_MIN_PASSWORD_LEN } from "@/lib/partner-api";

const LINK_FAILED =
  "This link can't be used. Reset links work once and expire quickly — request a new one and try again.";

export default function PartnerPasswordResetPage() {
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
    if (password.length < PARTNER_MIN_PASSWORD_LEN) {
      setError(`Choose a password with at least ${PARTNER_MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await partnerPasswordReset.consume(token, password);
      setDone(true);
    } catch {
      setError(LINK_FAILED);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle data-testid="text-reset-title">Set a new password</CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4" data-testid="partner-reset-done">
              <p className="text-sm text-muted-foreground">
                Your password has been changed. For your security you've been signed out everywhere — sign in again with
                your new password.
              </p>
              <Button className="w-full" onClick={() => navigate("/partner/login")} data-testid="button-reset-signin">
                Sign in
              </Button>
            </div>
          ) : !token ? (
            <div className="space-y-4" data-testid="partner-reset-no-token">
              <p role="alert" className="text-sm text-destructive">
                {LINK_FAILED}
              </p>
              <Button asChild className="w-full" data-testid="button-reset-request-again">
                <Link href="/partner/forgot-password">Request a new link</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" data-testid="form-partner-reset">
              <div className="space-y-2">
                <Label htmlFor="partner-reset-password">New password</Label>
                <Input
                  id="partner-reset-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-reset-password"
                />
                <p className="text-xs text-muted-foreground">At least {PARTNER_MIN_PASSWORD_LEN} characters.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-reset-confirm">Confirm new password</Label>
                <Input
                  id="partner-reset-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  data-testid="input-reset-confirm"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-reset-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting} data-testid="button-reset-submit">
                {submitting ? "Saving…" : "Set new password"}
              </Button>
              <Link
                href="/partner/login"
                className="block text-sm text-muted-foreground underline text-center"
                data-testid="link-reset-back"
              >
                Back to sign in
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
