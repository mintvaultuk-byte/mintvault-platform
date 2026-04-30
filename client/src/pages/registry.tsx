import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, CheckCircle } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";

// ── API types ────────────────────────────────────────────────────────────

interface PopulationCounters {
  total_graded: number;
  unique_cards: number;
  unique_sets: number;
  claimed_count: number;
  avg_grade: number;
}

interface RecentCert {
  certificate_number: string;
  card_name: string | null;
  card_set: string | null;
  grade: number | null;
  label_type: string;
  card_image_front_url: string | null;
  approved_at: string;
}

interface PopulationResponse {
  counters: PopulationCounters;
  recent: RecentCert[];
  population: unknown[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

const SPECIALS: Record<string, string> = { pokemon: "Pokémon" };

function titleCase(s: string | null): string {
  if (!s) return "—";
  return s
    .split(" ")
    .map((w) =>
      SPECIALS[w.toLowerCase()] ||
      (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    )
    .join(" ");
}

const COUNTER_TILES: { key: keyof PopulationCounters; label: string; format: (v: number) => string }[] = [
  { key: "total_graded",  label: "Total graded",  format: (v) => v.toLocaleString() },
  { key: "unique_cards",  label: "Unique cards",  format: (v) => v.toLocaleString() },
  { key: "unique_sets",   label: "Unique sets",   format: (v) => v.toLocaleString() },
  { key: "claimed_count", label: "Claimed",       format: (v) => v.toLocaleString() },
  { key: "avg_grade",     label: "Avg grade",     format: (v) => v.toFixed(1) },
];

const REGISTRY_POINTS = [
  "Every graded cert is public and permanent",
  "Ownership claims are optional but encouraged",
  "Transfers between verified owners are tracked",
  "Black Label status is shown inline on the cert",
];

// ── Page ─────────────────────────────────────────────────────────────────

export default function RegistryV2() {
  const { data, isLoading, isError } = useQuery<PopulationResponse>({
    queryKey: ["/api/population"],
    queryFn: async () => {
      const res = await fetch("/api/population");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (Array.isArray(json)) {
        return {
          counters: { total_graded: 0, unique_cards: 0, unique_sets: 0, claimed_count: 0, avg_grade: 0 },
          recent: [],
          population: json,
        };
      }
      return json as PopulationResponse;
    },
    staleTime: 60_000,
  });

  const counters = data?.counters;
  const recent = data?.recent ?? [];

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ─────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 pt-12 md:pt-20 pb-14 md:pb-16 text-center">
          <p
            className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
            style={{ color: "var(--v2-gold)" }}
          >
            Est. Kent &middot; Registry
          </p>
          <h1
            className="font-display italic font-medium leading-[0.95] mb-6"
            style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
          >
            A public ledger of<br />every graded card.
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-6"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Every card that passes through MintVault is logged permanently in our public
            registry &mdash; with its grade, subgrades, scanned images, cert number, and
            (when claimed) ownership history. The registry is open to everyone.
          </p>
          <p
            className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            Public &middot; Permanent &middot; Searchable
          </p>
        </div>
      </section>

      {/* ── SECTION I: COUNTERS ─────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)", borderTop: "1px solid var(--v2-line)", borderBottom: "1px solid var(--v2-line)" }}>
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
          <SectionEyebrow numeral="I" label="At a glance" className="mb-8" />

          {isError ? (
            <p className="font-mono-v2 text-xs uppercase tracking-widest text-center py-8" style={{ color: "var(--v2-ink-mute)" }}>
              Registry data temporarily unavailable.
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {COUNTER_TILES.map((tile) => {
                const value = counters ? tile.format(counters[tile.key]) : null;
                return (
                  <div
                    key={tile.key as string}
                    className="p-6 rounded-xl text-center"
                    style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-line)" }}
                  >
                    <p
                      className="font-mono-v2 text-[10px] uppercase tracking-widest"
                      style={{ color: "var(--v2-ink-mute)" }}
                    >
                      {tile.label}
                    </p>
                    {isLoading || !value ? (
                      <div
                        className="mt-3 h-10 rounded animate-pulse"
                        style={{ backgroundColor: "var(--v2-line-soft)" }}
                      />
                    ) : (
                      <p
                        className="font-numeral font-semibold leading-none mt-3"
                        style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
                      >
                        {value}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── SECTION II: RECENT GALLERY ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <SectionEyebrow numeral="II" label="Recently graded" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
          >
            The last twelve.
          </h2>
          <p className="font-body leading-relaxed mt-2 mb-10 max-w-xl" style={{ color: "var(--v2-ink-soft)" }}>
            Newest graded cards, updated live. Tap any tile for the full cert report.
          </p>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl overflow-hidden"
                  style={{
                    backgroundColor: "var(--v2-paper-raised)",
                    border: "1px solid var(--v2-line)",
                  }}
                >
                  <div
                    className="aspect-[3/4] animate-pulse"
                    style={{ backgroundColor: "var(--v2-line-soft)" }}
                  />
                  <div className="p-4 space-y-2">
                    <div
                      className="h-3 rounded animate-pulse"
                      style={{ backgroundColor: "var(--v2-line-soft)" }}
                    />
                    <div
                      className="h-2 rounded w-2/3 animate-pulse"
                      style={{ backgroundColor: "var(--v2-line-soft)" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p
              className="font-mono-v2 text-xs uppercase tracking-widest text-center py-12"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              No cards in the registry yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
              {recent.map((cert) => (
                <Link
                  key={cert.certificate_number}
                  href={`/cert/${cert.certificate_number}`}
                  className="block rounded-xl overflow-hidden group transition-all hover:scale-[1.015]"
                  style={{
                    backgroundColor: "var(--v2-paper-raised)",
                    border: "1px solid var(--v2-line)",
                  }}
                >
                  <div
                    className="relative overflow-hidden"
                    style={{
                      backgroundColor: "var(--v2-line-soft)",
                      aspectRatio: "3 / 4",
                    }}
                  >
                    {cert.card_image_front_url ? (
                      <img
                        src={cert.card_image_front_url}
                        alt={cert.card_name || "Graded card"}
                        className="w-full h-full object-contain transition-transform group-hover:scale-[1.04]"
                        loading="lazy"
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center">
                        <span
                          className="font-mono-v2 text-[10px] uppercase tracking-widest"
                          style={{ color: "var(--v2-ink-mute)" }}
                        >
                          No image
                        </span>
                      </div>
                    )}
                    {cert.grade !== null && (
                      <div
                        className="absolute top-3 right-3 px-2.5 py-1 rounded-full font-mono-v2 text-[10px] font-bold uppercase tracking-widest"
                        style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                      >
                        {cert.label_type === "Black Label" ? "BL" : cert.grade}
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <p
                      className="font-body text-sm font-semibold group-hover:underline"
                      style={{ color: "var(--v2-ink)" }}
                    >
                      {titleCase(cert.card_name)}
                    </p>
                    {cert.card_set && (
                      <p
                        className="font-body text-xs mt-0.5 line-clamp-1"
                        style={{ color: "var(--v2-ink-soft)" }}
                      >
                        {titleCase(cert.card_set)}
                      </p>
                    )}
                    <p
                      className="font-mono-v2 text-[10px] uppercase tracking-widest mt-2"
                      style={{ color: "var(--v2-ink-mute)" }}
                    >
                      {cert.certificate_number}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── SECTION III: HOW THE REGISTRY WORKS ─────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-16 md:py-24">
          <SectionEyebrow numeral="III" label="How it works" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight mb-10"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
          >
            Public by design.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
            <p className="font-body text-base md:text-lg leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
              Every cert is published the moment it passes final QC. Grade, subgrades,
              scanned images, certificate number, and submission date are all visible on
              the public cert page &mdash; with or without an account.
            </p>
            <p className="font-body text-base md:text-lg leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
              When a customer claims their card, the claim is recorded in the ownership
              history. Future transfers between owners are recorded too, creating a chain
              of provenance that survives the card itself.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {REGISTRY_POINTS.map((point) => (
              <div key={point} className="flex items-start gap-3">
                <CheckCircle size={16} style={{ color: "var(--v2-gold)" }} className="mt-1 shrink-0" />
                <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink)" }}>
                  {point}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION IV: SEARCH LINK ─────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)", borderTop: "1px solid var(--v2-line)" }}>
        <div className="mx-auto max-w-4xl px-6 py-16 md:py-20 text-center">
          <SectionEyebrow numeral="IV" label="Browse" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight mb-4"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
          >
            Looking for a specific card?
          </h2>
          <p className="font-body text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-8" style={{ color: "var(--v2-ink-soft)" }}>
            The full registry is searchable by card, set, or game. Filter by grade, see
            population counts per card, or follow a cert by number.
          </p>
          <Link
            href="/population"
            className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
            style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
          >
            Browse the full registry <ArrowRight size={14} />
          </Link>
          <p className="font-mono-v2 text-[10px] uppercase tracking-widest mt-5" style={{ color: "var(--v2-ink-mute)" }}>
            Opens the v1 registry. The v2 search experience is on the roadmap.
          </p>
        </div>
      </section>

      {/* ── SECTION V: FINAL CTA ─────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-20 md:py-28 text-center">
          <SectionEyebrow numeral="V" label="Submit" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight mb-6"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#FFFFFF" }}
          >
            Add your card<br />to the registry.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            Every cert joins the same public ledger. Submit once, stays forever.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/submit"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Submit a card <ArrowRight size={14} />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              See pricing <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
