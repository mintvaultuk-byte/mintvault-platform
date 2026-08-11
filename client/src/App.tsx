import { Switch, Route, useLocation } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout";
import ErrorBoundary from "@/components/error-boundary";
import { FeatureFlagsContext, useFeatureFlagsQuery } from "@/hooks/use-feature-flags";
import CookieBanner from "@/components/cookie-banner";
import VaultVideoBg from "@/components/v2/vault-video-bg";
import { PartnerSessionProvider } from "@/hooks/use-partner-session";
import { PartnerRouteGuard } from "@/components/partner/partner-route-guard";

// Critical-path pages — eagerly loaded
import Home from "@/pages/home";
import Verify from "@/pages/verify";
import LogbookPage from "@/pages/logbook";
import NotFound from "@/pages/not-found";

// Lazy-loaded pages
const LegalPage = lazy(() => import("@/pages/legal-page"));
// DEV-ONLY: canonical grading workstation preview harness (never in prod builds).
const DevCanonicalWorkstationHarness = lazy(() => import("@/pages/dev-canonical-workstation-harness"));
// The dynamic import sits INSIDE the `import.meta.env.DEV` ternary so a
// production build constant-folds it away entirely and Vite emits no chunk for
// it. Guarding only the <Route> (as above) leaves the route unreachable but
// still ships a dead lazy chunk. Never dereferenced outside the DEV guard below.
const DevCardDetailsHarness = import.meta.env.DEV
  ? lazy(() => import("@/pages/dev-card-details-harness"))
  : (null as unknown as ReturnType<typeof lazy>);
const CertDetailPage = lazy(() => import("@/pages/cert-detail"));
const WhyMintVaultPage = lazy(() => import("@/pages/why-mintvault"));
const LabelsPage = lazy(() => import("@/pages/labels"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const TcgPage = lazy(() => import("@/pages/tcg"));
const SubmitPage = lazy(() => import("@/pages/submit"));
const SubmitSuccessPage = lazy(() => import("@/pages/submit-success"));
const TrackPage = lazy(() => import("@/pages/track"));
const TermsPage = lazy(() => import("@/pages/terms"));
const LiabilityPage = lazy(() => import("@/pages/liability"));
const AdminPage = lazy(() => import("@/pages/admin"));
const GraderLoginPage = lazy(() => import("@/pages/grader-login"));
const GraderPage = lazy(() => import("@/pages/grader"));
const AdminGradersPage = lazy(() => import("@/pages/admin-graders"));
const StaffLoginPage = lazy(() => import("@/pages/staff-login"));
const StaffPage = lazy(() => import("@/pages/staff"));
const AdminStaffPage = lazy(() => import("@/pages/admin-staff"));
const AdminSecurityPage = lazy(() => import("@/pages/admin-security"));
const AdminSetsPage = lazy(() => import("@/pages/admin-sets"));
const AdminLegacyReviewPage = lazy(() => import("@/pages/admin-legacy-review"));
const AdminPokemonKnowledgePage = lazy(() => import("@/pages/admin-pokemon-knowledge"));
const AdminCataloguePage = lazy(() => import("@/pages/admin-catalogue"));
const AdminOperatorStatsPage = lazy(() => import("@/pages/admin-operator-stats"));
const AdminInstagramPage = lazy(() => import("@/pages/admin-instagram"));
const AdminWeeklyReelPage = lazy(() => import("@/pages/admin-weekly-reel"));
const AdminSocialStudioPage = lazy(() => import("@/pages/admin-social-studio"));
const AdminMvgsCalibrationPage = lazy(() => import("@/pages/admin-mvgs-calibration"));
const AdminVaultQuestPage = lazy(() => import("@/pages/admin-vault-quest"));
const AdminVaultQuestCardFactoryPage = lazy(() => import("@/pages/admin-vault-quest-card-factory"));
const VaultQuestStudioPage = lazy(() => import("@/pages/vault-quest-studio"));
const ReelsPage = lazy(() => import("@/pages/reels"));
const ShareReelPage = lazy(() => import("@/pages/share-reel"));
const StandardPage = lazy(() => import("@/pages/standard"));
const MvgsJoinPage = lazy(() => import("@/pages/mvgs-join"));
const CustomerLoginPage = lazy(() => import("@/pages/customer-login"));
const PinSetupPage = lazy(() => import("@/pages/auth/pin-setup"));
const PinForgotPage = lazy(() => import("@/pages/auth/pin-forgot"));
const PokemonCardGradingUkPage = lazy(() => import("@/pages/seo/pokemon-card-grading-uk"));
const TradingCardGradingUkPage = lazy(() => import("@/pages/seo/trading-card-grading-uk"));
const CardGradingServiceUkPage = lazy(() => import("@/pages/seo/card-grading-service-uk"));
const PsaAlternativeUkPage = lazy(() => import("@/pages/seo/psa-alternative-uk"));
const HowToGradePokemonCardsPage = lazy(() => import("@/pages/seo/how-to-grade-pokemon-cards"));
const TcgGradingUkPage = lazy(() => import("@/pages/seo/tcg-grading-uk"));
const YugiohCardGradingUkPage = lazy(() => import("@/pages/seo/yugioh-card-grading-uk"));
const OnePieceCardGradingUkPage = lazy(() => import("@/pages/seo/one-piece-card-grading-uk"));
const SportsCardGradingUkPage = lazy(() => import("@/pages/seo/sports-card-grading-uk"));
const MtgCardGradingUkPage = lazy(() => import("@/pages/seo/mtg-card-grading-uk"));
const BestCardGradingUkPage = lazy(() => import("@/pages/seo/best-card-grading-uk"));
const CardGradingCostUkPage = lazy(() => import("@/pages/seo/card-grading-cost-uk"));
const CardGradingNearMePage = lazy(() => import("@/pages/seo/card-grading-near-me"));
const NfcRedirectPage = lazy(() => import("@/pages/nfc-redirect"));
const StolenCardProtectionPage = lazy(() => import("@/pages/stolen-card-protection"));
const ClaimPage = lazy(() => import("@/pages/claim"));
const TransferPage = lazy(() => import("@/pages/transfer"));
const TransferAcceptPage = lazy(() => import("@/pages/transfer-accept"));
const TransferClaimByCodePage = lazy(() => import("@/pages/transfer-claim-by-code"));
const OwnershipPage = lazy(() => import("@/pages/ownership"));
const DashboardPage = lazy(() => import("@/pages/dashboard"));
const PopulationPage = lazy(() => import("@/pages/population"));
const PopCertsPage = lazy(() => import("@/pages/pop-certs"));
const ApiDocsPage = lazy(() => import("@/pages/api-docs"));
const GradingScalePage = lazy(() => import("@/pages/grading-scale"));
const GradingGlossaryPage = lazy(() => import("@/pages/grading-glossary"));
const GradingReportPage = lazy(() => import("@/pages/grading-report"));
const MobileUploadPage = lazy(() => import("@/pages/mobile-upload"));
const VaultReportPage = lazy(() => import("@/pages/vault-report"));
const OurStoryPage = lazy(() => import("@/pages/about/our-story"));
const EligibleCardsPage = lazy(() => import("@/pages/grading/eligible-cards"));
const VaultReportsAboutPage = lazy(() => import("@/pages/vault-reports/about"));
const HowToReadVaultPage = lazy(() => import("@/pages/vault-reports/how-to-read"));
const FAQPage = lazy(() => import("@/pages/help/faq"));
const ContactPage = lazy(() => import("@/pages/help/contact"));
const LoginPage = lazy(() => import("@/pages/login"));
const AdminLoginPage = lazy(() => import("@/pages/admin-login"));
const HomeV2Integrated = lazy(() => import("@/pages/home-v2-integrated"));
const HowItWorksV2 = lazy(() => import("@/pages/how-it-works-v2"));
const HomeV3 = lazy(() => import("@/pages/home-v3"));
const HomeV4 = lazy(() => import("@/pages/home-v4"));
const PricingV2Mockup = lazy(() => import("@/pages/pricing-v2"));
const Pricing = lazy(() => import("@/pages/pricing"));
const PricingDemo = lazy(() => import("@/pages/pricing-demo"));
const VaultClub = lazy(() => import("@/pages/vault-club"));
const AiPreGrade = lazy(() => import("@/pages/ai-pre-grade"));
const PreGradePage = lazy(() => import("@/pages/pre-grade"));
const ToolsEstimate = lazy(() => import("@/pages/tools-estimate"));
const Journal = lazy(() => import("@/pages/journal"));
const JournalDetail = lazy(() => import("@/pages/journal-detail"));
const Technology = lazy(() => import("@/pages/technology"));
const Registry = lazy(() => import("@/pages/registry"));
const SignupPage = lazy(() => import("@/pages/signup"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const VerifyEmailPage = lazy(() => import("@/pages/verify-email"));
const AccountSettingsPage = lazy(() => import("@/pages/account-settings"));
const ShowroomPage = lazy(() => import("@/pages/showroom"));
const ShowroomsListPage = lazy(() => import("@/pages/showrooms"));
const CommunityPage = lazy(() => import("@/pages/community"));
const AdminCommunityPage = lazy(() => import("@/pages/admin/community"));
const AdminPartnerNetworkPage = lazy(() => import("@/pages/admin/partner-network"));
const AdminPartnerManagementPage = lazy(() => import("@/pages/admin/partner-management"));
const AdminPartnerManagementDetailPage = lazy(() => import("@/pages/admin/partner-management-detail"));
const AdminProjectControlPage = lazy(() => import("@/pages/admin/project-control"));
const AdminProjectControlPackagePage = lazy(() => import("@/pages/admin/project-control-package"));
const AdminProjectControlShopLaunchPage = lazy(() => import("@/pages/admin/project-control-shop-launch"));
const AdminProjectControlScannerPage = lazy(() => import("@/pages/admin/project-control-scanner"));
const AdminPartnerDashboardPage = lazy(() => import("@/pages/admin/partner-dashboard"));

// Partner Portal (Phase 2, Increments A+B) — isolated /partner/* surface. Fails closed at the
// backend (partner_portal_enabled flag + emergency stop) if the flag is off; not enabled in any
// live environment yet. See INTEGRATION-ORDER.md.
const PartnerLoginPage = lazy(() => import("@/pages/partner/login"));
const PartnerInvitePage = lazy(() => import("@/pages/partner/invite"));
const PartnerPasswordResetRequestPage = lazy(() => import("@/pages/partner/password-reset-request"));
const PartnerPasswordResetPage = lazy(() => import("@/pages/partner/password-reset"));
const PartnerDashboardPage = lazy(() => import("@/pages/partner/dashboard"));
const PartnerSubmissionsPage = lazy(() => import("@/pages/partner/submissions"));
const PartnerSubmissionWizardPage = lazy(() => import("@/pages/partner/submission-wizard"));
const PartnerSubmissionDetailPage = lazy(() => import("@/pages/partner/submission-detail"));
const PartnerGradingPage = lazy(() => import("@/pages/partner/grading"));
const PartnerCustomersPage = lazy(() => import("@/pages/partner/customers"));
const PartnerUsersPage = lazy(() => import("@/pages/partner/users"));
const PartnerLocationsPage = lazy(() => import("@/pages/partner/locations"));
const PartnerBillingPage = lazy(() => import("@/pages/partner/billing"));
const PartnerHelpPage = lazy(() => import("@/pages/partner/help"));
const PartnerSecurityPage = lazy(() => import("@/pages/partner/security"));

function GoldBurstEffect() {
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!target) return;

      const interactive = target.closest('button:not([disabled]), [role="button"], a[href^="/"]');
      if (!interactive) return;

      if (interactive.closest("[data-no-burst]")) return;

      const isPrimary =
        interactive.classList.contains("gradient-btn-filled") || interactive.classList.contains("btn-gold");

      const el = document.createElement("div");
      el.className = isPrimary ? "gold-burst" : "gold-burst gold-burst-soft";
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 480);

      if (isPrimary) {
        const outer = document.createElement("div");
        outer.className = "gold-burst-outer";
        outer.style.left = `${e.clientX}px`;
        outer.style.top = `${e.clientY}px`;
        document.body.appendChild(outer);
        setTimeout(() => outer.remove(), 500);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  return null;
}

function ScrollReveal() {
  const [pathname] = useLocation();
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    const id = setTimeout(() => {
      document.querySelectorAll(".reveal-on-scroll:not(.revealed)").forEach((el) => observer.observe(el));
    }, 60);
    return () => {
      clearTimeout(id);
      observer.disconnect();
    };
  }, [pathname]);
  return null;
}

function ScrollToTop() {
  const [pathname] = useLocation();
  useEffect(() => {
    if (!window.location.hash) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
  }, [pathname]);
  return null;
}

function Redirect({ to }: { to: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(to, { replace: true });
  }, [to, setLocation]);
  return null;
}

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0e1a]">
      <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

/**
 * Mounted at BOTH "/partner" (bare) and "/partner/*" (wouter's regexparam wildcard requires a
 * literal trailing slash before the capture, so it never matches the bare path on its own — see
 * the two Route entries in Router() below). Session check is scoped to this subtree only — it
 * never fires for ordinary site traffic outside /partner/*.
 */
function PartnerPortalRoutes() {
  return (
    <PartnerSessionProvider>
      <Switch>
        <Route path="/partner/login">
          <PartnerLoginPage />
        </Route>
        <Route path="/partner/invite">
          <PartnerInvitePage />
        </Route>
        {/* Both reset pages are PUBLIC by design — a user who cannot sign in must be able to
            reach them, so they sit outside PartnerRouteGuard alongside login and invite. */}
        <Route path="/partner/forgot-password">
          <PartnerPasswordResetRequestPage />
        </Route>
        <Route path="/partner/reset">
          <PartnerPasswordResetPage />
        </Route>
        <Route path="/partner/dashboard">
          <PartnerRouteGuard>
            <PartnerDashboardPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/submissions/new">
          <PartnerRouteGuard>
            <PartnerSubmissionWizardPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/submissions/:id">
          <PartnerRouteGuard>
            <PartnerSubmissionDetailPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/submissions">
          <PartnerRouteGuard>
            <PartnerSubmissionsPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/customers">
          <PartnerRouteGuard>
            <PartnerCustomersPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/grading">
          <PartnerRouteGuard requiredPermission="partner.cards.assess">
            <PartnerGradingPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/users">
          <PartnerRouteGuard>
            <PartnerUsersPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/locations">
          <PartnerRouteGuard>
            <PartnerLocationsPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/billing">
          <PartnerRouteGuard>
            <PartnerBillingPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/help">
          <PartnerRouteGuard>
            <PartnerHelpPage />
          </PartnerRouteGuard>
        </Route>
        <Route path="/partner/security">
          <PartnerRouteGuard>
            <PartnerSecurityPage />
          </PartnerRouteGuard>
        </Route>
        <Route>
          <Redirect to="/partner/dashboard" />
        </Route>
      </Switch>
    </PartnerSessionProvider>
  );
}

function Router() {
  return (
    <>
      <VaultVideoBg />
      <ScrollToTop />
      <ScrollReveal />
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/admin/login">
            <AdminLoginPage />
          </Route>
          <Route path="/partner">
            <PartnerPortalRoutes />
          </Route>
          <Route path="/partner/*">
            <PartnerPortalRoutes />
          </Route>
          <Route path="/home-v2-integrated" component={HomeV2Integrated} />
          <Route path="/how-it-works-v2" component={HowItWorksV2} />
          <Route path="/home-v3" component={HomeV3} />
          <Route path="/home-v4" component={HomeV4} />
          <Route path="/pricing-v2" component={PricingV2Mockup} />
          <Route path="/pricing-demo" component={PricingDemo} />
          {import.meta.env.DEV && (
            <Route path="/dev/canonical-workstation" component={DevCanonicalWorkstationHarness} />
          )}
          {import.meta.env.DEV && <Route path="/dev/card-details" component={DevCardDetailsHarness} />}
          <Route path="/admin" component={AdminPage} />
          <Route path="/admin/promotions" component={AdminPage} />
          <Route path="/admin/graders" component={AdminStaffPage} />
          <Route path="/admin/staff" component={AdminStaffPage} />
          <Route path="/admin/security" component={AdminSecurityPage} />
          <Route path="/admin/sets" component={AdminSetsPage} />
          <Route path="/admin/legacy-review" component={AdminLegacyReviewPage} />
          <Route path="/admin/pokemon-knowledge" component={AdminPokemonKnowledgePage} />
          <Route path="/admin/catalogue" component={AdminCataloguePage} />
          <Route path="/admin/operator-stats" component={AdminOperatorStatsPage} />
          <Route path="/grader/login">
            <GraderLoginPage />
          </Route>
          <Route path="/grader" component={GraderPage} />
          <Route path="/staff/login">
            <StaffLoginPage />
          </Route>
          <Route path="/staff" component={StaffPage} />
          <Route path="/admin/instagram" component={AdminInstagramPage} />
          <Route path="/admin/social-studio" component={AdminSocialStudioPage} />
          <Route path="/admin/weekly-reel" component={AdminWeeklyReelPage} />
          <Route path="/admin/mvgs-calibration" component={AdminMvgsCalibrationPage} />
          <Route path="/admin/vault-quest/studio" component={VaultQuestStudioPage} />
          <Route path="/admin/vault-quest/card-factory" component={AdminVaultQuestCardFactoryPage} />
          <Route path="/admin/vault-quest" component={AdminVaultQuestPage} />
          <Route path="/admin/community" component={AdminCommunityPage} />
          {/* Project Control — most specific first, so /shop-launch and /scanner are not
              swallowed by the /package/:key route or the bare index route. */}
          <Route path="/admin/project-control/shop-launch" component={AdminProjectControlShopLaunchPage} />
          <Route path="/admin/project-control/scanner" component={AdminProjectControlScannerPage} />
          <Route path="/admin/project-control/package/:key" component={AdminProjectControlPackagePage} />
          <Route path="/admin/project-control" component={AdminProjectControlPage} />
          {/* Most-specific first. /admin/partners/dashboard MUST stay above any future
              /admin/partners/:partnerId route, or wouter captures the literal "dashboard". */}
          <Route path="/admin/partners/dashboard" component={AdminPartnerDashboardPage} />
          {/* The two blocks above are disjoint prefixes (/admin/project-control* vs
              /admin/partners/dashboard) and do not shadow one another. */}
          <Route path="/admin/partner-network/partners/:partnerId" component={AdminPartnerManagementDetailPage} />
          <Route path="/admin/partner-network/partners" component={AdminPartnerManagementPage} />
          <Route path="/admin/partner-network" component={AdminPartnerNetworkPage} />
          <Route path="/community" component={CommunityPage} />
          <Route path="/reels" component={ReelsPage} />
          <Route path="/share/reel/:date/:certNumber" component={ShareReelPage} />
          <Route path="/standard" component={StandardPage} />
          <Route path="/grading-standard" component={StandardPage} />
          <Route path="/mvgs/join" component={MvgsJoinPage} />
          <Route path="/admin/cert/:id" component={LogbookPage} />
          <Route path="/upload/:certId/:imageType" component={MobileUploadPage} />
          <Route path="/nfc/:certId" component={NfcRedirectPage} />
          <Route path="/cert/:id/report" component={GradingReportPage} />
          <Route path="/cert/:id" component={LogbookPage} />
          <Route path="/vault/:certId" component={LogbookPage} />
          <Route path="/" component={Home} />
          <Route path="/pricing" component={Pricing} />
          <Route path="/vault-club" component={VaultClub} />
          <Route path="/verify" component={Verify} />
          <Route path="/ai-pre-grade" component={AiPreGrade} />
          <Route path="/pre-grade" component={PreGradePage} />
          <Route path="/tools/estimate" component={ToolsEstimate} />
          <Route path="/journal" component={Journal} />
          <Route path="/journal/:slug" component={JournalDetail} />
          <Route path="/technology" component={Technology} />
          <Route path="/registry" component={Registry} />
          <Route>
            <Layout>
              <Switch>
                <Route path="/cert">
                  <Redirect to="/verify" />
                </Route>
                <Route path="/why-mintvault" component={WhyMintVaultPage} />
                <Route path="/labels" component={LabelsPage} />
                <Route path="/reports" component={ReportsPage} />
                <Route path="/tcg" component={TcgPage} />
                <Route path="/submit" component={SubmitPage} />
                <Route path="/submit/success" component={SubmitSuccessPage} />
                <Route path="/track" component={TrackPage} />
                <Route path="/terms-and-conditions" component={TermsPage} />
                <Route path="/liability-and-insurance" component={LiabilityPage} />
                <Route path="/guides">
                  <Redirect to="/journal" />
                </Route>
                <Route path="/guides/:slug">
                  {(params) => <Redirect to={`/journal/${(params as { slug: string }).slug}`} />}
                </Route>
                <Route path="/pokemon-card-grading-uk" component={PokemonCardGradingUkPage} />
                <Route path="/trading-card-grading-uk" component={TradingCardGradingUkPage} />
                <Route path="/card-grading-service-uk" component={CardGradingServiceUkPage} />
                <Route path="/psa-alternative-uk" component={PsaAlternativeUkPage} />
                <Route path="/how-to-grade-pokemon-cards" component={HowToGradePokemonCardsPage} />
                <Route path="/tcg-grading-uk" component={TcgGradingUkPage} />
                <Route path="/yugioh-card-grading-uk" component={YugiohCardGradingUkPage} />
                <Route path="/one-piece-card-grading-uk" component={OnePieceCardGradingUkPage} />
                <Route path="/sports-card-grading-uk" component={SportsCardGradingUkPage} />
                <Route path="/mtg-card-grading-uk" component={MtgCardGradingUkPage} />
                <Route path="/best-card-grading-uk" component={BestCardGradingUkPage} />
                <Route path="/card-grading-cost-uk" component={CardGradingCostUkPage} />
                <Route path="/card-grading-near-me" component={CardGradingNearMePage} />
                <Route path="/stolen-card-protection" component={StolenCardProtectionPage} />
                <Route path="/ownership" component={OwnershipPage} />
                <Route path="/claim" component={ClaimPage} />
                <Route path="/transfer" component={TransferPage} />
                <Route path="/transfer/accept" component={TransferAcceptPage} />
                <Route path="/transfer/claim-by-code" component={TransferClaimByCodePage} />
                <Route path="/dashboard" component={DashboardPage} />
                <Route path="/population" component={PopulationPage} />
                <Route path="/population/certs" component={PopCertsPage} />
                <Route path="/api-docs" component={ApiDocsPage} />
                <Route path="/grading-scale" component={GradingScalePage} />
                <Route path="/grading-glossary" component={GradingGlossaryPage} />
                <Route path="/how-it-works">
                  <Redirect to="/technology" />
                </Route>
                <Route path="/legal/:slug" component={LegalPage} />
                <Route path="/about/our-story" component={OurStoryPage} />
                <Route path="/about/the-mintvault-slab">
                  <Redirect to="/technology" />
                </Route>
                <Route path="/grading/eligible-cards" component={EligibleCardsPage} />
                <Route path="/vault-reports/about" component={VaultReportsAboutPage} />
                <Route path="/vault-reports/how-to-read" component={HowToReadVaultPage} />
                <Route path="/help/faq" component={FAQPage} />
                <Route path="/help/contact" component={ContactPage} />
                <Route path="/login" component={LoginPage} />
                <Route path="/customer-login" component={CustomerLoginPage} />
                <Route path="/auth/pin/setup" component={PinSetupPage} />
                <Route path="/auth/pin/forgot" component={PinForgotPage} />
                <Route path="/signup" component={SignupPage} />
                <Route path="/forgot-password" component={ForgotPasswordPage} />
                <Route path="/reset-password" component={ResetPasswordPage} />
                <Route path="/verify-email" component={VerifyEmailPage} />
                <Route path="/account/settings" component={AccountSettingsPage} />
                <Route path="/showrooms" component={ShowroomsListPage} />
                <Route path="/showroom/:username" component={ShowroomPage} />
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </Route>
        </Switch>
      </Suspense>
    </>
  );
}

function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const { data } = useFeatureFlagsQuery();
  return (
    <FeatureFlagsContext.Provider value={data || { legalPagesLive: false }}>{children}</FeatureFlagsContext.Provider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <FeatureFlagsProvider>
          <TooltipProvider>
            <GoldBurstEffect />
            <Toaster />
            <Router />
            <CookieBanner />
          </TooltipProvider>
        </FeatureFlagsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
