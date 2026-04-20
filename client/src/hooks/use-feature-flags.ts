import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";

export interface FeatureFlags {
  legalPagesLive: boolean;
}

const DEFAULT: FeatureFlags = { legalPagesLive: false };

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
    staleTime: 5 * 60 * 1000, // cache 5 minutes
  });
}
