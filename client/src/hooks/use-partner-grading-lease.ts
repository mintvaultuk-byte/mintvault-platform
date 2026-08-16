/**
 * P9 — THE GRADING EDIT LEASE, on the client.
 *
 * WHY THIS COULD NOT BE WIRED BEFORE. The lease was a proven server mechanism that nothing consulted:
 * a Scanner Card Job could not be opened for grading at all, so there was no honest moment at which a
 * browser could acquire one. The Card Job → grading bridge created that moment; this is the other
 * half.
 *
 * WHAT IT DOES NOT DO. It holds NO grading authority. Every answer here — do you hold this card, at
 * which revision, may you take it from somebody — comes from the server on every call, and the server
 * re-checks all of it on every write regardless of what this believes. The state below drives what
 * the operator SEES; it never decides what may be written. A browser that lied about holding the
 * lease would be refused by `assertMayWriteCertificate` exactly as an honest one that lost it.
 *
 * THE HEARTBEAT. Every 30 seconds against a 120-second TTL — four missed beats before a card frees
 * up. It stops on unmount, on navigation and when the lease is no longer held, because a heartbeat
 * that outlives the workstation would hold a colleague's card open from a closed tab.
 *
 * THE REVISION is the editing-SESSION generation, not a per-write counter (see the note in
 * grading-lease-service.ts). It is therefore stable for as long as this component holds the card,
 * which is what makes autosave possible: the same value is presented on every write and only a
 * takeover or an expiry moves it on.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Matches LEASE_TTL_SECONDS (120s) on the server: four missed beats before a card frees up. */
const HEARTBEAT_MS = 30_000;

export type PartnerLeaseState =
  | "idle"
  | "acquiring"
  /** You hold it. The workstation is editable. */
  | "held"
  /** Somebody else holds it. Read-only, with an honest banner. */
  | "occupied"
  /** Your editing session ended (expiry, or an authorised takeover). Reacquire to continue. */
  | "lost"
  /** The card is not in a state that can be opened for grading, or is not yours to open. */
  | "unavailable"
  | "error";

export interface PartnerLeaseView {
  cardJobId: string;
  holderUserId: string;
  holderDisplay: string | null;
  acquiredAt: string;
  expiresAt: string;
  revision: number;
  heldByYou: boolean;
}

export interface PartnerGradingLease {
  state: PartnerLeaseState;
  /** The generation every write must present. Null unless the lease is held. */
  revision: number | null;
  /** A display name the shop already shows its own staff — never an email or a user id. */
  holderDisplay: string | null;
  expiresAt: string | null;
  message: string | null;
  /** True when the card is editable RIGHT NOW. The server still re-checks every write. */
  editable: boolean;
  /** Take (or retake) the card. Safe to call after an expiry. */
  acquire: () => Promise<void>;
  /** Take the card off another grader. Permission-checked and audited server-side. */
  takeover: (reason: string) => Promise<void>;
  /**
   * Report a rejected write so the UI can move to the truthful state rather than showing a generic
   * toast. 409 STALE_REVISION means reload; 410 means the editing session is gone.
   */
  noteWriteRejection: (status: number, code?: string) => void;
}

interface LeaseErrorBody {
  error?: { code?: string; message?: string; holderDisplay?: string | null; expiresAt?: string };
}

export function usePartnerGradingLease(
  cardJobId: string | null,
  options: { displayName?: string | null; enabled?: boolean } = {}
): PartnerGradingLease {
  const { displayName = null, enabled = true } = options;
  const [state, setState] = useState<PartnerLeaseState>("idle");
  const [lease, setLease] = useState<PartnerLeaseView | null>(null);
  const [holderDisplay, setHolderDisplay] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Read by the unmount cleanup, which must release the CURRENT card without re-running the effect
  // (and therefore re-acquiring) every time the lease object changes.
  const heldRef = useRef(false);
  heldRef.current = state === "held";

  const applyFailure = useCallback(async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as LeaseErrorBody;
    const code = body.error?.code;
    setMessage(body.error?.message ?? "This card could not be opened for editing.");
    setHolderDisplay(body.error?.holderDisplay ?? null);
    if (code === "LEASE_HELD_BY_ANOTHER") setState("occupied");
    else if (code === "CARD_JOB_NOT_FOUND" || code === "NOT_GRADABLE" || code === "FORBIDDEN") setState("unavailable");
    else if (code === "LEASE_EXPIRED" || code === "NOT_LEASE_HOLDER") setState("lost");
    else setState("error");
    setLease(null);
  }, []);

  const acquire = useCallback(async () => {
    if (!cardJobId) return;
    setState("acquiring");
    setMessage(null);
    try {
      const response = await fetch(`/api/partner/grading/card-jobs/${cardJobId}/lease`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) return applyFailure(response);
      const data = (await response.json()) as { lease: PartnerLeaseView };
      setLease(data.lease);
      setHolderDisplay(data.lease.holderDisplay);
      setState("held");
      setMessage(null);
    } catch {
      setState("error");
      setMessage("The grading service is unreachable. Your changes are not being saved.");
    }
  }, [cardJobId, displayName, applyFailure]);

  const takeover = useCallback(
    async (reason: string) => {
      if (!cardJobId) return;
      try {
        const response = await fetch(`/api/partner/grading/card-jobs/${cardJobId}/lease/takeover`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason, displayName }),
        });
        if (!response.ok) return applyFailure(response);
        const data = (await response.json()) as { lease: PartnerLeaseView };
        setLease(data.lease);
        setHolderDisplay(data.lease.holderDisplay);
        setState("held");
        setMessage(null);
      } catch {
        setState("error");
        setMessage("The grading service is unreachable.");
      }
    },
    [cardJobId, displayName, applyFailure]
  );

  /* ACQUIRE ON OPEN, RELEASE ON CLOSE. */
  useEffect(() => {
    if (!enabled || !cardJobId) {
      setState("idle");
      setLease(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!cancelled) await acquire();
    })();
    return () => {
      cancelled = true;
      /*
       * Hand the card back when the grader closes it, so a colleague does not have to wait out the
       * full TTL for a card nobody is looking at any more. `keepalive` because this commonly fires
       * during a navigation or a tab close, when an ordinary fetch would be cancelled in flight.
       *
       * Best-effort by design: if it never lands, the lease simply expires on its own. Correctness
       * has never depended on a release arriving — that is the whole point of the TTL.
       */
      if (heldRef.current) {
        void fetch(`/api/partner/grading/card-jobs/${cardJobId}/lease/release`, {
          method: "POST",
          credentials: "include",
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [cardJobId, enabled, acquire]);

  /* HEARTBEAT while held, and only while held. */
  useEffect(() => {
    if (state !== "held" || !cardJobId) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/partner/grading/card-jobs/${cardJobId}/lease/heartbeat`, {
            method: "POST",
            credentials: "include",
          });
          if (!response.ok) {
            // An expired or seized lease must stop the workstation NOW, not at the next save. The
            // grader finds out while they can still copy their notes, rather than after typing into
            // a card that is no longer theirs.
            await applyFailure(response);
            return;
          }
          const data = (await response.json()) as { lease: PartnerLeaseView };
          setLease(data.lease);
        } catch {
          // A single dropped beat is not proof of anything — three more will fire before the TTL.
        }
      })();
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [state, cardJobId, applyFailure]);

  const noteWriteRejection = useCallback((status: number, code?: string) => {
    if (status === 410 || code === "LEASE_EXPIRED" || code === "NOT_LEASE_HOLDER") {
      setState("lost");
      setMessage("Your editing session on this card has ended. Reopen it to continue.");
      setLease(null);
      return;
    }
    if (code === "STALE_REVISION") {
      setState("lost");
      setMessage("This card changed since you opened it. Reopen it so nothing is overwritten.");
      setLease(null);
    }
  }, []);

  return {
    state,
    revision: state === "held" ? (lease?.revision ?? null) : null,
    holderDisplay,
    expiresAt: lease?.expiresAt ?? null,
    message,
    editable: state === "held",
    acquire,
    takeover,
    noteWriteRejection,
  };
}
