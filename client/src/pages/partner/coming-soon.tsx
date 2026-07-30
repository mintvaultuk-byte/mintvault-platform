/**
 * Partner Portal — honest "not yet built" placeholder for shell-linked pages that belong to
 * deferred increments (Users/Locations management = Increment D; Billing = Increment H). Per
 * INTEGRATION-ORDER.md this pass ships only Increments A+B; these stubs exist so the navigation
 * is never a dead link, and say plainly what is and isn't available yet — no fabricated data.
 */
import { Card, CardContent } from "@/components/ui/card";

export function PartnerComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold" data-testid="text-coming-soon-title">
        {title}
      </h1>
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <p className="font-medium" data-testid="text-coming-soon-body">
            Not available yet.
          </p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}
