/**
 * The single renderer for Partner operational readiness, used by BOTH the Super Admin partner
 * workspace and the Partner Portal dashboard.
 *
 * There is deliberately no logic here beyond choosing a colour and filtering actions by audience.
 * Every status, code, sentence and destination arrives already decided from the server
 * (`operational` on the onboarding-readiness payload). That is the whole point of P5: the two
 * audiences previously ran different readiness code and told different stories about the same shop,
 * so the only safe way to render it is to render it — not to recompute it.
 *
 * The audience filter is not cosmetic. A Partner must never be shown a control for something only
 * MintVault can do (approving a station), and an operator must not be pointed at the Partner's own
 * billing page. Actions carry their audience from the server and are filtered here.
 */
import type {
  PartnerOperationalReadiness,
  ReadinessAudience,
  ReadinessDimension,
  ReadinessStatus,
} from "@shared/partner-readiness";

const STATUS_STYLE: Record<ReadinessStatus, { dot: string; label: string }> = {
  PASS: { dot: "#3fb950", label: "Ready" },
  BLOCKED: { dot: "#f85149", label: "Blocked" },
  PENDING: { dot: "#d29922", label: "In progress" },
  // Amber, not green and not red: we do not know, and saying either would be a claim we cannot make.
  UNKNOWN: { dot: "#8b949e", label: "Unknown" },
};

const DIMENSION_LABEL: Record<string, string> = {
  organisation: "Account",
  owner: "Owner login",
  location: "Location",
  station: "Scanner station",
  scanner: "Scanner health",
  credits: "Grading Credits",
};

function DimensionRow({
  name,
  dimension,
  audience,
}: {
  name: string;
  dimension: ReadinessDimension;
  audience: ReadinessAudience;
}) {
  const style = STATUS_STYLE[dimension.status];
  const actions = dimension.actions.filter((a) => a.audience === audience || a.audience === "BOTH");
  return (
    <li
      data-testid={`readiness-dimension-${name}`}
      data-status={dimension.status}
      style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0" }}
    >
      {/* Status is conveyed by the text label as well as the dot — never by colour alone. */}
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 999, background: style.dot, marginTop: 6, flexShrink: 0 }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{DIMENSION_LABEL[name] ?? name}</span>
          <span style={{ opacity: 0.7 }}> — {style.label}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>{dimension.message}</div>
        {actions.length > 0 && (
          <div style={{ marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {actions.map((a) =>
              a.href ? (
                <a
                  key={a.label}
                  href={a.href}
                  data-testid={`readiness-action-${name}`}
                  style={{ fontSize: 12, textDecoration: "underline" }}
                >
                  {a.label}
                </a>
              ) : (
                /*
                 * No destination, so no control. Station enrolment happens in the Scanner app and
                 * approval is MintVault's to give, so these render as guidance. A button that
                 * cannot do anything is worse than a sentence that explains who acts next.
                 */
                <span key={a.label} data-testid={`readiness-hint-${name}`} style={{ fontSize: 12, opacity: 0.7 }}>
                  {a.label}
                </span>
              )
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function ReadinessPanel({
  readiness,
  audience,
}: {
  readiness: PartnerOperationalReadiness | undefined;
  audience: ReadinessAudience;
}) {
  if (!readiness) {
    // Absent data is reported as absent. Rendering nothing here would read as "no problems".
    return (
      <div data-testid="readiness-panel" data-ready="unknown" style={{ marginTop: 12, fontSize: 13, opacity: 0.75 }}>
        Readiness is unavailable right now.
      </div>
    );
  }
  const { overall, dimensions } = readiness;
  return (
    <div data-testid="readiness-panel" data-ready={String(overall.ready)} data-code={overall.code} style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Can this shop grade a card?</div>
      <div
        data-testid="readiness-overall"
        style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: overall.ready ? STATUS_STYLE.PASS.dot : STATUS_STYLE.BLOCKED.dot,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13 }}>
          <strong>{overall.ready ? "Yes" : "Not yet"}</strong> — {overall.message}
        </span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="readiness-dimensions">
        {(Object.keys(dimensions) as Array<keyof typeof dimensions>).map((key) => (
          <DimensionRow key={key} name={String(key)} dimension={dimensions[key]} audience={audience} />
        ))}
      </ul>
    </div>
  );
}
