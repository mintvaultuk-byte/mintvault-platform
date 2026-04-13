import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout";

/* ─── Gold press burst — fires on every button/link press ───────────────────
 * Uses a global pointerdown listener so it covers all buttons automatically.
 * Creates a DOM element at the exact tap/click point, animates, then removes.
 * Navigation is never blocked — the burst plays over the top asynchronously.
 */
function GoldBurstEffect() {
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!target) return;

      // Fire on buttons AND internal navigation links (<a href="/">)
      const interactive = target.closest(
        'button:not([disabled]), [role="button"], a[href^="/"]'
      );
      if (!interactive) return;

      // Opt-out escape hatch — add data-no-burst to any element to suppress
      if (interactive.closest("[data-no-burst]")) return;

      // Primary gold CTAs get the full burst + outer ring
      const isPrimary = interactive.classList.contains("btn-gold");

      const el = document.createElement("div");
      el.className = isPrimary ? "gold-burst" : "gold-burst gold-burst-soft";
      el.style.left = `${e.clientX}px`;
      el.style.top  = `${e.clientY}px`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 480);

      // Secondary outer energy ring — primary CTAs only
      if (isPrimary) {
        const outer = document.createElement("div");
        outer.className = "gold-burst-outer";
        outer.style.left = `${e.clientX}px`;
        outer.style.top  = `${e.clientY}px`;
        document.body.appendChild(outer);
        setTimeout(() => outer.remove(), 500);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  return null;
}

/* ─── Global scroll-reveal observer ─────────────────────────────────────────
 * Watches all .reveal-on-scroll elements and adds .revealed when they enter
 * the viewport. Re-observes on route change (ScrollToTop fires first, then
 * new page elements are mounted). Single observer instance, low overhead.
 */
function ScrollReveal() {
  const [pathname] = useLocation();
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            observer.unobserve(entry.target); // fire once
          }
        });
      },
      { threshold: 0.12 }
    );
    // Small delay so new page elements are painted before we observe
    const id = setTimeout(() => {
      document.querySelectorAll(".reveal-on-scroll:not(.revealed)").forEach((el) =>
        observer.observe(el)
      );
    }, 60);
    return () => { clearTimeout(id); observer.disconnect(); };
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

import HomePage from "@/pages/home";
import PricingPage from "@/pages/pricing";
import CertLookupPage from "@/pages/cert-lookup";
import CertDetailPage from "@/pages/cert-detail";
import WhyMintVaultPage from "@/pages/why-mintvault";
import LabelsPage from "@/pages/labels";
import ReportsPage from "@/pages/reports";
import TcgPage from "@/pages/tcg";
import SubmitPage from "@/pages/submit";
import SubmitSuccessPage from "@/pages/submit-success";
import TrackPage from "@/pages/track";
import TermsPage from "@/pages/terms";
import LiabilityPage from "@/pages/liability";
import AdminPage from "@/pages/admin";
import NotFound from "@/pages/not-found";
import GuidesPage from "@/pages/guides";
import GuideDetailPage from "@/pages/guide-detail";
import PokemonCardGradingUkPage from "@/pages/seo/pokemon-card-grading-uk";
import TradingCardGradingUkPage from "@/pages/seo/trading-card-grading-uk";
import CardGradingServiceUkPage from "@/pages/seo/card-grading-service-uk";
import PsaAlternativeUkPage from "@/pages/seo/psa-alternative-uk";
import HowToGradePokemonCardsPage from "@/pages/seo/how-to-grade-pokemon-cards";
import TcgGradingUkPage from "@/pages/seo/tcg-grading-uk";
import YugiohCardGradingUkPage from "@/pages/seo/yugioh-card-grading-uk";
import OnePieceCardGradingUkPage from "@/pages/seo/one-piece-card-grading-uk";
import SportsCardGradingUkPage from "@/pages/seo/sports-card-grading-uk";
import MtgCardGradingUkPage from "@/pages/seo/mtg-card-grading-uk";
import BestCardGradingUkPage from "@/pages/seo/best-card-grading-uk";
import CardGradingCostUkPage from "@/pages/seo/card-grading-cost-uk";
import CardGradingNearMePage from "@/pages/seo/card-grading-near-me";
import NfcRedirectPage from "@/pages/nfc-redirect";
import StolenCardProtectionPage from "@/pages/stolen-card-protection";
import ClaimPage from "@/pages/claim";
import TransferPage from "@/pages/transfer";
import OwnershipPage from "@/pages/ownership";
import DashboardPage from "@/pages/dashboard";
import PopulationPage from "@/pages/population";
import PopCertsPage from "@/pages/pop-certs";
import ApiDocsPage from "@/pages/api-docs";
import GradingScalePage from "@/pages/grading-scale";
import GradingGlossaryPage from "@/pages/grading-glossary";
import GradingReportPage from "@/pages/grading-report";
import MobileUploadPage from "@/pages/mobile-upload";
import PreGradeEstimatePage from "@/pages/tools/estimate";
import HowItWorksPage from "@/pages/how-it-works";
import VaultReportPage from "@/pages/vault-report";
import LogbookPage from "@/pages/logbook";
import OurStoryPage from "@/pages/about/our-story";
import TheMintVaultSlabPage from "@/pages/about/the-mintvault-slab";
import EligibleCardsPage from "@/pages/grading/eligible-cards";
import VaultReportsAboutPage from "@/pages/vault-reports/about";
import HowToReadVaultPage from "@/pages/vault-reports/how-to-read";
import FAQPage from "@/pages/help/faq";
import ContactPage from "@/pages/help/contact";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import VerifyEmailPage from "@/pages/verify-email";
import AccountSettingsPage from "@/pages/account-settings";
import ShowroomPage from "@/pages/showroom";
import ShowroomsListPage from "@/pages/showrooms";
import ClubPage from "@/pages/club";

function Router() {
  return (
    <>
      <ScrollToTop />
      <ScrollReveal />
      <Switch>
        <Route path="/admin">
          <AdminPage />
        </Route>
        <Route path="/upload/:certId/:imageType" component={MobileUploadPage} />
        <Route path="/nfc/:certId" component={NfcRedirectPage} />
        <Route path="/" component={HomePage} />
        <Route>
          <Layout>
            <Switch>
              <Route path="/pricing" component={PricingPage} />
              <Route path="/cert" component={CertLookupPage} />
              <Route path="/cert/:id/report" component={GradingReportPage} />
              <Route path="/cert/:id" component={CertDetailPage} />
              <Route path="/why-mintvault" component={WhyMintVaultPage} />
              <Route path="/labels" component={LabelsPage} />
              <Route path="/reports" component={ReportsPage} />
              <Route path="/tcg" component={TcgPage} />
              <Route path="/submit" component={SubmitPage} />
              <Route path="/submit/success" component={SubmitSuccessPage} />
              <Route path="/track" component={TrackPage} />
              <Route path="/terms-and-conditions" component={TermsPage} />
              <Route path="/liability-and-insurance" component={LiabilityPage} />
              <Route path="/guides" component={GuidesPage} />
              <Route path="/guides/:slug" component={GuideDetailPage} />
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
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/population" component={PopulationPage} />
              <Route path="/population/certs" component={PopCertsPage} />
              <Route path="/api-docs" component={ApiDocsPage} />
              <Route path="/grading-scale" component={GradingScalePage} />
              <Route path="/grading-glossary" component={GradingGlossaryPage} />
              <Route path="/tools/estimate" component={PreGradeEstimatePage} />
              <Route path="/how-it-works" component={HowItWorksPage} />
              <Route path="/vault/:certId" component={LogbookPage} />
              <Route path="/about/our-story" component={OurStoryPage} />
              <Route path="/about/the-mintvault-slab" component={TheMintVaultSlabPage} />
              <Route path="/grading/eligible-cards" component={EligibleCardsPage} />
              <Route path="/vault-reports/about" component={VaultReportsAboutPage} />
              <Route path="/vault-reports/how-to-read" component={HowToReadVaultPage} />
              <Route path="/help/faq" component={FAQPage} />
              <Route path="/help/contact" component={ContactPage} />
              <Route path="/login" component={LoginPage} />
              <Route path="/signup" component={SignupPage} />
              <Route path="/forgot-password" component={ForgotPasswordPage} />
              <Route path="/reset-password" component={ResetPasswordPage} />
              <Route path="/verify-email" component={VerifyEmailPage} />
              <Route path="/account/settings" component={AccountSettingsPage} />
              <Route path="/showrooms" component={ShowroomsListPage} />
              <Route path="/showroom/:username" component={ShowroomPage} />
              <Route path="/club" component={ClubPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </Route>
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <GoldBurstEffect />
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
