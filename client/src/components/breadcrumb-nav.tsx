import { Link } from "wouter";
import { ChevronRight } from "lucide-react";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export default function BreadcrumbNav({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-[#D4AF37]/50 mb-6" data-testid="nav-breadcrumb">
      <ol className="flex items-center gap-1 flex-wrap">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="text-[#D4AF37]/30" />}
            {item.href && i < items.length - 1 ? (
              <Link href={item.href} className="hover:text-[#D4AF37] transition-colors">
                {item.label}
              </Link>
            ) : (
              <span className={i === items.length - 1 ? "text-[#D4AF37]/70" : ""}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": items.map((item, i) => {
      const entry: Record<string, unknown> = {
        "@type": "ListItem",
        "position": i + 1,
        "name": item.label,
      };
      if (item.href) {
        entry["item"] = `https://mintvault.co.uk${item.href}`;
      }
      return entry;
    }),
  };
}
