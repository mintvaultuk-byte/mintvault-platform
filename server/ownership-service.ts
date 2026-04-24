/**
 * MintVault Ownership Chain service.
 * Derives numbered owner chain from ownership_history event log.
 */
import { storage } from "./storage";

const OWNER_EVENTS = ["initial_claim", "auto_submission", "transfer_completed", "admin_assign"];

export interface OwnerEntry {
  ownerNumber: number;
  displayName: string | null;
  email: string | null;
  claimedAt: string;
  releasedAt: string | null;
  durationDays: number | null;
  isCurrent: boolean;
  claimMethod: string;
}

export async function getOwnerChain(certId: string): Promise<OwnerEntry[]> {
  try {
    const history = await storage.getOwnershipHistory(certId);
    if (!history || history.length === 0) return [];

    const ownerEvents = history
      .filter(h => OWNER_EVENTS.includes(h.eventType))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return ownerEvents.map((event, idx) => {
      const nextEvent = ownerEvents[idx + 1];
      const claimedAt = event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString();
      const releasedAt = nextEvent?.createdAt ? new Date(nextEvent.createdAt).toISOString() : null;
      const durationDays = releasedAt
        ? Math.floor((new Date(releasedAt).getTime() - new Date(claimedAt).getTime()) / 86400000)
        : null;

      return {
        ownerNumber: idx + 1,
        displayName: event.publicName ? (event.notes?.replace("Original submitter: ", "") || null) : null,
        email: null, // never expose email publicly
        claimedAt,
        releasedAt,
        durationDays,
        isCurrent: !nextEvent,
        claimMethod: event.eventType,
      };
    });
  } catch {
    return [];
  }
}
