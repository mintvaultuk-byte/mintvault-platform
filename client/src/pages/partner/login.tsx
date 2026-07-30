/**
 * Partner Portal — sign-in + MFA (Increment A). Two-step form matching the Phase 1 API exactly:
 * POST /auth/login (email+password) may return mfaRequired; if so, POST /auth/mfa (code or
 * recovery code) completes the session. No auth logic is duplicated client-side — every decision
 * is the server's.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { partnerAuth, partnerErrorMessage } from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { PartnerMfaEnrolment } from "@/components/partner/partner-mfa-enrolment";

const GENERIC_LOGIN_ERROR = "We could not sign you in with those details.";

export default function PartnerLoginPage() {
  const [, navigate] = useLocation();
  const { refresh } = usePartnerSession();
  /**
   * A user arriving straight from accepting an invitation (/partner/invite sends them here with
   * ?setup=1) has two-factor REQUIRED but no authenticator registered, so the code step is
   * impossible for them — send them to enrolment as soon as the password is accepted.
   */
  const setupRequested = useMemo(() => new URLSearchParams(window.location.search).get("setup") === "1", []);
  const [step, setStep] = useState<"credentials" | "mfa" | "enrol">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await partnerAuth.login(email, password);
      await refresh();
      if (result.mfaRequired) {
        setStep(setupRequested ? "enrol" : "mfa");
      } else {
        navigate("/partner/dashboard");
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setError(status === 401 || status === 429 || status === 503 ? GENERIC_LOGIN_ERROR : partnerErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await partnerAuth.mfa(useRecovery ? { recoveryCode } : { code });
      await refresh();
      navigate("/partner/dashboard");
    } catch (err) {
      setError(partnerErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Enrolment finished (code confirmed AND recovery codes acknowledged) — the session is now
   *  fully authenticated server-side, so drop the password from memory and continue. */
  async function handleEnrolmentComplete() {
    setPassword("");
    await refresh();
    navigate("/partner/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle data-testid="text-login-title">MintVault Partner sign in</CardTitle>
        </CardHeader>
        <CardContent>
          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="space-y-4" data-testid="form-partner-login">
              <div className="space-y-2">
                <Label htmlFor="partner-email">Email</Label>
                <Input
                  id="partner-email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-password">Password</Label>
                <Input
                  id="partner-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-password"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-login-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting} data-testid="button-login-submit">
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
              <Link
                href="/partner/forgot-password"
                className="block text-sm text-muted-foreground underline text-center"
                data-testid="link-forgot-password"
              >
                Forgotten your password?
              </Link>
            </form>
          )}

          {step === "enrol" && (
            <PartnerMfaEnrolment
              password={password}
              onComplete={handleEnrolmentComplete}
              onUseExistingAuthenticator={() => setStep("mfa")}
            />
          )}

          {step === "mfa" && (
            <form onSubmit={handleMfa} className="space-y-4" data-testid="form-partner-mfa">
              <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
              {!useRecovery ? (
                <div className="space-y-2">
                  <Label htmlFor="partner-mfa-code">Authentication code</Label>
                  <Input
                    id="partner-mfa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    data-testid="input-mfa-code"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="partner-recovery-code">Recovery code</Label>
                  <Input
                    id="partner-recovery-code"
                    required
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    data-testid="input-recovery-code"
                  />
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="text-mfa-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting} data-testid="button-mfa-submit">
                {submitting ? "Verifying…" : "Verify"}
              </Button>
              <button
                type="button"
                className="text-sm text-muted-foreground underline w-full text-center"
                data-testid="button-toggle-recovery"
                onClick={() => setUseRecovery((v) => !v)}
              >
                {useRecovery ? "Use an authentication code instead" : "Use a recovery code instead"}
              </button>
              <button
                type="button"
                className="text-sm text-muted-foreground underline w-full text-center"
                data-testid="button-start-mfa-enrolment"
                onClick={() => {
                  setError(null);
                  setStep("enrol");
                }}
              >
                Set up an authenticator app
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
