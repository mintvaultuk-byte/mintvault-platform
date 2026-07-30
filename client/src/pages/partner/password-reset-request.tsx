/**
 * Partner Portal — "forgotten your password" request page.
 *
 * Maps onto POST /api/partner/auth/password-reset/request, which ALWAYS answers { ok: true }
 * regardless of whether the address belongs to an account. This screen mirrors that exactly: one
 * confirmation message for every outcome, so the page can never be used to work out who has a
 * MintVault Partner account. The reset link is delivered by email only — never shown here.
 */
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { partnerPasswordReset } from "@/lib/partner-api";

const ALWAYS_SUCCESS =
  "If that email address has a Partner Portal account, we've sent it a link to set a new password. The link can only be used once, and expires shortly.";

export default function PartnerPasswordResetRequestPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await partnerPasswordReset.request(email);
    } catch {
      // Deliberately ignored: showing a failure here (rate limit, portal disabled, outage) would
      // leak more than it helps, and the server's own answer is identical in every case.
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle data-testid="text-reset-request-title">Reset your password</CardTitle>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4" data-testid="partner-reset-request-sent">
              <p className="text-sm text-muted-foreground" data-testid="text-reset-request-sent">
                {ALWAYS_SUCCESS}
              </p>
              <Button asChild className="w-full" data-testid="button-reset-request-back">
                <Link href="/partner/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" data-testid="form-partner-reset-request">
              <p className="text-sm text-muted-foreground">
                Enter the email address you use for the Partner Portal and we'll send you a link to set a new password.
              </p>
              <div className="space-y-2">
                <Label htmlFor="partner-reset-email">Email</Label>
                <Input
                  id="partner-reset-email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-reset-email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting} data-testid="button-reset-request-submit">
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
              <Link
                href="/partner/login"
                className="block text-sm text-muted-foreground underline text-center"
                data-testid="link-reset-request-back"
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
