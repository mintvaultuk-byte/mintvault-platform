import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout";

function ScrollToTop() {
  const [pathname] = useLocation();
  useEffect(() => {
    // Skip anchor links — let the browser scroll to the target naturally
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
import NfcRedirectPage from "@/pages/nfc-redirect";
import ClaimPage from "@/pages/claim";

function Router() {
  return (
    <>
      <ScrollToTop />
      <Switch>
      <Route path="/admin">
        <AdminPage />
      </Route>
      <Route path="/nfc/:certId" component={NfcRedirectPage} />
      <Route path="/" component={HomePage} />
      <Route>
        <Layout>
          <Switch>
            <Route path="/pricing" component={PricingPage} />
            <Route path="/cert" component={CertLookupPage} />
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
            <Route path="/claim" component={ClaimPage} />
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
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
