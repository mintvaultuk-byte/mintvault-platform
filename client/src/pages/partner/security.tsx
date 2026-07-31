/**
 * Partner Portal — Security & Account.
 *
 * Two real controls, both backed by existing Phase 1 endpoints (server/partner/routes.ts):
 *   • Two-step verification — set up or replace an authenticator, and regenerate recovery codes.
 *   • Sign out everywhere — POST /auth/revoke-all.
 *
 * The two-step section used to be a single sentence of prose asserting that two-step was required,
 * with no control behind it and — until P0-E — no truth behind it either. It now reports the
 * account's ACTUAL state from GET /api/partner/session (mfaEnrolled / mfaEnrolmentRequired /
 * recoveryCodesRemaining) and offers the enrolment flow that state calls for.
 *
 * Secrets are never held here: the setup key, QR and recovery codes live inside
 * <PartnerMfaEnrolment>, are shown once and are never persisted. The password typed for elevated
 * verification is dropped from state the moment the flow it authorises finishes.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerAuth, partnerMfa, partnerErrorMessage } from "@/lib/partner-api";
import { PartnerMfaEnrolment } from "@/components/partner/partner-mfa-enrolment";

type MfaPanel = "idle" | "password" | "enrol" | "regenerating" | "codes";

export default function PartnerSecurityPage() {
  const { session, refresh } = usePartnerSession();
  const [revoking, setRevoking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [panel, setPanel] = useState<MfaPanel>("idle");
  /** What the password prompt is authorising — the two flows need different follow-ups. */
  const [intent, setIntent] = useState<"enrol" | "regenerate">("enrol");
  const [password, setPassword] = useState("");
  /**
   * A code from the CURRENT authenticator, collected only when REPLACING one that is already set up.
   * The server requires password PLUS a current factor for a replacement (F3) — the same proof it
   * has always required to switch two-step off. Held in state for the single enrolment call and
   * cleared with the password. First-time setup never shows this field.
   */
  const [currentCode, setCurrentCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[]>([]);

  const enrolled = session?.mfaEnrolled ?? false;
  const enrolmentRequired = session?.mfaEnrolmentRequired ?? false;
  const codesLeft = session?.recoveryCodesRemaining;

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

  function askForPassword(next: "enrol" | "regenerate") {
    setIntent(next);
    setMfaError(null);
    setNewCodes([]);
    setPassword("");
    setCurrentCode("");
    setPanel("password");
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMfaError(null);
    if (intent === "enrol") {
      // The enrolment component performs the elevated /mfa/enrol call itself with this password.
      setPanel("enrol");
      return;
    }
    setPanel("regenerating");
    try {
      const out = await partnerMfa.regenerateRecoveryCodes(password);
      setNewCodes(out.recoveryCodes ?? []);
      setPassword(""); // no longer needed
      setPanel("codes");
      await refresh();
    } catch (err) {
      setMfaError(partnerErrorMessage(err));
      setPanel("password");
    }
  }

  async function handleEnrolmentComplete() {
    setPassword("");
    setCurrentCode("");
    setPanel("idle");
    await refresh();
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Two-step verification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm" data-testid="text-mfa-status">
            {enrolled
              ? "An authenticator app is set up on this account. You need a code from it every time you sign in."
              : enrolmentRequired
                ? "This account requires two-step verification, but no authenticator app is set up yet. Set one up to keep using the Portal."
                : "No authenticator app is set up on this account yet."}
          </p>
          {enrolled && typeof codesLeft === "number" && (
            <p className="text-sm text-muted-foreground" data-testid="text-recovery-codes-remaining">
              {codesLeft} unused recovery code{codesLeft === 1 ? "" : "s"} left.
            </p>
          )}

          {panel === "idle" && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={enrolled ? "outline" : "default"}
                onClick={() => askForPassword("enrol")}
                data-testid="button-mfa-setup"
              >
                {enrolled ? "Replace authenticator app" : "Set up authenticator app"}
              </Button>
              {enrolled && (
                <Button
                  variant="outline"
                  onClick={() => askForPassword("regenerate")}
                  data-testid="button-mfa-regenerate-codes"
                >
                  Generate new recovery codes
                </Button>
              )}
            </div>
          )}

          {(panel === "password" || panel === "regenerating") && (
            <form onSubmit={handlePasswordSubmit} className="space-y-3" data-testid="form-mfa-password">
              <p className="text-sm text-muted-foreground">
                {intent === "enrol"
                  ? enrolled
                    ? "Confirm your password and a code from your current authenticator app to replace it."
                    : "Confirm your password to set up an authenticator app."
                  : "Confirm your password to replace your recovery codes. Your old codes stop working."}
              </p>
              <div className="space-y-2">
                <Label htmlFor="partner-security-password">Password</Label>
                <Input
                  id="partner-security-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-mfa-password"
                />
              </div>
              {intent === "enrol" && enrolled && (
                <div className="space-y-2">
                  <Label htmlFor="partner-security-current-code">Code from your current authenticator app</Label>
                  <Input
                    id="partner-security-current-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={currentCode}
                    onChange={(e) => setCurrentCode(e.target.value)}
                    data-testid="input-mfa-current-code"
                  />
                  <p className="text-xs text-muted-foreground">
                    You can enter one of your recovery codes here instead. It will be used up.
                  </p>
                </div>
              )}
              {mfaError && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-mfa-error">
                  {mfaError}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={panel === "regenerating"} data-testid="button-mfa-password-submit">
                  {panel === "regenerating" ? "Working…" : "Continue"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPassword("");
                    setCurrentCode("");
                    setMfaError(null);
                    setPanel("idle");
                  }}
                  data-testid="button-mfa-cancel"
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {panel === "enrol" && (
            <PartnerMfaEnrolment
              password={password}
              secondFactor={
                enrolled
                  ? /^[0-9]{6}$/.test(currentCode.trim())
                    ? { code: currentCode.trim() }
                    : { recoveryCode: currentCode.trim() }
                  : undefined
              }
              onComplete={handleEnrolmentComplete}
              onUseExistingAuthenticator={() => {
                setPassword("");
                setCurrentCode("");
                setPanel("idle");
              }}
            />
          )}

          {panel === "codes" && (
            <div className="space-y-3" data-testid="partner-security-recovery-codes">
              <p className="text-sm text-muted-foreground">
                These replace your old recovery codes and are shown once. Keep them somewhere safe and private.
              </p>
              <ul className="rounded-md border p-3 font-mono text-sm space-y-1" data-testid="list-new-recovery-codes">
                {newCodes.map((rc) => (
                  <li key={rc}>{rc}</li>
                ))}
              </ul>
              <Button
                onClick={() => {
                  setNewCodes([]);
                  setPanel("idle");
                }}
                data-testid="button-recovery-codes-done"
              >
                I have saved these
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

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
