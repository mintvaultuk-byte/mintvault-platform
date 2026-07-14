export function storedImageReloadSrc(src: string, reloadNonce: number, paramName = "vq_img_reload"): string {
  if (!src || reloadNonce <= 0) return src;
  try {
    const url = new URL(src, "http://mintvault.local");
    url.searchParams.set(paramName, String(reloadNonce));
    return url.origin === "http://mintvault.local" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    const join = src.includes("?") ? "&" : "?";
    return `${src}${join}${encodeURIComponent(paramName)}=${encodeURIComponent(String(reloadNonce))}`;
  }
}

