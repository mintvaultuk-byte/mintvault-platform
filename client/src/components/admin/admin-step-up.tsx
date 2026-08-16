/**
 * SUPER ADMIN STEP-UP — the client half.
 *
 * WHY THIS EXISTS. `requireAdminStepUp()` (server/lib/admin-step-up.ts) gates every high-risk Super
 * Admin action: approving/suspending/revoking a station, adjusting a partner's credits, changing a
 * partner's status, and every partner-user action (role, status, password reset, MFA reset, session
 * revocation). The server half shipped complete — the guard answers
 * `403 { code: "admin_step_up_required" }` and `POST /api/admin/step-up { password, pin }` exists to
 * satisfy it.
 *
 * The CLIENT half did not exist. Clicking Approve on a PENDING station fired the request, the server
 * correctly refused it, and the page showed a banner reading "Confirm your admin password and PIN to
 * continue." — with nowhere in the product to do that. The station could not be approved through the
 * website at all, which is the production onboarding path for every new shop.
 *
 * This is the same defect class as RC-F9 on the Partner side, and it is fixed the same way: build the
 * missing half. `requireAdminStepUp` is NOT relaxed, no route is ungated, the mandatory reason is
 * unchanged, and the audit trail is untouched.
 *
 * IMPERATIVE, NOT A CONTEXT PROVIDER, on purpose. The admin mutations are declared inside the page
 * components themselves, so a context provider would have to sit above each page and force those
 * pages to be restructured. A single `<AdminStepUpHost />` mounted once in App.tsx plus a
 * `runAdminProtected(...)` wrapper keeps the change at the call sites to one line each and gives
 * exactly one place where the dialog can live.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";

/** The server's distinct, actionable code (ADMIN_STEP_UP_REQUIRED_CODE). */
export const ADMIN_STEP_UP_REQUIRED_CODE = "admin_step_up_required";

/** Raised when the operator dismisses the prompt. The protected action has NOT been performed. */
export class AdminStepUpCancelled extends Error {
  constructor() {
    super("Confirmation cancelled.");
    this.name = "AdminStepUpCancelled";
  }
}

export function isAdminStepUpCancelled(err: unknown): boolean {
  return err instanceof AdminStepUpCancelled;
}

/**
 * Is this rejection the server asking for a fresh proof?
 *
 * The admin guard puts `code` at the TOP LEVEL of the body (`{ error: "...", code, windowMinutes }`),
 * unlike the partner surface which nests it under `error`. Both shapes are accepted so a future
 * alignment of the two does not silently stop the prompt from appearing.
 */
export function isAdminStepUpRequired(err: unknown): boolean {
  const e = err as { status?: number; body?: { code?: unknown; error?: { code?: unknown } } } | null | undefined;
  if (!e || e.status !== 403) return false;
  return e.body?.code === ADMIN_STEP_UP_REQUIRED_CODE || e.body?.error?.code === ADMIN_STEP_UP_REQUIRED_CODE;
}

/** Set by the mounted host. Null when no host is mounted. */
let openChallenge: (() => Promise<void>) | null = null;

/**
 * Run a high-risk Super Admin action, satisfying a step-up challenge if the server issues one.
 *
 * Resolves with the action's value. Rejects with `AdminStepUpCancelled` if the operator dismisses
 * the prompt — in which case NOTHING was performed — or with the action's own error.
 *
 * The retry is EXACTLY ONCE. A second challenge is surfaced rather than re-prompted: looping a
 * password box is how an operator is trained to type an admin password into anything that asks.
 */
export async function runAdminProtected<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!isAdminStepUpRequired(err) || !openChallenge) throw err;
    await openChallenge();
    return await action();
  }
}

export function AdminStepUpHost() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const wipe = useCallback(() => {
    setPassword("");
    setPin("");
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setBusy(false);
    setError(null);
    wipe();
  }, [wipe]);

  useEffect(() => {
    openChallenge = () =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setError(null);
        wipe();
        setOpen(true);
      });
    return () => {
      openChallenge = null;
    };
  }, [wipe]);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/admin/step-up", { password, pin });
      const p = pending.current;
      pending.current = null;
      close();
      p?.resolve();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // Each status is a different instruction to the operator, so they are told apart rather than
      // collapsed into one message they cannot act on.
      if (status === 423) setError("Account locked after too many attempts. Try again later.");
      else if (status === 429) setError("Too many attempts. Wait a moment before trying again.");
      else if (status === 400) setError("Both your admin password and PIN are required.");
      else if (status === 401) setError("That password or PIN was not correct.");
      else setError("Could not confirm your identity. Please try again.");
      wipe();
    } finally {
      setBusy(false);
    }
  }, [busy, password, pin, close, wipe]);

  const cancel = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    close();
    p?.reject(new AdminStepUpCancelled());
  }, [close]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent data-testid="dialog-admin-step-up">
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
            This is a high-risk Super Admin action, so we ask you to re-confirm it is really you.
          </p>
          <div className="space-y-2">
            <Label htmlFor="admin-step-up-password">Admin password</Label>
            <Input
              id="admin-step-up-password"
              data-testid="input-admin-step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-step-up-pin">Admin PIN</Label>
            <Input
              id="admin-step-up-pin"
              data-testid="input-admin-step-up-pin"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          {error && (
            <p className="text-sm text-rose-500" role="alert" data-testid="text-admin-step-up-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancel} data-testid="button-admin-step-up-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password || !pin} data-testid="button-admin-step-up-confirm">
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
