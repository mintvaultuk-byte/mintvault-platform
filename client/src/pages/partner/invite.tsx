/** Secure fragment-only Partner invitation acceptance page. */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { partnerAuth, partnerErrorMessage } from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";

export default function PartnerInvitationPage() {
  const [, navigate] = useLocation();
  const { refresh } = usePartnerSession();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const received = fragment.get("token") ?? "";
    // The fragment never reaches the server. Remove it from history immediately after reading and
    // retain it only in component memory until the one acceptance request completes.
    window.history.replaceState(null, document.title, "/partner/invite");
    setToken(received);
    if (!received) setMessage("This invitation link is incomplete or has already been cleared.");
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setMessage(null);
    setSubmitting(true);
    try {
      await partnerAuth.acceptInvitation({ token, email, password });
      setToken("");
      setPassword("");
      await refresh();
      navigate("/partner/dashboard", { replace: true });
    } catch (error) {
      setToken(""); // a failed/terminal invite is never retained for retry in browser state.
      setMessage(partnerErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Accept Partner invitation</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} data-testid="form-partner-invitation">
            <p className="text-sm text-muted-foreground">
              Confirm the invited email address and choose a secure password to activate your Partner access.
            </p>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-password">Password</Label>
              <Input
                id="invite-password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {message && (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={!token || submitting}>
              {submitting ? "Activating…" : "Activate Partner access"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
