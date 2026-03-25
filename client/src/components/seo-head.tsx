import { useEffect } from "react";

export const SITE_NAME = "MintVault UK";
export const SITE_URL = "https://mintvaultuk.com";
export const DEFAULT_OG_IMAGE = `${SITE_URL}/images/collector-lifestyle.webp`;

interface SeoHeadProps {
  title: string;
  description: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  noindex?: boolean;
  schema?: Record<string, unknown> | Record<string, unknown>[];
}

export default function SeoHead({
  title,
  description,
  canonical,
  ogTitle,
  ogDescription,
  ogImage,
  ogType = "website",
  noindex = false,
  schema,
}: SeoHeadProps) {
  useEffect(() => {
    document.title = title;

    const setMeta = (name: string, content: string, attr = "name") => {
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    const removeMeta = (name: string, attr = "name") => {
      const el = document.querySelector(`meta[${attr}="${name}"]`);
      if (el) el.remove();
    };

    const setLink = (rel: string, href: string) => {
      let el = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
      if (!el) {
        el = document.createElement("link");
        el.setAttribute("rel", rel);
        document.head.appendChild(el);
      }
      el.setAttribute("href", href);
    };

    const resolvedTitle = ogTitle || title;
    const resolvedDesc = ogDescription || description;
    const resolvedImage = ogImage || DEFAULT_OG_IMAGE;
    const resolvedCanonical = canonical || (SITE_URL + window.location.pathname);

    setMeta("description", description);

    setMeta("og:site_name", SITE_NAME, "property");
    setMeta("og:type", ogType, "property");
    setMeta("og:url", resolvedCanonical, "property");
    setMeta("og:title", resolvedTitle, "property");
    setMeta("og:description", resolvedDesc, "property");
    setMeta("og:image", resolvedImage, "property");
    setMeta("og:image:width", "1200", "property");
    setMeta("og:image:height", "630", "property");
    setMeta("og:image:alt", resolvedTitle, "property");
    setMeta("og:locale", "en_GB", "property");

    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:site", "@mintvaultuk");
    setMeta("twitter:title", resolvedTitle);
    setMeta("twitter:description", resolvedDesc);
    setMeta("twitter:image", resolvedImage);
    setMeta("twitter:image:alt", resolvedTitle);

    setLink("canonical", resolvedCanonical);

    if (noindex) {
      setMeta("robots", "noindex, nofollow");
    } else {
      removeMeta("robots");
    }

    const schemaId = "seo-schema-ld";
    const existing = document.getElementById(schemaId);
    if (existing) existing.remove();

    if (schema) {
      const script = document.createElement("script");
      script.id = schemaId;
      script.type = "application/ld+json";
      script.textContent = JSON.stringify(Array.isArray(schema) ? schema : schema);
      document.head.appendChild(script);
    }

    return () => {
      const el = document.getElementById(schemaId);
      if (el) el.remove();
    };
  }, [title, description, canonical, ogTitle, ogDescription, ogImage, ogType, noindex, schema]);

  return null;
}
