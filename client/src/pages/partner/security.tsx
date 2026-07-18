/**
 * Partner Portal — Security & Account. Uses the existing Phase 1 revoke-all-sessions endpoint
 * (server/partner/routes.ts) — real functionality, not a stub, since it needs no deferred backend.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerAuth, partnerErrorMessage } from "@/lib/partner-api";

export default function PartnerSecurityPage() {
  const { session } = usePartnerSession();
  const [revoking, setRevoking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRevokeAll() {
    setRevoking(true);
    setError(null);
    setResult(null);
    try {
      const res = await partnerAuth.revokeAll();
      setResult(`Signed out of ${res.revoked} other session${res.revoked === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(partnerErrorMessage(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" data-testid="text-security-title">
        Security & Account
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <p>
            Signed in as <span data-testid="text-security-user-id">{session?.userId ?? "—"}</span>
          </p>
          <p className="text-muted-foreground">Two-step verification is required for every sign-in on this account.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign out everywhere</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            If you think someone else has access to your account, sign out of every device. You'll need to sign in
            again here.
          </p>
          {result && (
            <p className="text-sm text-primary" data-testid="text-revoke-result">
              {result}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="text-revoke-error">
              {error}
            </p>
          )}
          <Button variant="outline" disabled={revoking} onClick={handleRevokeAll} data-testid="button-revoke-all-sessions">
            {revoking ? "Signing out everywhere…" : "Sign out everywhere"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
