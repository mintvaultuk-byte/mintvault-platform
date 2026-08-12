import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerCertificates, partnerErrorMessage } from "@/lib/partner-api";

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/** A Partner-safe projection of cards that have entered the MintVault
 * certificate workflow. It intentionally shows no customer or internal notes. */
export default function PartnerCertificatesPage() {
  const [selectedCertificateNumber, setSelectedCertificateNumber] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["/api/partner/certificates"],
    queryFn: partnerCertificates.list,
  });
  const detailQuery = useQuery({
    queryKey: ["/api/partner/certificates", selectedCertificateNumber],
    queryFn: () => partnerCertificates.detail(selectedCertificateNumber!),
    enabled: selectedCertificateNumber != null,
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
      {selectedCertificateNumber && (
        <Card data-testid="partner-certificate-detail">
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <p className="text-xs font-semibold uppercase text-primary">Partner card detail</p>
              <CardTitle className="mt-1 text-lg">{selectedCertificateNumber}</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelectedCertificateNumber(null)}>Close</Button>
          </CardHeader>
          <CardContent>
            {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading the authoritative card record…</p>}
            {detailQuery.error && (
              <PartnerErrorState message={partnerErrorMessage(detailQuery.error)} onRetry={() => detailQuery.refetch()} />
            )}
            {detailQuery.data?.certificate && (() => {
              const cert = detailQuery.data.certificate;
              const subgrades = [
                ["Centering", cert.gradeCentering],
                ["Corners", cert.gradeCorners],
                ["Edges", cert.gradeEdges],
                ["Surface", cert.gradeSurface],
              ];
              return (
                <div className="space-y-5 text-sm">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <p><span className="text-muted-foreground">Card: </span>{cert.cardName ?? "—"}</p>
                    <p><span className="text-muted-foreground">Overall: </span>{cert.grade ?? "Awaiting QA"}</p>
                    <p><span className="text-muted-foreground">QA: </span>{cert.qaClearedAt ? "Cleared" : "Held for review"}</p>
                    <p><span className="text-muted-foreground">Print: </span>{cert.printState ? statusLabel(cert.printState) : "Awaiting approval"}</p>
                    <p><span className="text-muted-foreground">Operator: </span>{cert.operatorName ?? "—"}</p>
                    <p><span className="text-muted-foreground">Station: </span>{cert.stations.join(", ") || "—"}</p>
                    <p><span className="text-muted-foreground">Corrections: </span>{cert.redoCount}</p>
                    <p><span className="text-muted-foreground">Capture: </span>{cert.evidenceComplete ? "Front + back saved" : "Incomplete"}</p>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Server-authoritative subgrades</p>
                    <div className="grid gap-2 sm:grid-cols-4">
                      {subgrades.map(([label, value]) => <p key={label}><span className="text-muted-foreground">{label}: </span>{value ?? "—"}</p>)}
                    </div>
                  </div>
                  {cert.rejectionReason && <p><span className="text-muted-foreground">Correction reason: </span>{cert.rejectionReason}</p>}
                  <div className="flex flex-wrap gap-2">
                    {cert.frontImageUrl && <Button variant="outline" size="sm" asChild><a href={cert.frontImageUrl} target="_blank" rel="noreferrer">Open FRONT master</a></Button>}
                    {cert.backImageUrl && <Button variant="outline" size="sm" asChild><a href={cert.backImageUrl} target="_blank" rel="noreferrer">Open BACK master</a></Button>}
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}
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
                <div><Button size="sm" variant="outline" onClick={() => setSelectedCertificateNumber(cert.certificateNumber)}>Open details</Button></div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
