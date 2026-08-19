const PARTNER_UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const LEGACY_DASHBOARD_WORKSPACE: Record<string, string> = {
  overview: "",
  staff: "staff",
  wallet: "credits",
  submissions: "cards",
  security: "security",
  audit: "security",
};
const RETAINED_LEGACY_DASHBOARD_TABS = new Set(["quality", "corrections", "devices"]);

/**
 * Translate the old dashboard's Partner drill-down query state to the canonical workspace URL.
 * Tabs without a canonical equivalent stay on the retained dashboard surface.
 */
export function canonicalLegacyPartnerDestination(
  canonical: string,
  pathname: string,
  search: string,
  hash: string
): string | null {
  const params = new URLSearchParams(search);
  const partnerId = params.get("partner");
  const tab = params.get("tab") ?? "overview";
  if (pathname === "/admin/partners/dashboard" && partnerId && PARTNER_UUID_RE.test(partnerId)) {
    if (RETAINED_LEGACY_DASHBOARD_TABS.has(tab)) return null;
    const workspaceTab = LEGACY_DASHBOARD_WORKSPACE[tab];
    if (workspaceTab !== undefined) {
      params.delete("partner");
      params.delete("tab");
      const remainingQuery = params.toString();
      return `/admin/partners/${partnerId}${workspaceTab ? `/${workspaceTab}` : ""}${remainingQuery ? `?${remainingQuery}` : ""}${hash}`;
    }
  }
  return `${canonical}${search}${hash}`;
}
