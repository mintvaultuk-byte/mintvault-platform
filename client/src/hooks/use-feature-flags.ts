import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";

export interface FeatureFlags {
  legalPagesLive: boolean;
  privacyNoticeLive: boolean;
  partnerApplicationsLive: boolean;
  publicPartnerDirectoryLive: boolean;
}

const DEFAULT: FeatureFlags = {
  legalPagesLive: false,
  privacyNoticeLive: false,
  partnerApplicationsLive: false,
  publicPartnerDirectoryLive: false,
};

export const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT);

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlagsQuery() {
  return useQuery<FeatureFlags>({
    queryKey: ["/api/config/public-flags"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/config/public-flags");
        if (!res.ok) return DEFAULT;
        return res.json();
      } catch { return DEFAULT; }
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // Bound the time an already-open page can retain a revoked public surface.
    refetchInterval: 30_000,
  });
}
