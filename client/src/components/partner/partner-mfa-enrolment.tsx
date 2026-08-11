/**
 * Partner Portal — authenticator (two-factor) enrolment.
 *
 * Why this exists: a newly-invited partner user is created with two-factor REQUIRED but with no
 * authenticator registered, so the sign-in page's "enter your 6-digit code" step was impossible to
 * satisfy — there was no way to register a device. This component is that missing step.
 *
 * It maps exactly onto the existing server contract (server/partner/routes.ts):
 *   POST /api/partner/mfa/enrol   { password }  -> { ok, secret, otpauthUri }
 *   POST /api/partner/mfa/confirm { code }      -> { ok, recoveryCodes }
 * Both accept an mfa-pending session, which is the state the user is in immediately after the
 * password step. No auth decision is made here — every outcome is the server's.
 *
 * The secret, the otpauth URI and the recovery codes are shown ONCE, held in component state only,
 * and never written to storage, the URL, or logs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { partnerMfa, PartnerApiError } from "@/lib/partner-api";

type Phase = "starting" | "scan" | "codes" | "blocked";

/** Plain-English text for the server's machine reasons — internal codes never reach the screen. */
function enrolStartMessage(err: unknown): string {
  const reason = err instanceof PartnerApiError ? err.message : "";
  if (reason === "encryption_unavailable")
    return "Two-factor setup is temporarily unavailable. Please try again shortly, or contact MintVault.";
  if (reason === "requires_current_factor")
    return "You already have an authenticator app set up for this account. Enter a code from it, or use a recovery code.";
  if (reason === "second_factor_required")
    return "That code from your current authenticator app was not right. Go back and try again, or use a recovery code.";
  if (reason === "unauthorised") return "We could not confirm your password. Please sign in again.";
  return "We could not start two-factor setup. Please try again, or contact MintVault if this continues.";
}

function confirmMessage(err: unknown): string {
  const reason = err instanceof PartnerApiError ? err.message : "";
  if (reason === "invalid_code") return "That code was not right. Check your authenticator app and try again.";
  if (reason === "no_pending" || reason === "expired")
    return "This setup has expired. Restart setup to get a fresh QR code.";
  if (reason === "requires_current_factor")
    return "You already have an authenticator app set up for this account. Enter a code from it, or use a recovery code.";
  return "We could not confirm that code. Please try again.";
}

/** Best-effort copy helper — the clipboard API is unavailable in some browsers and in tests. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clip = navigator.clipboard;
    if (!clip?.writeText) return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={testId}
      onClick={async () => {
        const ok = await copyToClipboard(value);
        setCopied(ok);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Renders the otpauth URI as a scannable QR using the qrcode package already bundled for
 *  certificate pages (client/src/pages/cert-detail.tsx) — no new dependency. If it cannot render,
 *  the setup key below it is still a complete, sufficient way to add the account by hand. */
function OtpauthQr({ uri }: { uri: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(uri, { width: 200, margin: 1, errorCorrectionLevel: "M" }))
      .then((du) => {
        if (alive) setDataUrl(du);
      })
      .catch(() => {
        /* the manual setup key below remains sufficient */
      });
    return () => {
      alive = false;
    };
  }, [uri]);

  if (!dataUrl) return null;
  return (
    <img
      src={dataUrl}
      width={200}
      height={200}
      className="mx-auto rounded-md bg-white p-2"
      alt="QR code for setting up your authenticator app"
      data-testid="img-mfa-qr"
    />
  );
}

export function PartnerMfaEnrolment({
  password,
  secondFactor,
  onComplete,
  onUseExistingAuthenticator,
}: {
  /** The password the user just entered — required by the server as elevated verification. */
  password: string;
  /**
   * A code from the CURRENT authenticator (or a recovery code), collected only when this flow is
   * REPLACING an authenticator that is already set up. The server requires it in that case and
   * ignores it otherwise (F3). Held only for the single /mfa/enrol call, never stored.
   */
  secondFactor?: { code?: string; recoveryCode?: string };
  /** Called once the user has confirmed a code AND acknowledged their recovery codes. */
  onComplete: () => void | Promise<void>;
  /** Back to the "enter a code" step, for a user who already has an authenticator. */
  onUseExistingAuthenticator: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [enrolmentId, setEnrolmentId] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [completing, setCompleting] = useState(false);
  /** Enrolment replaces any pending secret server-side, so it must fire exactly once per attempt —
   *  React 18 StrictMode double-invokes effects, which would otherwise invalidate the first QR. */
  const started = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const out = await partnerMfa.enrol(password, secondFactor);
      setEnrolmentId(out.enrolmentId);
      setSecret(out.secret);
      setOtpauthUri(out.otpauthUri);
      setCode("");
      setPhase("scan");
    } catch (err) {
      setError(enrolStartMessage(err));
      setPhase("blocked");
    }
  }, [password, secondFactor]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const normalizedCode = code.replace(/\s/g, "");
    if (!enrolmentId || !/^\d{6}$/.test(normalizedCode)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const out = await partnerMfa.confirm({ enrolmentId, code: normalizedCode });
      setRecoveryCodes(out.recoveryCodes ?? []);
      setSecret(""); // no longer needed — do not keep it on screen or in memory
      setOtpauthUri("");
      setEnrolmentId("");
      setCode("");
      setPhase("codes");
    } catch (err) {
      setError(confirmMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRestart() {
    if (restarting) return;
    setError(null);
    setRestarting(true);
    try {
      const out = await partnerMfa.restart();
      setEnrolmentId(out.enrolmentId);
      setSecret(out.secret);
      setOtpauthUri(out.otpauthUri);
      setCode("");
      setPhase("scan");
    } catch (err) {
      setError(enrolStartMessage(err));
    } finally {
      setRestarting(false);
    }
  }

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await partnerMfa.cancel();
    } finally {
      window.location.href = "/partner/login";
    }
  }

  if (phase === "starting") {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        role="status"
        data-testid="text-mfa-enrol-loading"
      >
        Setting up two-factor sign in…
      </div>
    );
  }

  if (phase === "blocked") {
    return (
      <div className="space-y-4" data-testid="partner-mfa-enrol-blocked">
        <p role="alert" className="text-sm text-destructive" data-testid="text-mfa-enrol-error">
          {error}
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onUseExistingAuthenticator}
          data-testid="button-mfa-enrol-back"
        >
          Enter a code instead
        </Button>
      </div>
    );
  }

  if (phase === "codes") {
    return (
      <div className="space-y-4" data-testid="partner-mfa-recovery-codes">
        <div className="space-y-1">
          <h2 className="font-semibold">Save your recovery codes</h2>
          <p className="text-sm text-muted-foreground">
            These are shown once and will not be shown again. Each one signs you in a single time if you lose your
            phone. Keep them somewhere safe and private.
          </p>
        </div>
        <ul className="rounded-md border p-3 font-mono text-sm space-y-1" data-testid="list-mfa-recovery-codes">
          {recoveryCodes.map((rc) => (
            <li key={rc}>{rc}</li>
          ))}
        </ul>
        <CopyButton value={recoveryCodes.join("\n")} label="Copy codes" testId="button-copy-recovery-codes" />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            data-testid="checkbox-recovery-acknowledged"
          />
          <span>I have saved these recovery codes.</span>
        </label>
        <Button
          type="button"
          className="w-full"
          disabled={!acknowledged || completing}
          onClick={async () => {
            if (completing) return;
            setCompleting(true);
            await onComplete();
          }}
          data-testid="button-mfa-enrol-finish"
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleConfirm} className="space-y-4" data-testid="form-partner-mfa-enrol">
      <div className="space-y-1">
        <h2 className="font-semibold">Set up two-factor sign in</h2>
        <p className="text-sm text-muted-foreground">
          Scan this with an authenticator app (such as Google Authenticator, 1Password or Authy), then enter the 6-digit
          code it shows.
        </p>
      </div>

      {otpauthUri && <OtpauthQr uri={otpauthUri} />}

      <div className="space-y-2">
        <span className="text-sm font-medium">Can't scan? Enter this setup key by hand:</span>
        <p className="break-all rounded-md border p-2 font-mono text-xs" data-testid="text-mfa-secret">
          {secret}
        </p>
        <CopyButton value={secret} label="Copy setup key" testId="button-copy-mfa-secret" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="partner-mfa-enrol-code">6-digit code</Label>
        <Input
          id="partner-mfa-enrol-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, "").slice(0, 12))}
          data-testid="input-mfa-enrol-code"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="text-mfa-enrol-error">
          {error}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={submitting || restarting || cancelling}
        data-testid="button-mfa-enrol-confirm"
      >
        {submitting ? "Confirming…" : "Confirm and finish"}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={submitting || restarting || cancelling}
        onClick={() => void handleRestart()}
        data-testid="button-mfa-enrol-restart"
      >
        {restarting ? "Restarting…" : "Restart setup"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        disabled={submitting || restarting || cancelling}
        onClick={() => void handleCancel()}
        data-testid="button-mfa-enrol-sign-out"
      >
        {cancelling ? "Signing out…" : "Cancel and sign out"}
      </Button>
      <button
        type="button"
        className="text-sm text-muted-foreground underline w-full text-center"
        onClick={onUseExistingAuthenticator}
        data-testid="button-mfa-enrol-cancel"
      >
        I already have an authenticator app
      </button>
    </form>
  );
}
