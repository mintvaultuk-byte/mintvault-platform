import { useEffect, useMemo, useState, type CSSProperties, type MouseEventHandler, type SyntheticEvent } from "react";
import { RotateCcw } from "lucide-react";
import { storedImageReloadSrc } from "./vq-stored-image-utils";

type StoredImageKind = "candidate" | "reference" | "revision" | "artwork" | "image";

export interface VqStoredImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  idLabel?: string | number | null;
  kind?: StoredImageKind;
  onClick?: MouseEventHandler<HTMLImageElement>;
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError?: (event: SyntheticEvent<HTMLImageElement>) => void;
}

export function VqStoredImage({
  src,
  alt,
  className = "",
  style,
  idLabel,
  kind = "image",
  onClick,
  onLoad,
  onError,
}: VqStoredImageProps) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setState("loading");
    setReloadNonce(0);
  }, [src]);

  const displaySrc = useMemo(() => storedImageReloadSrc(src, reloadNonce), [src, reloadNonce]);
  const idText = idLabel == null || idLabel === "" ? null : `${kind} ${idLabel}`;

  if (state === "failed") {
    return (
      <div
        className={`flex flex-col items-center justify-center border border-slate-700 bg-slate-800/80 p-2 text-center ${className}`}
        style={style}
        role="img"
        aria-label={`${alt}. Image failed to load${idText ? ` for ${idText}` : ""}.`}
      >
        <div className="text-[11px] font-semibold text-slate-200">Image failed to load</div>
        {idText && <div className="mt-0.5 max-w-full truncate text-[10px] text-slate-400">{idText}</div>}
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1 rounded border border-slate-500 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-100 hover:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
          onClick={(event) => {
            event.stopPropagation();
            setState("loading");
            setReloadNonce((n) => n + 1);
          }}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Reload stored image
        </button>
      </div>
    );
  }

  return (
    <>
      {state === "loading" && <span className="sr-only">Loading stored image{idText ? ` for ${idText}` : ""}</span>}
      <img
        src={displaySrc}
        alt={alt}
        className={className}
        style={style}
        onClick={onClick}
        onLoad={(event) => {
          setState("loaded");
          onLoad?.(event);
        }}
        onError={(event) => {
          setState("failed");
          onError?.(event);
        }}
      />
    </>
  );
}
