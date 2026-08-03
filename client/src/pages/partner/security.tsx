/**
 * Partner Portal — Security & Account. Uses the existing Phase 1 revoke-all-sessions endpoint
 * (server/partner/routes.ts) — real functionality, not a stub, since it needs no deferred backend.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerAuth, partnerErrorMessage, partnerSessions } from "@/lib/partner-api";

export default function PartnerSecurityPage() {
  const { session } = usePartnerSession();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["/api/partner/sessions"], queryFn: () => partnerSessions.list() });
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

  async function revokeSession(sessionId: string, current: boolean) {
    setError(null);
    try {
      await partnerSessions.revoke(sessionId);
      if (current) {
        window.location.href = "/partner/login";
        return;
      }
      await qc.invalidateQueries({ queryKey: ["/api/partner/sessions"] });
    } catch (err) {
      setError(partnerErrorMessage(err));
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
            Signed in as <span data-testid="text-security-user-id">{session?.displayName ?? "Unknown"}</span>
          </p>
          <p className="text-muted-foreground">Two-step verification is required for every sign-in on this account.</p>
        </CardContent>
      </Card>

      <section aria-labelledby="active-sessions-title" className="space-y-3">
        <h2 id="active-sessions-title" className="text-base font-semibold">
          Active sessions
        </h2>
        {sessions.isLoading && <p className="text-sm text-muted-foreground">Loading sessions…</p>}
        {sessions.error && <p className="text-sm text-destructive">{partnerErrorMessage(sessions.error)}</p>}
        {sessions.data?.sessions.filter((item) => !item.revokedAt).length === 0 && (
          <p className="text-sm text-muted-foreground">No active sessions</p>
        )}
        <div className="space-y-2" data-testid="list-partner-sessions">
          {sessions.data?.sessions
            .filter((item) => !item.revokedAt)
            .map((item) => (
              <div
                key={item.id}
                className="border border-border rounded-md p-3 flex items-center justify-between gap-4 text-sm"
              >
                <div>
                  <p className="font-medium">{item.current ? "This device" : "Partner session"}</p>
                  <p className="text-xs text-muted-foreground">
                    Last active {item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString("en-GB") : "Unknown"}
                    {item.ip ? ` · ${item.ip}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void revokeSession(item.id, item.current)}
                >
                  Revoke
                </Button>
              </div>
            ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Sign out everywhere</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            If you think someone else has access to your account, sign out of every device. You'll need to sign in again
            here.
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
          <Button
            variant="outline"
            disabled={revoking}
            onClick={handleRevokeAll}
            data-testid="button-revoke-all-sessions"
          >
            {revoking ? "Signing out everywhere…" : "Sign out everywhere"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
