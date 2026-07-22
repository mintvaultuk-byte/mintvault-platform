import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowRight, Loader2, Search, Sparkles, X } from "lucide-react";
import { AdminButton, Panel } from "@/components/admin";

type AdminDestinationTab = "dashboard" | "certs" | "submissions" | "printing";

type AttentionItem = {
  id: string;
  title: string;
  description: string;
  count: number;
  severity: "urgent" | "attention";
  href: string;
};

type SearchResult = {
  id: string;
  type: "certificate" | "submission" | "staff" | "partner";
  title: string;
  subtitle: string;
  href: string;
};

type OperationsData = {
  items: AttentionItem[];
  features: { partnerManagement: boolean; partnerConnectors: boolean };
};

type SearchResponse = {
  query: string;
  groups: Record<SearchResult["type"], SearchResult[]>;
};

const SEARCH_MIN_LENGTH = 2;
const GROUP_LABELS: Record<SearchResult["type"], string> = {
  certificate: "Certificates",
  submission: "Submissions",
  staff: "Staff",
  partner: "Partners",
};

function eligibleSearchQuery(value: string): boolean {
  return /^\d+$/.test(value) || value.length >= SEARCH_MIN_LENGTH;
}

function isDestinationTab(value: string | null): value is AdminDestinationTab {
  return value === "dashboard" || value === "certs" || value === "submissions" || value === "printing";
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error("Operational data is temporarily unavailable.");
  return response.json() as Promise<T>;
}

function useDebouncedValue(value: string, delay = 350): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}

/** Focused Super Admin layer. It only links to existing, authoritative pages. */
export default function OperationsDashboard({ onTabChange }: { onTabChange: (tab: AdminDestinationTab) => void }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const debouncedQuery = useDebouncedValue(query.trim());
  const searchEligible = eligibleSearchQuery(debouncedQuery);

  const attention = useQuery<OperationsData>({
    queryKey: ["/api/admin/operations/attention"],
    queryFn: ({ signal }) => requestJson("/api/admin/operations/attention", signal),
    refetchInterval: 60_000,
  });

  const search = useQuery<SearchResponse>({
    queryKey: ["/api/admin/operations/search", debouncedQuery],
    queryFn: ({ signal }) =>
      requestJson(`/api/admin/operations/search?q=${encodeURIComponent(debouncedQuery)}`, signal),
    enabled: searchEligible,
  });

  const visibleAttention = (attention.data?.items ?? []).filter((item) => item.count > 0);
  const groups = search.data?.groups;
  const flatResults = useMemo(
    () => (["certificate", "submission", "staff", "partner"] as const).flatMap((type) => groups?.[type] ?? []),
    [groups]
  );

  useEffect(() => setActiveIndex(-1), [debouncedQuery]);

  const go = (href: string) => {
    const url = new URL(href, window.location.origin);
    const tab = url.searchParams.get("tab");
    if (isDestinationTab(tab)) onTabChange(tab);
    navigate(href);
  };

  const clearSearch = () => {
    setQuery("");
    setActiveIndex(-1);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && flatResults.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, flatResults.length - 1));
    } else if (event.key === "ArrowUp" && flatResults.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && activeIndex >= 0 && flatResults[activeIndex]) {
      event.preventDefault();
      go(flatResults[activeIndex].href);
    } else if (event.key === "Escape") {
      clearSearch();
    }
  };

  const quickActions = [
    { label: "Find certificate", description: "Search the certificate register", href: "/admin?tab=certs" },
    {
      label: "Review grading queue",
      description: "Open staff-submitted grades",
      href: "/admin/staff?queue=pending_review",
    },
    { label: "Open submissions", description: "Manage intake and fulfilment", href: "/admin?tab=submissions" },
    { label: "Print labels", description: "Open the label queue", href: "/admin?tab=printing&print=unprinted" },
    { label: "Manage staff", description: "Open staff controls", href: "/admin/staff" },
    ...(attention.data?.features.partnerManagement
      ? [
          {
            label: "Partner shops",
            description: "Manage partner organisations",
            href: "/admin/partner-network/partners",
          },
        ]
      : []),
    ...(attention.data?.features.partnerConnectors
      ? [{ label: "Partner connectors", description: "View connector operations", href: "/admin/partner-network" }]
      : []),
  ];

  return (
    <section
      className="space-y-[14px] mt-[14px]"
      aria-label="Super Admin operations controls"
      data-testid="operations-dashboard"
    >
      <Panel
        title={
          <span className="flex items-center gap-2" data-testid="operations-search-title">
            <Search size={14} /> Universal Admin Search
          </span>
        }
        sub="Certificates, submissions, staff, partners, payment references, NFC UIDs and grading assignments"
      >
        <div className="relative" role="search">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2"
            size={16}
            style={{ color: "var(--admin-ink-faint)" }}
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search certificate, submission, customer, card, staff, partner, Stripe or NFC…"
            className="admin-input w-full"
            style={{ paddingLeft: 36, paddingRight: query ? 38 : 12 }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchEligible && flatResults.length > 0}
            aria-controls="operations-search-results"
            aria-activedescendant={activeIndex >= 0 ? `operations-search-result-${activeIndex}` : undefined}
            aria-label="Universal Admin Search"
            data-testid="operations-search-input"
          />
          {query && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear universal search"
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--admin-ink-faint)" }}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--admin-ink-faint)" }}>
          Enter at least two characters. Exact numeric identifiers can be searched immediately.
        </p>

        {query.trim() && !searchEligible && (
          <p
            className="text-xs mt-3"
            style={{ color: "var(--admin-ink-faint)" }}
            data-testid="operations-search-minimum"
          >
            Keep typing to search.
          </p>
        )}
        {search.isFetching && searchEligible && (
          <div className="flex items-center gap-2 text-xs mt-3" style={{ color: "var(--admin-ink-faint)" }}>
            <Loader2 size={14} className="animate-spin" /> Searching operational records…
          </div>
        )}
        {search.isError && searchEligible && (
          <p className="text-xs mt-3" style={{ color: "var(--admin-red)" }} role="alert">
            Search is unavailable. Try again in a moment.
          </p>
        )}
        {!search.isFetching && !search.isError && searchEligible && search.data && flatResults.length === 0 && (
          <p className="text-xs mt-3" style={{ color: "var(--admin-ink-faint)" }} data-testid="operations-search-empty">
            No matching operational records.
          </p>
        )}
        {flatResults.length > 0 && (
          <div
            id="operations-search-results"
            role="listbox"
            aria-label="Universal Admin Search results"
            className="mt-3 grid gap-3"
            data-testid="operations-search-results"
          >
            {(["certificate", "submission", "staff", "partner"] as const).map((type) => {
              const results = groups?.[type] ?? [];
              if (!results.length) return null;
              return (
                <div key={type}>
                  <p className="text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: "var(--admin-gold-hi)" }}>
                    {GROUP_LABELS[type]}
                  </p>
                  <div className="admin-tin">
                    {results.map((result) => {
                      const resultIndex = flatResults.findIndex(
                        (candidate) => candidate.type === result.type && candidate.id === result.id
                      );
                      return (
                        <button
                          type="button"
                          key={`${result.type}-${result.id}`}
                          id={`operations-search-result-${resultIndex}`}
                          role="option"
                          aria-selected={activeIndex === resultIndex}
                          onMouseEnter={() => setActiveIndex(resultIndex)}
                          onClick={() => go(result.href)}
                          className="admin-tin-row is-clickable text-left"
                          data-testid={`operations-search-${result.type}-${result.id}`}
                        >
                          <span className="admin-tin-row__top">
                            <span className="admin-tin-row__nm">{result.title}</span>
                            <ArrowRight size={13} style={{ color: "var(--admin-ink-faint)" }} />
                          </span>
                          <span className="text-xs" style={{ color: "var(--admin-ink-faint)" }}>
                            {result.subtitle}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="admin-cols">
        <Panel
          title={
            <span className="flex items-center gap-2" data-testid="needs-attention-title">
              <AlertTriangle size={14} /> Needs Attention
            </span>
          }
          sub="Only live, actionable records are shown"
        >
          {attention.isLoading ? (
            <div className="flex items-center gap-2 py-5 text-sm" style={{ color: "var(--admin-ink-faint)" }}>
              <Loader2 size={15} className="animate-spin" /> Loading attention items…
            </div>
          ) : attention.isError ? (
            <p className="py-5 text-sm" style={{ color: "var(--admin-red)" }} role="alert">
              Attention items could not be loaded. Refresh to retry.
            </p>
          ) : visibleAttention.length === 0 ? (
            <p className="py-5 text-sm" style={{ color: "var(--admin-ink-faint)" }} data-testid="needs-attention-empty">
              No active operational items need attention.
            </p>
          ) : (
            <div className="admin-tin" data-testid="needs-attention-items">
              {visibleAttention.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => go(item.href)}
                  className="admin-tin-row is-clickable text-left"
                  data-testid={`needs-attention-${item.id}`}
                >
                  <span className="admin-tin-row__top">
                    <span className="admin-tin-row__nm flex items-center gap-2">
                      {item.severity === "urgent" && <AlertTriangle size={13} style={{ color: "var(--admin-red)" }} />}
                      {item.title}
                    </span>
                    <span
                      className="admin-tin-row__ct"
                      style={{ color: item.severity === "urgent" ? "var(--admin-red)" : undefined }}
                    >
                      {item.count}
                    </span>
                  </span>
                  <span className="text-xs" style={{ color: "var(--admin-ink-faint)" }}>
                    {item.description}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-2" data-testid="quick-actions-title">
              <Sparkles size={14} /> Quick Actions
            </span>
          }
          sub="Secure shortcuts to existing admin tools"
        >
          <div className="grid gap-2 sm:grid-cols-2" data-testid="quick-actions-list">
            {quickActions.map((action) => (
              <AdminButton
                key={action.label}
                variant="ghost"
                className="justify-between text-left h-auto min-h-14 px-3"
                onClick={() => go(action.href)}
                data-testid={`quick-action-${action.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <span className="flex flex-col items-start">
                  <span>{action.label}</span>
                  <span className="text-[10px] normal-case font-normal" style={{ color: "var(--admin-ink-faint)" }}>
                    {action.description}
                  </span>
                </span>
                <ArrowRight size={13} />
              </AdminButton>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}
