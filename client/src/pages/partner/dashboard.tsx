import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  partnerCredits,
  partnerCustomers,
  partnerDashboard,
  partnerErrorMessage,
  partnerOperations,
  partnerSubmissions,
} from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { AlertTriangle, ArrowRight, PlusCircle, ScanLine, Wrench } from "lucide-react";

function metric(value: number | null | undefined, empty = "Not available") {
  return value == null ? empty : value.toLocaleString("en-GB");
}

function statusLabel(status: string) {
  return status === "healthy"
    ? "Ready"
    : status === "low"
      ? "Running low"
      : status === "empty"
        ? "No available credits"
        : status === "inactive"
          ? "Wallet inactive"
          : "Unknown";
}

export default function PartnerDashboardPage() {
  /**
   * Credit data is an INDEPENDENTLY permission-gated panel, not a page-level dependency.
   *
   * WHY (hostile review, 2026-08-03): this page previously merged both queries' errors into one
   * page-level error and gated ALL content on both succeeding. `partner.credits.view` is not held
   * by PARTNER_RECEPTION (the primary shop-floor persona), MVGS_ASSESSMENT_TECHNICIAN or
   * PARTNER_TRAINEE, so for those roles the whole dashboard collapsed to a single red box showing
   * the raw server string "forbidden" — and the submission counts they ARE entitled to see never
   * rendered. The shell already gates the Credits & Billing nav item on this same permission.
   *
   * The query is therefore not issued at all without the capability (no 403 is provoked, and no
   * wallet data can reach a client that may not see it), and any credit failure is contained to
   * the credit panel.
   */
  const { session, hasPermission } = usePartnerSession();
  const canViewCredits = hasPermission("partner.credits.view");
  const canAssessCards = hasPermission("partner.cards.assess");
  const canPurchaseCredits = hasPermission("partner.credits.purchase");

  const submissions = useQuery({
    queryKey: ["/api/partner/dashboard/submissions"],
    queryFn: () => partnerDashboard.summary(),
  });
  const credits = useQuery({
    queryKey: ["/api/partner/credits"],
    queryFn: () => partnerCredits.view(),
    enabled: canViewCredits,
  });
  const customers = useQuery({
    queryKey: ["/api/partner/customers", "dashboard"],
    queryFn: () => partnerCustomers.list(),
  });
  const recentSubmissions = useQuery({
    queryKey: ["/api/partner/submissions", "dashboard-recent"],
    queryFn: () => partnerSubmissions.list({ page: 1, pageSize: 5 }),
  });
  /**
   * P8 — the operational read.
   *
   * One call for the lifecycle counts, the station fleet and the shop floors, all scoped
   * SERVER-SIDE from the session. Nothing below filters by tenant or location in the browser:
   * a client-side filter is a display convention, not a boundary, and this console shows a
   * paying shop its own money and its own customers' cards.
   */
  const operations = useQuery({
    queryKey: ["/api/partner/dashboard/operations"],
    queryFn: () => partnerOperations.view(),
  });
  const fixQueue = useQuery({
    queryKey: ["/api/partner/fix-queue"],
    queryFn: () => partnerOperations.fixQueue(),
    enabled: hasPermission("partner.cards.view"),
  });
  const readiness = useQuery({
    queryKey: ["/api/partner/onboarding-readiness"],
    queryFn: () => partnerOperations.readiness(),
  });

  const gradingQueue = useQuery({
    queryKey: ["/api/partner/grading/queue", "partner-dashboard"],
    enabled: canAssessCards,
    retry: false,
    queryFn: async () => {
      const res = await fetch("/api/partner/grading/queue", { credentials: "include" });
      if (!res.ok) throw new Error("Grading workspace unavailable.");
      return (await res.json()) as { items: { cards: { gradingStatus: string }[] }[] };
    },
  });
  // Page-level state tracks ONLY the submission query. Credit state is handled inside its panel.
  const loading = submissions.isLoading;
  const error = submissions.error;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop operations</p>
          <h1 className="text-2xl font-semibold" data-testid="text-dashboard-title">
            Dashboard
          </h1>
        </div>
        <Link href="/partner/submissions/new">
          <Button data-testid="button-new-submission-dashboard">
            <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
            New Submission
          </Button>
        </Link>
      </div>

      {loading && <PartnerLoadingState label="Loading your dashboard…" />}
      {error && (
        <PartnerErrorState
          message={partnerErrorMessage(error)}
          onRetry={() => {
            void submissions.refetch();
            void credits.refetch();
          }}
        />
      )}

      {submissions.data && (
        <>
          <section aria-labelledby="credit-summary-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="credit-summary-title" className="text-base font-semibold">
                Credit summary
              </h2>
              {canViewCredits && (
                <Link href="/partner/billing" className="text-sm text-primary inline-flex items-center gap-1">
                  Credits & Billing <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              )}
            </div>
            {!canViewCredits && (
              <p className="text-sm text-muted-foreground" data-testid="text-credit-not-authorised">
                Not authorised — your role does not include access to credit information.
              </p>
            )}
            {canViewCredits && credits.isLoading && (
              <p className="text-sm text-muted-foreground" data-testid="text-credit-loading">
                Loading credit summary…
              </p>
            )}
            {canViewCredits && credits.error && (
              <p className="text-sm text-muted-foreground" role="alert" data-testid="text-credit-error">
                Credit information is unavailable right now.{" "}
                <button type="button" className="text-primary underline" onClick={() => void credits.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {canViewCredits && credits.data && (
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-testid="grid-credit-summary">
                {[
                  ["Available", credits.data.summary.availableCredits, "available"],
                  ["Reserved", credits.data.summary.reservedCredits, "reserved"],
                  ["Consumed this month", credits.data.summary.consumedThisMonth, "consumed-month"],
                  ["Lifetime consumed", credits.data.summary.consumedLifetime, "consumed-lifetime"],
                ].map(([label, value, id]) => (
                  <Card key={String(id)} className="rounded-md">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-semibold" data-testid={`text-credit-${id}`}>
                        {metric(value as number | null, credits.data.summary.configured ? "Unknown" : "Not available")}
                      </p>
                    </CardContent>
                  </Card>
                ))}
                <Card className="rounded-md border-primary/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Balance status</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm font-semibold text-primary" data-testid="text-credit-status">
                      {statusLabel(credits.data.summary.balanceStatus)}
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}
            {/*
              Zero- and low-credit states.

              `balanceStatus` is SERVER-DERIVED (portal-view-service computes empty at 0 and low
              below the threshold from partner_credit_availability). This panel re-reads that verdict;
              it never recomputes availability from the individual tiles, because a second formula in
              the browser would be a second balance authority — the exact thing the credit model
              forbids. Nothing here can add capacity: the only control is a link to the wallet page.
            */}
            {canViewCredits && credits.data && credits.data.summary.balanceStatus === "empty" && (
              <Card className="rounded-md border-rose-400/50" data-testid="card-credit-empty">
                <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-rose-300 mt-0.5" aria-hidden="true" />
                    <div>
                      <p className="font-medium" data-testid="text-credit-empty-title">
                        No Grading Credits left
                      </p>
                      <p className="text-sm text-muted-foreground">
                        New cards cannot be started until you add credits. Cards already authorised keep moving —
                        grading, fixing a missing image and printing all continue as normal.
                      </p>
                    </div>
                  </div>
                  {canPurchaseCredits && (
                    <Link href="/partner/billing">
                      <Button data-testid="button-buy-credits-empty">Buy more Grading Credits</Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            )}
            {canViewCredits && credits.data && credits.data.summary.balanceStatus === "low" && (
              <Card className="rounded-md border-amber-400/50" data-testid="card-credit-low">
                <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-300 mt-0.5" aria-hidden="true" />
                    <div>
                      <p className="font-medium" data-testid="text-credit-low-title">
                        Running low on Grading Credits
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Top up before your next batch so the Scanner does not stop mid-session.
                      </p>
                    </div>
                  </div>
                  {canPurchaseCredits && (
                    <Link href="/partner/billing">
                      <Button variant="outline" data-testid="button-buy-credits-low">
                        Buy more Grading Credits
                      </Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            )}
          </section>

          {/*
            P8 — OPERATIONAL SUMMARY.
            Every figure is server-derived from the Card Job lifecycle and scoped to this tenant
            (and to one shop floor for a location-scoped user). The browser adds no arithmetic.
          */}
          <section aria-labelledby="operations-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 id="operations-title" className="text-base font-semibold">
                Card work
              </h2>
              {operations.data?.locationScoped && (
                <span className="text-xs text-muted-foreground" data-testid="text-operations-location-scoped">
                  Showing your assigned location only
                </span>
              )}
            </div>
            {operations.isLoading && <p className="text-sm text-muted-foreground">Loading card work…</p>}
            {operations.error && (
              <p className="text-sm text-muted-foreground" role="alert" data-testid="text-operations-error">
                Card work is unavailable right now.{" "}
                <button type="button" className="text-primary underline" onClick={() => void operations.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {operations.data && (
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-3" data-testid="grid-operations">
                {[
                  ["Reserved / in progress", operations.data.counts.reservedInProgress, "reserved"],
                  ["Needs scan", operations.data.counts.needsScan, "needs-scan"],
                  ["FIX required", operations.data.counts.fixRequired, "fix-required"],
                  ["Ready to grade", operations.data.counts.readyToGrade, "ready-to-grade"],
                  ["In review", operations.data.counts.inReview, "in-review"],
                  ["Completed", operations.data.counts.completed, "completed"],
                ].map(([label, value, id]) => (
                  <Card key={String(id)} className="rounded-md">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xl font-semibold" data-testid={`text-ops-${id}`}>
                        {metric(value as number)}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/*
            P8 — PRIMARY ACTIONS. Deliberately four, and deliberately in this order: the two things
            an operator does all day, then the two things they do when something is wrong or running
            out. SCAN NEW CARD does not start a card here — the authority is the Scanner's, bound to
            an approved station — so this points at the station rather than pretending to be one.
          */}
          <section aria-labelledby="actions-title" className="space-y-3">
            <h2 id="actions-title" className="text-base font-semibold">
              What do you want to do?
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="grid-primary-actions">
              <Card className="rounded-md" data-testid="action-scan-new-card">
                <CardContent className="pt-6 space-y-2">
                  <p className="font-medium inline-flex items-center gap-2">
                    <ScanLine className="h-4 w-4" aria-hidden="true" /> Scan a new card
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Press NEW CARD on an approved Scanner station. One Grading Credit is reserved at that moment, by the
                    server.
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-md" data-testid="action-buy-credits">
                <CardContent className="pt-6 space-y-2">
                  <p className="font-medium">Buy more Grading Credits</p>
                  {canPurchaseCredits ? (
                    <Link href="/partner/billing" className="text-sm text-primary inline-flex items-center gap-1">
                      Go to Credits &amp; Billing <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <p className="text-xs text-muted-foreground">Ask an owner at your shop to buy credits.</p>
                  )}
                </CardContent>
              </Card>
              <Card className="rounded-md" data-testid="action-fix-queue">
                <CardContent className="pt-6 space-y-2">
                  <p className="font-medium inline-flex items-center gap-2">
                    <Wrench className="h-4 w-4" aria-hidden="true" /> FIX queue
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {operations.data
                      ? `${operations.data.counts.fixRequired} card(s) need a replacement image. Fixing costs no credits.`
                      : "Cards needing a replacement image. Fixing costs no credits."}
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-md" data-testid="action-ready-to-grade">
                <CardContent className="pt-6 space-y-2">
                  <p className="font-medium">Ready to grade</p>
                  {canAssessCards ? (
                    <Link href="/partner/grading" className="text-sm text-primary inline-flex items-center gap-1">
                      Open grading <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <p className="text-xs text-muted-foreground">Your role does not include grading.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </section>

          {/*
            P8 — FIX QUEUE. Server-derived from THIS partner's own Card Jobs, which is why nobody
            ever types an MV number: typing one is what creates the opportunity to type someone
            else's. The wording is explicit that identity and payment survive a fix.
          */}
          {hasPermission("partner.cards.view") && (
            <section aria-labelledby="fix-title" className="space-y-3">
              <h2 id="fix-title" className="text-base font-semibold">
                Cards needing a replacement image
              </h2>
              <p className="text-sm text-muted-foreground">
                Fixing a card costs no Grading Credits. The card keeps its MV number, its certificate and the credit
                already paid for it.
              </p>
              {fixQueue.data && fixQueue.data.items.length === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="text-fix-empty">
                  Nothing to fix.
                </p>
              )}
              {fixQueue.data && fixQueue.data.items.length > 0 && (
                <div className="divide-y divide-border border-y border-border" data-testid="list-fix-queue">
                  {fixQueue.data.items.slice(0, 10).map((item) => (
                    <div key={item.cardJobId} className="py-3 flex items-center justify-between gap-4 text-sm">
                      <span className="font-mono">{item.mvNumber}</span>
                      <span className="text-xs text-rose-300">{item.missingLabel}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/*
            P8 — STATIONS. `ready` is the SERVER's verdict; the browser never recomputes it, so the
            console and the Scanner cannot disagree about whether a Mac can work.
          */}
          <section aria-labelledby="stations-title" className="space-y-3">
            <h2 id="stations-title" className="text-base font-semibold">
              Scanner stations
            </h2>
            {operations.data && operations.data.stations.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-stations-empty">
                No Scanner station has been registered yet.
              </p>
            )}
            {operations.data && operations.data.stations.length > 0 && (
              <div className="overflow-x-auto border border-border rounded-md" data-testid="table-stations-wrap">
                <table data-testid="table-stations" className="w-full text-sm">
                  <thead>
                    <tr>
                      <th scope="col">Station</th>
                      <th scope="col">Location</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last seen</th>
                      <th scope="col">App version</th>
                      <th scope="col">Ready</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operations.data.stations.map((station) => (
                      <tr key={station.stationCode}>
                        <td className="font-mono whitespace-nowrap">{station.stationCode}</td>
                        <td>{station.locationName || "Not available"}</td>
                        <td>{station.status}</td>
                        <td className="whitespace-nowrap">
                          {station.lastSeenAt ? new Date(station.lastSeenAt).toLocaleString("en-GB") : "Never"}
                        </td>
                        <td>{station.appVersion || "Unknown"}</td>
                        <td className={station.ready ? "text-emerald-300" : "text-muted-foreground"}>
                          {station.ready ? "Ready" : "Not ready"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/*
            P8 — LOCATIONS. Listed from the server with a station count, with no assumption that a
            partner has exactly one shop floor called "Main location". Creating and suspending a
            location remains a Super Admin action; this is the shop's read-only view of its estate.
          */}
          <section aria-labelledby="locations-title" className="space-y-3">
            <h2 id="locations-title" className="text-base font-semibold">
              Locations
            </h2>
            {operations.data && (
              <div className="divide-y divide-border border-y border-border" data-testid="list-locations">
                {operations.data.locations.map((location) => (
                  <div key={location.id} className="py-3 flex items-center justify-between gap-4 text-sm">
                    <span>{location.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {location.status} · {location.stationCount} station(s)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/*
            P8 — SETUP STATUS. Read from the SAME computation the Super Admin console uses, so the
            two can never disagree about whether a shop is ready. `stationReady === null` means the
            station subsystem is absent on this deployment, which is NOT the same as "no station
            yet" and is deliberately not reported as either ready or blocked.
          */}
          {readiness.data && (
            <section aria-labelledby="readiness-title" className="space-y-3">
              <h2 id="readiness-title" className="text-base font-semibold">
                Setup status
              </h2>
              <Card className="rounded-md" data-testid="card-onboarding-readiness">
                <CardContent className="pt-6 space-y-2 text-sm">
                  <p className="font-medium" data-testid="text-onboarding-state">
                    {READINESS_COPY[readiness.data.onboardingState] ?? readiness.data.onboardingState}
                  </p>
                  {readiness.data.blockedReasons && readiness.data.blockedReasons.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc pl-4" data-testid="list-readiness-reasons">
                      {readiness.data.blockedReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          <section aria-labelledby="submission-summary-title" className="space-y-3">
            <h2 id="submission-summary-title" className="text-base font-semibold">
              Submission summary
            </h2>
            {/*
              Only the three states the schema actually has are rendered. The previous version
              also advertised Validating / Grading / Awaiting correction / Completed as hardcoded
              nulls: partner_submissions.status is CHECK-constrained to
              ('draft','submitted_to_mintvault','cancelled') (migration 0007), so those four tiles
              could never populate, had no server signal behind them, and had no wiring point to
              light up later. Advertising four permanently-empty workflow stages to a paying
              partner reads as "the system is broken", not "not built yet".
            */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="grid-dashboard-cards">
              {[
                ["Drafts", submissions.data.draft, "draft"],
                ["Submitted", submissions.data.submitted_to_mintvault, "submitted"],
                ["Cancelled", submissions.data.cancelled, "cancelled"],
              ].map(([label, value, id]) => (
                <Card key={String(id)} className="rounded-md" data-testid={`card-dashboard-${id}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xl font-semibold" data-testid={`text-count-${id}`}>
                      {metric(value as number | null)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section aria-labelledby="shop-summary-title" className="space-y-3">
            <h2 id="shop-summary-title" className="text-base font-semibold">
              Shop workflow
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="grid-shop-workflow">
              <Card className="rounded-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Location</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-semibold" data-testid="text-dashboard-location">
                    {session?.locationName || "Not selected"}
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Customers</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-semibold" data-testid="text-dashboard-customers">
                    {customers.data ? metric(customers.data.length) : "Loading"}
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Ready to grade</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-semibold" data-testid="text-dashboard-ready-grade">
                    {gradingQueue.data
                      ? metric(
                          gradingQueue.data.items
                            .flatMap((item) => item.cards)
                            .filter((card) => card.gradingStatus === "assigned").length
                        )
                      : canAssessCards
                        ? "Not available"
                        : "Not authorised"}
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Grading</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-semibold" data-testid="text-dashboard-grading">
                    {gradingQueue.data
                      ? metric(
                          gradingQueue.data.items
                            .flatMap((item) => item.cards)
                            .filter((card) => card.gradingStatus === "pending_review").length
                        )
                      : canAssessCards
                        ? "Not available"
                        : "Not authorised"}
                  </p>
                </CardContent>
              </Card>
            </div>
          </section>

          <section aria-labelledby="scanner-station-title" className="space-y-3">
            <h2 id="scanner-station-title" className="text-base font-semibold">
              Scanner station
            </h2>
            <Card className="rounded-md" data-testid="card-dashboard-scanner-station">
              <CardContent className="pt-6 text-sm text-muted-foreground space-y-3">
                <p>
                  Set up the assigned Mac in the MintVault Scanner: sign in with your Partner account, choose an
                  authorised location, register the Mac, then wait for Super Admin approval. The Scanner shows the
                  authoritative station and calibration status; this dashboard does not guess at device approval.
                </p>
                {/*
                  A display of the server's verdict, not a control. The Scanner asks the server on every
                  NEW press and the server refuses independently of anything shown here, so this line
                  can only ever be a hint that saves the operator a walk to the Mac.
                */}
                {canViewCredits && credits.data && credits.data.summary.balanceStatus === "empty" && (
                  <p className="text-rose-300" data-testid="text-scanner-new-unavailable">
                    NEW CARD is unavailable on every station until credits are added. FIX and grading are unaffected.
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          {/*
            The "Operations" section (Cards in progress / Turnaround / Quality rating) was removed.
            All three were client-side literal "Not available" strings with no server field behind
            them — not even a MetricUnavailable reason code, so unlike the admin surface there was
            nothing for a future backend to light up. Reinstate them together with the server
            signal that populates them.
          */}

          {/* Recent activity is ledger data, so it carries the same permission gate as the panel above. */}
          {canViewCredits && credits.data && (
            <section aria-labelledby="recent-activity-title" className="space-y-3">
              <h2 id="recent-activity-title" className="text-base font-semibold">
                Recent activity
              </h2>
              {credits.data.ledger.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet</p>
              ) : (
                <div className="divide-y divide-border border-y border-border">
                  {credits.data.ledger.slice(0, 5).map((entry) => (
                    <div key={entry.id} className="py-3 flex items-center justify-between gap-4 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{entry.reason}</p>
                        <p className="text-xs text-muted-foreground">{new Date(entry.date).toLocaleString("en-GB")}</p>
                      </div>
                      <span className={entry.quantity > 0 ? "text-emerald-300" : "text-rose-300"}>
                        {entry.quantity > 0 ? "+" : ""}
                        {entry.quantity}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section aria-labelledby="recent-submissions-title" className="space-y-3">
            <h2 id="recent-submissions-title" className="text-base font-semibold">
              Recent submissions
            </h2>
            {recentSubmissions.data?.items?.length ? (
              <div
                className="divide-y divide-border border-y border-border"
                data-testid="list-dashboard-recent-submissions"
              >
                {recentSubmissions.data.items.map((item) => (
                  <Link
                    key={item.id}
                    href={`/partner/submissions/${item.id}`}
                    className="py-3 flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="font-mono">{item.internalReference || item.publicRef}</span>
                    <span className="text-xs text-muted-foreground">{STATUS_COPY[item.status] ?? item.status}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No submissions yet</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Plain-English readiness. The server's states are deliberately precise; a shop owner needs to know
 * what to DO next, so each one is rendered as the next action rather than as a status code.
 */
const READINESS_COPY: Record<string, string> = {
  INVITED: "Invited — the owner needs to open their setup link",
  AWAITING_PASSWORD_SETUP: "Waiting for a password to be set",
  AWAITING_MFA_SETUP: "Waiting for two-step security to be set up",
  STATION_SETUP_REQUIRED: "Register and approve a Scanner station to start scanning",
  READY_TO_LOG_IN: "Ready",
  LOGIN_BLOCKED: "Sign-in is blocked — contact MintVault",
  SUSPENDED: "Suspended — contact MintVault",
  REVOKED: "Revoked — contact MintVault",
};

const STATUS_COPY: Record<string, string> = {
  draft: "Draft",
  submitted_to_mintvault: "Submitted",
  cancelled: "Cancelled",
};
