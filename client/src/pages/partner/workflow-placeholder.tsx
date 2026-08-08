import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

const WORKFLOW_COPY = {
  certificates: {
    eyebrow: "Approved work",
    title: "Certificates / Completed",
    body: "Approved cards, certificate numbers, print state, NFC state, reprint reasons, and completion history need the partner-to-certificate contract before this page can show live work.",
    actionHref: "/partner/submissions",
    actionLabel: "View submissions",
  },
  supplies: {
    eyebrow: "Shop stock",
    title: "Supplies",
    body: "Supply catalogue, stock rules, and checkout are not exposed through a partner API yet. This page is reserved for slab, sleeve, label, NFC, and packaging supply ordering.",
    actionHref: "/partner/help",
    actionLabel: "Contact MintVault",
  },
  orders: {
    eyebrow: "Operational orders",
    title: "Orders",
    body: "Supply orders and print batches need a server-backed order feed before the partner portal can safely show fulfilment state.",
    actionHref: "/partner/submissions",
    actionLabel: "View submissions",
  },
  "public-profile": {
    eyebrow: "Public network",
    title: "Public Profile",
    body: "Public shop address, rating, profile approval, and recently graded cards are waiting on the public partner network contract. Nothing is published from this screen until the backend makes it authoritative.",
    actionHref: "/partner/locations",
    actionLabel: "Review locations",
  },
} as const;

export type PartnerWorkflowPlaceholderKind = keyof typeof WORKFLOW_COPY;

export default function PartnerWorkflowPlaceholderPage({ kind }: { kind: PartnerWorkflowPlaceholderKind }) {
  const copy = WORKFLOW_COPY[kind];
  return (
    <div className="space-y-5" data-testid={`partner-${kind}-placeholder`}>
      <div>
        <p className="text-xs font-semibold uppercase text-primary">{copy.eyebrow}</p>
        <h1 className="text-2xl font-semibold">{copy.title}</h1>
      </div>
      <Card className="rounded-md">
        <CardContent className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          <Button asChild variant="outline">
            <Link href={copy.actionHref}>
              {copy.actionLabel}
              <ArrowRight className="h-4 w-4 ml-1.5" aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
