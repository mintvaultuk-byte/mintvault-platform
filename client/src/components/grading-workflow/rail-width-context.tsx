import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { RAIL_WIDTH_EPSILON_PX, shouldAdoptRailWidth } from "@shared/rail-width";

/**
 * Carries the PREDICTED rail requirement from the card viewer (which owns the
 * card-independent inputs) to the rail (which owns the width).
 *
 * A context rather than props because the interactive card viewer is PORTALLED
 * into the rail: it is a DOM descendant of the aside but a React child of
 * GradingPanel, so there is no prop path between them that does not thread
 * through three components that have no interest in either value.
 *
 * Direction matters. The viewer publishes a NUMBER it computed from the source
 * image's natural aspect and the visible viewport; it never reads the rail's
 * width, and the rail never reports its width back. The data flows one way, so
 * no cycle exists to converge or oscillate.
 */
interface RailWidthContextValue {
  /** The adopted rail width in px, or null to keep the default responsive width. */
  railWidthPx: number | null;
  /**
   * Publish a freshly predicted requirement. `key` identifies the input set
   * (viewport + known sides); when it changes the next prediction always
   * settles, because a genuinely new input set may legitimately be narrower.
   */
  publishRailWidth: (key: string, required: number | null) => void;
}

const RailWidthContext = createContext<RailWidthContextValue | null>(null);

export function RailWidthProvider({ children }: { children: ReactNode }) {
  const [railWidthPx, setRailWidthPx] = useState<number | null>(null);
  const adoptedRef = useRef<{ key: string; width: number } | null>(null);

  const publishRailWidth = useCallback((key: string, required: number | null) => {
    if (required == null || !(required > 0)) return;
    const adopted = adoptedRef.current?.key === key ? adoptedRef.current.width : null;
    if (!shouldAdoptRailWidth(adopted, required, RAIL_WIDTH_EPSILON_PX)) return;
    adoptedRef.current = { key, width: required };
    setRailWidthPx(required);
  }, []);

  const value = useMemo(() => ({ railWidthPx, publishRailWidth }), [railWidthPx, publishRailWidth]);
  return <RailWidthContext.Provider value={value}>{children}</RailWidthContext.Provider>;
}

/** The rail side. Returns null outside a provider so the default width applies. */
export function useRailWidth(): number | null {
  return useContext(RailWidthContext)?.railWidthPx ?? null;
}

/** The viewer side. A no-op outside a provider, so ImageViewer stays usable standalone. */
export function usePublishRailWidth(): (key: string, required: number | null) => void {
  const ctx = useContext(RailWidthContext);
  return ctx?.publishRailWidth ?? noop;
}

const noop = () => {};
