import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerCertificates, partnerErrorMessage } from "@/lib/partner-api";

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/** A Partner-safe projection of cards that have entered the MintVault
 * certificate workflow. It intentionally shows no customer or internal notes. */
export default function PartnerCertificatesPage() {
  const query = useQuery({
    queryKey: ["/api/partner/certificates"],
    queryFn: partnerCertificates.list,
  });

  if (query.isLoading) return <PartnerLoadingState label="Loading certificate history…" />;
  if (query.error) return <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />;
  const certificates = query.data?.certificates ?? [];

  return (
    <div className="space-y-5" data-testid="partner-certificate-history">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Certificate history</p>
        <h1 className="text-2xl font-semibold">Certificates / Completed</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track the authoritative QA, capture and print state of cards from your selected location.
        </p>
      </div>
      {certificates.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No Partner certificates have been created for this location yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {certificates.map((cert) => (
            <Card key={cert.certificateNumber} data-testid={`partner-certificate-${cert.certificateNumber}`}>
              <CardHeader className="space-y-1 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{cert.cardName || "Unidentified card"}</CardTitle>
                  <Badge>{statusLabel(cert.gradingStatus)}</Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{cert.certificateNumber}</p>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <p><span className="text-muted-foreground">Card: </span>{[cert.setName, cert.cardNumber && `#${cert.cardNumber}`, cert.year].filter(Boolean).join(" · ") || "—"}</p>
                <p><span className="text-muted-foreground">Grade: </span>{cert.grade ?? "Awaiting QA"}</p>
                <p><span className="text-muted-foreground">QA: </span>{cert.qaClearedAt ? "Cleared" : "Held for review"}</p>
                <p><span className="text-muted-foreground">Print: </span>{cert.printState ? statusLabel(cert.printState) : "Awaiting approval"}</p>
                <p><span className="text-muted-foreground">Location: </span>{cert.locationName ?? "—"}</p>
                <p><span className="text-muted-foreground">Capture: </span>{cert.evidenceComplete ? "Front + back saved" : "Incomplete"}</p>
                <p><span className="text-muted-foreground">Station: </span>{cert.stations.join(", ") || "—"}</p>
                <p><span className="text-muted-foreground">Printed: </span>{cert.printedAt ? new Date(cert.printedAt).toLocaleString() : "Not printed"}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
