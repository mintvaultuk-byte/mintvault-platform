/**
 * Partner Portal — AG-3 STEP-UP, the client half.
 *
 * WHY THIS EXISTS. `requireRecentAuth()` (server/partner/step-up.ts) gates the rare, expensive and
 * hard-to-undo partner actions — buying Grading Credits, inviting staff, changing a role, suspending
 * a user, revoking sessions — on a proof recorded within the last 15 minutes. The server half shipped
 * complete and correct. The client half did not, so a partner met "Confirm your password to continue."
 * with nowhere to confirm it, and a shop could be blocked from buying credits: the revenue path.
 *
 * ONE MECHANISM, NOT FIVE DIALOGS. Every protected call goes through `runProtected`, which owns the
 * whole sequence: run the action, and only if the server answers 403 `step_up_required`, prompt,
 * prove, and retry the ORIGINAL action exactly once. Call sites do not test for the code, do not
 * know the dialog exists, and cannot each drift into their own subtly different prompt.
 *
 * STEP-UP IS NOT PERMISSION ESCALATION. Nothing here grants anything. The retry re-issues the same
 * request to the same endpoint, where the same capability guards run again in the same order —
 * `requireRecentAuth()` is deliberately placed AFTER them, so a user who may never perform the action
 * is told that plainly and is never asked for a password that would not have helped. A GRADER who
 * steps up is still a GRADER; a suspended user's session cannot step up at all, because the proof is
 * written to a row filtered on `revoked_at IS NULL`.
 *
 * SECRET HANDLING. The password and second factor live in React state for exactly as long as the
 * request that carries them, and are wiped in a `finally`. They are never written to localStorage,
 * sessionStorage, a cookie, the URL, a log line or analytics. The server returns no token to store —
 * the proof is a timestamp on the session row, which is also why it works across both production
 * Machines without any client-side or process-local state.
 *
 * RETRY IS EXACTLY ONCE. If the retried action answers `step_up_required` a second time, that is a
 * real failure (a clock problem, a revoked session, a race with expiry) and it is surfaced, not
 * re-prompted. Looping a password prompt is how a confused user is trained to type a password into
 * anything that asks.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { partnerAuth, PartnerApiError, isStepUpRequired } from "@/lib/partner-api";

/** Raised when the user dismisses the prompt. Callers treat it as "nothing happened". */
export class PartnerStepUpCancelled extends Error {
  constructor() {
    super("Confirmation cancelled.");
    this.name = "PartnerStepUpCancelled";
  }
}

/** True when a rejection is the user closing the prompt rather than the action failing. */
export function isStepUpCancelled(err: unknown): boolean {
  return err instanceof PartnerStepUpCancelled;
}

interface StepUpContextValue {
  /**
   * Run a protected partner action, satisfying a step-up challenge if the server issues one.
   *
   * Resolves with the action's value. Rejects with `PartnerStepUpCancelled` if the user dismisses
   * the prompt — in which case the action has NOT been performed — or with the action's own error.
   */
  runProtected: <T>(action: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

/**
 * Access the canonical step-up runner.
 *
 * Outside the provider this returns a pass-through rather than throwing: a protected call made from
 * an unwrapped tree must still reach the server and be refused there. Failing open on the PROMPT is
 * safe; the authority is server-side and unaffected.
 */
export function usePartnerStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  return ctx ?? { runProtected: (action) => action() };
}

type Pending = {
  resolve: (proof: { password: string; code?: string; recoveryCode?: string }) => void;
  reject: (err: unknown) => void;
};

export function PartnerStepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<Pending | null>(null);

  /** Clear every secret held in state. Called on close and after each submit attempt. */
  const wipeSecrets = useCallback(() => {
    setPassword("");
    setCode("");
    setRecoveryCode("");
  }, []);

  const closeAndReset = useCallback(() => {
    setOpen(false);
    setBusy(false);
    setError(null);
    setNeedsSecondFactor(false);
    setUseRecovery(false);
    wipeSecrets();
  }, [wipeSecrets]);

  /** Open the prompt and resolve once the server has ACCEPTED a proof. */
  const challenge = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      pending.current = {
        resolve: () => resolve(),
        reject,
      };
      setError(null);
      setNeedsSecondFactor(false);
      setUseRecovery(false);
      wipeSecrets();
      setOpen(true);
    });
  }, [wipeSecrets]);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await partnerAuth.stepUp(
        password,
        useRecovery ? { recoveryCode: recoveryCode.trim() } : code.trim() ? { code: code.trim() } : undefined
      );
      const p = pending.current;
      pending.current = null;
      closeAndReset();
      p?.resolve({ password: "" });
    } catch (err) {
      // The server tells a missing second factor apart from a wrong password, because the user can
      // act on the difference. Neither answer reveals whether the account exists — the session
      // already proves that.
      const code_ = err instanceof PartnerApiError ? err.code : "";
      if (code_ === "second_factor_required") {
        setNeedsSecondFactor(true);
        setError("Enter the code from your authenticator app.");
      } else if (code_ === "unauthorised") {
        setError("That password was not correct.");
      } else if (err instanceof PartnerApiError && err.status === 429) {
        // Preserve the lockout signal rather than inviting another attempt.
        setError("Too many attempts. Please wait a moment before trying again.");
      } else {
        setError("We could not confirm your password. Please try again.");
      }
      // Never retain a rejected secret.
      setPassword("");
      setCode("");
      setRecoveryCode("");
    } finally {
      setBusy(false);
    }
  }, [busy, password, code, recoveryCode, useRecovery, closeAndReset]);

  /** Dismissal performs nothing. The protected action must remain unexecuted. */
  const cancel = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    closeAndReset();
    p?.reject(new PartnerStepUpCancelled());
  }, [closeAndReset]);

  const runProtected = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isStepUpRequired(err)) throw err;
        // Only now is a password worth asking for: the server has said this session is otherwise
        // entitled and merely needs to prove freshness.
        await challenge();
        // Exactly once. A second challenge is a real failure, not another prompt.
        return await action();
      }
    },
    [challenge]
  );

  const value = useMemo<StepUpContextValue>(() => ({ runProtected }), [runProtected]);

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
        <DialogContent data-testid="dialog-partner-step-up">
          <DialogHeader>
            <DialogTitle>Confirm your identity to continue</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            <p className="text-sm text-muted-foreground">
              This action affects your shop&rsquo;s money or your team, so we ask you to confirm it is really you.
            </p>
            <div className="space-y-2">
              <Label htmlFor="partner-step-up-password">Password</Label>
              <Input
                id="partner-step-up-password"
                data-testid="input-step-up-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {needsSecondFactor &&
              (useRecovery ? (
                <div className="space-y-2">
                  <Label htmlFor="partner-step-up-recovery">Recovery code</Label>
                  <Input
                    id="partner-step-up-recovery"
                    data-testid="input-step-up-recovery"
                    autoComplete="one-time-code"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="partner-step-up-code">Authenticator code</Label>
                  <Input
                    id="partner-step-up-code"
                    data-testid="input-step-up-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
              ))}
            {needsSecondFactor && (
              <button
                type="button"
                className="text-xs underline text-muted-foreground"
                data-testid="button-step-up-toggle-recovery"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode("");
                  setRecoveryCode("");
                }}
              >
                {useRecovery ? "Use an authenticator code instead" : "Use a recovery code instead"}
              </button>
            )}
            {error && (
              <p className="text-sm text-rose-300" role="alert" data-testid="text-step-up-error">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancel} data-testid="button-step-up-cancel">
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !password} data-testid="button-step-up-confirm">
                {busy ? "Confirming…" : "Confirm"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StepUpContext.Provider>
  );
}
