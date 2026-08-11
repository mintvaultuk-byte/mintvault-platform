/**
 * Public Partner Network — rollout gate and readiness.
 *
 * Three separate hostile-review findings meet in this file, and they are separate on purpose:
 *
 *   H14  THE KILL SWITCH. Deploying the code must not launch the Shop Finder. The public network
 *        is a NEW consumer-facing surface with a real reputational blast radius (it publishes shop
 *        names, addresses and quality ratings), and until now the only thing standing between
 *        "merged" and "live to the internet" was `registerPartnerNetworkPublicRoutes(app)` running
 *        unconditionally at boot. Turning it off again meant a redeploy.
 *
 *   H12  READINESS. `partnerPublicDbConfigured()` existed and had ZERO callers, so a missing
 *        PARTNER_PUBLIC_DATABASE_URL, a missing reader role or a missing GRANT would first be
 *        discovered by an anonymous visitor getting a 503.
 *
 *   H13  MEMBERSHIP. Migration 0061 creates `partner_public_reader` as a NOLOGIN GROUP role, per
 *        the house convention (0008:17-18) that a real login role is granted membership OUT OF
 *        BAND by infrastructure and never created by a migration. Nothing anywhere recorded that
 *        this step exists, so the estate could be fully migrated and still unable to serve.
 *
 * ── WHY ONE PROBE SETTLES H12 AND H13 TOGETHER ──────────────────────────────────────────────
 * `partnerPublicQuery` opens a transaction, issues `SET LOCAL ROLE partner_public_reader`, and
 * reads `current_user` back before running anything. So a SINGLE successful query through it
 * proves, in one round trip and with no separate catalogue interrogation:
 *
 *   * PARTNER_PUBLIC_DATABASE_URL is set and reachable          (else PartnerPublicDbUnavailable)
 *   * the `partner_public_reader` role EXISTS                   (else 22023 / 42704 on SET ROLE)
 *   * the login role IS A MEMBER of it                          (else 42501 on SET ROLE)  ← H13
 *   * the assertion passes, so the identity really did drop     (else our own fail-closed throw)
 *
 * Interrogating pg_roles/pg_auth_members instead would test our BELIEF about privilege rather than
 * the privilege itself, and would need catalogue grants the reader deliberately does not have.
 * Doing the thing is a better proof than asking whether the thing would work.
 *
 * The projection probes that follow then prove the migration estate is actually present, because
 * a reader with perfect membership and no views is just as unable to serve.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { partnerPublicQuery, partnerPublicDbConfigured, PartnerPublicDbUnavailable } from "./db";
import { resolveGlobalFlag } from "./flags";

/**
 * The rollout gate. DEFAULT OFF — `resolveGlobalFlag` fails closed on an absent row, so the
 * network is invisible until a Super Admin deliberately inserts an enabled global flag.
 *
 * Deliberately NOT added to PARTNER_FLAGS in ./flags. That array is the PARTNER PORTAL's flag set,
 * every member of which is resolved per-tenant inside a tenant transaction; this one is global-only
 * and gates an ANONYMOUS surface with no tenant to resolve against. Sharing the array would invite
 * a future tenant-scoped resolution of a flag that has no tenant, which resolves to "off" for
 * everyone and looks like the kill switch firing.
 */
export const PARTNER_PUBLIC_NETWORK_FLAG = "partner_public_network_enabled";

/**
 * How long a TRUE flag read is reused.
 *
 * The portal gate in mount.ts reads its flags uncached on every request, and says so — it is
 * behind authentication, so the request rate is bounded by the number of partner staff. This
 * surface is anonymous and crawlable, and the flag lives on `partner_feature_flags`, which only
 * the RUNTIME pool can read. An uncached read would put one partner_runtime query in front of
 * every anonymous request — reintroducing, on a different pool, exactly the "public traffic
 * consumes shared capacity" defect that 0061 and the slab-image re-platforming exist to remove.
 *
 * Five seconds is the trade: a Super Admin disabling the network sees it take effect within five
 * seconds and with no redeploy, which is what "kill switch" has to mean, while a crawler costs at
 * most one flag read per five seconds per machine.
 *
 * ONLY A TRUE RESULT IS CACHED. False is never cached, so re-enabling is instant, and — more
 * importantly — a FAILED read (which fails closed to false) can never be latched into a
 * self-sustaining outage. Same asymmetry as mount.ts's definer health cache, for the same reason.
 */
const FLAG_CACHE_MS = Number(process.env.PARTNER_PUBLIC_NETWORK_FLAG_CACHE_MS ?? 5_000);
let flagEnabledUntil = 0;

export async function partnerPublicNetworkEnabled(): Promise<boolean> {
  if (Date.now() < flagEnabledUntil) return true;
  const enabled = await resolveGlobalFlag(PARTNER_PUBLIC_NETWORK_FLAG);
  if (enabled) flagEnabledUntil = Date.now() + FLAG_CACHE_MS;
  return enabled;
}

/** Test-only: drop the cached TRUE so a suite can flip the flag and observe it immediately. */
export function __resetPartnerPublicNetworkFlagCache(): void {
  flagEnabledUntil = 0;
}

/**
 * Express gate for every anonymous Partner Network route.
 *
 * OFF RESPONDS 404, NOT 503, and the difference is deliberate. 503 means "this exists and is
 * temporarily broken" — it advertises an unlaunched surface to anyone probing, and it invites
 * retries and CDN caching behaviour we do not want during a staged rollout. 404 is what a visitor
 * would get for any URL that is not a thing yet, which is exactly the truth while the flag is off.
 *
 * It is also the SAME response the profile route already returns for a paused, suspended or absent
 * shop, so flipping the flag cannot be distinguished from a shop simply not being listed — the
 * disclosure argument that route already makes applies here unchanged.
 */
export function partnerPublicNetworkGate(): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (await partnerPublicNetworkEnabled()) return next();
    } catch {
      // resolveGlobalFlag already fails closed internally; this is belt and braces so a throw from
      // anywhere in the gate can never fall through to `next()`.
    }
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Shop not found." } });
  };
}

// =================================================================================================
// READINESS
// =================================================================================================

/** Short, classified reasons. Never driver text, never a host, never a role name from an error. */
export type PublicReadinessCode =
  | "public_db_not_configured"
  | "public_db_unreachable"
  | "public_reader_role_unavailable"
  | "public_projection_missing"
  | "public_db_check_failed";

export interface PublicNetworkReadiness {
  /** True only when an anonymous request would actually be servable right now. */
  ready: boolean;
  /** Is the dedicated public URL even set? Distinguishes "not provisioned" from "provisioned and broken". */
  configured: boolean;
  /** Is the rollout flag on? Reported alongside readiness because they fail for different reasons. */
  featureEnabled: boolean;
  code: PublicReadinessCode | null;
  /** Which of the required relations the reader could actually SELECT from. */
  projectionsReachable: string[];
  checkedAt: string;
}

/**
 * The relations an anonymous request needs, and which migration owns each.
 *
 * All three are checked even though a given request only touches one, because a partial estate is
 * the failure this exists to catch: 0061 applied without 0064 gives a working Shop Finder whose
 * every card image 503s, which is worse than a surface that is honestly not ready.
 */
const REQUIRED_PROJECTIONS = [
  "partner_public_shop_projection", // 0061 — finder + profile
  "partner_public_card_projection", // 0061 — recent cards on a profile
  "public_slab_image_projection", // 0064 — the anonymous slab-image proxy
] as const;

let cachedReady: PublicNetworkReadiness | null = null;
let cachedReadyUntil = 0;
const READINESS_CACHE_MS = Number(process.env.PARTNER_PUBLIC_READINESS_CACHE_MS ?? 30_000);

/**
 * Probe the public path end to end, as the public path.
 *
 * ONLY A READY RESULT IS CACHED, and only briefly. An unready result is re-probed every time, so
 * granting the missing membership or applying the missing migration takes effect without a restart
 * — which matters because the most likely time this returns false is during the rollout itself,
 * with an operator watching and fixing.
 *
 * NEVER THROWS. Readiness is a diagnostic; a readiness probe that can take down the caller is a
 * worse liability than the thing it reports on.
 */
export async function checkPartnerPublicNetworkReadiness(
  opts: { force?: boolean } = {},
): Promise<PublicNetworkReadiness> {
  if (!opts.force && cachedReady && Date.now() < cachedReadyUntil) return cachedReady;

  const checkedAt = new Date().toISOString();
  let featureEnabled = false;
  try {
    featureEnabled = await partnerPublicNetworkEnabled();
  } catch {
    featureEnabled = false;
  }

  if (!partnerPublicDbConfigured()) {
    // NOT an error state on its own: an estate that has not yet provisioned the public network is
    // simply not ready for it, and MintVault's own surfaces are unaffected.
    return {
      ready: false,
      configured: false,
      featureEnabled,
      code: "public_db_not_configured",
      projectionsReachable: [],
      checkedAt,
    };
  }

  const reachable: string[] = [];
  for (const relation of REQUIRED_PROJECTIONS) {
    try {
      // LIMIT 0 — this proves the relation exists AND that the reader may SELECT from it, while
      // reading no rows and doing no work. `SELECT 1 FROM x LIMIT 0` still plans and still
      // permission-checks, which is the whole of what is being asserted.
      //
      // The relation name is a compile-time constant from REQUIRED_PROJECTIONS, never user input.
      await partnerPublicQuery(`SELECT 1 FROM ${relation} LIMIT 0`);
      reachable.push(relation);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Our own fail-closed assertion, or SET ROLE being refused. Both mean the SAME operational
      // thing — the login role is not usable as partner_public_reader — and it is the single most
      // likely rollout failure, because it is the one step no migration can perform (H13).
      if (err instanceof PartnerPublicDbUnavailable || e?.code === "42501" || e?.code === "42704" || e?.code === "22023") {
        return {
          ready: false,
          configured: true,
          featureEnabled,
          code: err instanceof PartnerPublicDbUnavailable && !process.env.PARTNER_PUBLIC_DATABASE_URL
            ? "public_db_not_configured"
            : "public_reader_role_unavailable",
          projectionsReachable: reachable,
          checkedAt,
        };
      }
      // 42P01 undefined_table, 42703 undefined_column — the migration estate is behind the code.
      if (e?.code === "42P01" || e?.code === "42703") {
        return {
          ready: false,
          configured: true,
          featureEnabled,
          code: "public_projection_missing",
          projectionsReachable: reachable,
          checkedAt,
        };
      }
      console.error("[partner-public-readiness] probe failed:", relation, e?.code, e?.message);
      return {
        ready: false,
        configured: true,
        featureEnabled,
        code: e?.code?.startsWith("08") ? "public_db_unreachable" : "public_db_check_failed",
        projectionsReachable: reachable,
        checkedAt,
      };
    }
  }

  const result: PublicNetworkReadiness = {
    ready: true,
    configured: true,
    featureEnabled,
    code: null,
    projectionsReachable: reachable,
    checkedAt,
  };
  cachedReady = result;
  cachedReadyUntil = Date.now() + READINESS_CACHE_MS;
  return result;
}

/** Test-only: drop the cached READY verdict. */
export function __resetPartnerPublicReadinessCache(): void {
  cachedReady = null;
  cachedReadyUntil = 0;
}

/**
 * Startup report. Called once from server/index.ts, AFTER migrations and pools are up.
 *
 * ── WHY THIS DOES NOT FAIL THE PROCESS, AND WHY THAT IS THE RIGHT CHOICE ────────────────────
 * The brief asks for the smallest operationally safe model. Two options were available:
 *
 *   (a) hard readiness failure — the machine reports unhealthy and Fly refuses the release;
 *   (b) the public network stays disabled while core MintVault stays healthy.
 *
 * (b) is chosen, and the deciding fact is what else lives in this process. `certificates`,
 * `/api/cert/:id`, Stripe webhooks, the admin panel and label generation all run here. Under (a),
 * a missing GRANT on an unlaunched consumer feature would take payment processing and certificate
 * verification offline. That is a strictly worse outage than the one being prevented, and it would
 * be caused by the safety mechanism rather than by the defect.
 *
 * (b) is only safe because the two gates below are independent and BOTH fail closed on their own:
 *   * the flag defaults OFF, so an unready estate is not serving the network anyway;
 *   * `partnerPublicQuery` refuses to run on a privileged connection, so an unready estate CANNOT
 *     silently serve anonymous traffic from the owner pool — the failure is a 503, never a leak.
 *
 * So the residual risk of (b) is "the network is down and we find out from this log line or the
 * readiness endpoint", not "the network is up and unsafe". The loud startup warning is what makes
 * that discoverable at deploy time rather than at first customer request, which was the whole of
 * H12.
 */
export async function reportPartnerPublicNetworkReadiness(): Promise<PublicNetworkReadiness> {
  const r = await checkPartnerPublicNetworkReadiness({ force: true });
  if (r.ready) {
    console.log(
      `[partner-public-network] READY (reader verified, ${r.projectionsReachable.length}/${REQUIRED_PROJECTIONS.length} projections) — feature flag ${r.featureEnabled ? "ON" : "OFF"}`,
    );
    return r;
  }
  // Deliberately loud, and deliberately actionable. An operator reading this at 2am should not have
  // to find a runbook to know what to do next.
  const remedy: Record<PublicReadinessCode, string> = {
    public_db_not_configured:
      "set PARTNER_PUBLIC_DATABASE_URL to a login role that is a member of partner_public_reader",
    public_reader_role_unavailable:
      "GRANT partner_public_reader TO <the login role in PARTNER_PUBLIC_DATABASE_URL>; migration 0061 creates the NOLOGIN group role but cannot grant membership",
    public_projection_missing:
      "apply migrations 0061 and 0064 — the code is ahead of the database",
    public_db_unreachable: "the public database endpoint is not reachable from this machine",
    public_db_check_failed: "see the preceding [partner-public-readiness] log line",
  };
  console.warn(
    `[partner-public-network] NOT READY (${r.code}) — the public Shop Finder cannot serve. ` +
      `Core MintVault is UNAFFECTED and continues normally. Remedy: ${remedy[r.code ?? "public_db_check_failed"]}`,
  );
  if (r.featureEnabled) {
    // The one genuinely alarming combination: someone turned the network ON against an estate that
    // cannot serve it. Visitors are getting 503s right now.
    console.error(
      "[partner-public-network] ⚠️ the rollout flag is ON but the estate is NOT READY — anonymous visitors are receiving 503. Turn the flag off or fix the remedy above.",
    );
  }
  return r;
}
