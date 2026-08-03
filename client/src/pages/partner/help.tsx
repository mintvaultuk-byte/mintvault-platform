/**
 * Partner Portal — Help. Static guidance only (no backend dependency), so this is real content
 * rather than a deferred-increment stub.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const FAQS = [
  {
    q: "How do I create a submission?",
    a: "Use the New Submission button. You'll pick a customer, choose a service, list the cards, review, then submit to MintVault.",
  },
  {
    q: "Can I edit a submission after I've sent it?",
    a: "No — once a submission is sent to MintVault it's locked. Draft submissions can be edited freely before sending.",
  },
  {
    q: "What does 'intake observation' mean?",
    a: "It's a note you make when logging a card (e.g. a visible crease). It is not a MintVault grade — only MintVault's grading process determines a grade.",
  },
  {
    q: "Where can I see pricing?",
    a: "Estimated pricing is shown on the Service step. The final price is always confirmed by MintVault.",
  },
  {
    q: "I can't find something I need.",
    a: "Contact MintVault support with your shop name, submission reference and a short description. Never send your password or verification code.",
  },
];

export default function PartnerHelpPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" data-testid="text-help-title">
        Help
      </h1>
      <div className="space-y-3" data-testid="list-help-faqs">
        {FAQS.map((item) => (
          <Card key={item.q}>
            <CardHeader>
              <CardTitle className="text-base">{item.q}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{item.a}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
