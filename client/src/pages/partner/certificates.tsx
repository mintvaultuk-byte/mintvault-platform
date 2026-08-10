import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerCertificates, partnerErrorMessage, type PartnerCertificateSummary } from "@/lib/partner-api";

const displayState = (value: string | null) => (value ? value.replace(/_/g, " ") : "Not available");

function CompletionCard({ certificate, canOperate }: { certificate: PartnerCertificateSummary; canOperate: boolean }) {
  const cardName = [certificate.cardGame, certificate.cardName, certificate.setName, certificate.cardNumber]
    .filter(Boolean)
    .join(" · ");
  const approved = certificate.approvalState === "APPROVED";

  return (
    <Card data-testid={`partner-certificate-${certificate.certificateNumber}`}>
      <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))] lg:items-center">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold">{certificate.certificateNumber}</p>
          <p className="mt-1 truncate text-sm text-muted-foreground">{cardName || "Card details pending"}</p>
          {certificate.originLocationName && (
            <p className="mt-1 text-xs text-muted-foreground">Origin: {certificate.originLocationName}</p>
          )}
        </div>
        <SummaryField label="Grade" value={certificate.grade ?? "Pending"} />
        <SummaryField label="Approval" value={displayState(certificate.approvalState)} />
        <SummaryField label="Certificate" value={displayState(certificate.status)} />
        <SummaryField label="Print" value={displayState(certificate.printState)} />
        <div className="flex items-center justify-between gap-3 lg:block">
          <SummaryField label="NFC" value={displayState(certificate.nfcState)} />
          {approved ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="shrink-0 lg:mt-2"
              data-testid={`open-certificate-${certificate.certificateNumber}`}
            >
              <Link href={`/cert/${encodeURIComponent(certificate.certificateNumber)}`}>Open certificate</Link>
            </Button>
          ) : (
            <Badge variant="secondary" className="shrink-0 lg:mt-2">
              Awaiting approval
            </Badge>
          )}
        </div>
        {approved && canOperate && <CertificateOperations certificate={certificate} />}
      </CardContent>
    </Card>
  );
}

function CertificateOperations({ certificate }: { certificate: PartnerCertificateSummary }) {
  const qc = useQueryClient();
  const [labelPreviewUrl, setLabelPreviewUrl] = useState<string | null>(null);
  const [uid, setUid] = useState("");
  const [chipType, setChipType] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/partner/certificates"] });
  const prepare = useMutation({
    mutationFn: () => partnerCertificates.prepareLabel(certificate.certificateNumber),
    onSuccess: async (result) => {
      setLabelPreviewUrl(result.labelPreviewUrl);
      setNotice(
        result.certificateNumbers.length > 1
          ? "The preview includes every card in this Partner submission. Print the complete sheet, then confirm the physical print below."
          : "Open the label PDF, print it, then confirm the physical print below."
      );
      await refresh();
    },
  });
  const confirm = useMutation({
    mutationFn: () => partnerCertificates.confirmLabelPrinted(certificate.certificateNumber),
    onSuccess: async () => {
      setNotice("Physical label print confirmed. NFC can now be programmed.");
      await refresh();
    },
  });
  const writeNfc = useMutation({
    mutationFn: () =>
      partnerCertificates.writeNfc(certificate.certificateNumber, { uid, ...(chipType.trim() ? { chipType } : {}) }),
    onSuccess: async () => {
      setNotice("NFC UID recorded. Read the tag again and verify its UID before locking it.");
      setUid("");
      setChipType("");
      await refresh();
    },
  });
  const verifyNfc = useMutation({
    mutationFn: () => partnerCertificates.verifyNfc(certificate.certificateNumber, uid),
    onSuccess: async () => {
      setNotice("NFC tag verified. It can now be locked if your process requires it.");
      setUid("");
      await refresh();
    },
  });
  const lockNfc = useMutation({
    mutationFn: () => partnerCertificates.lockNfc(certificate.certificateNumber),
    onSuccess: async () => {
      setNotice("NFC tag locked. This Partner workflow cannot replace or clear a locked tag.");
      await refresh();
    },
  });
  const complete = useMutation({
    mutationFn: () => partnerCertificates.complete(certificate.certificateNumber),
    onSuccess: async (result) => {
      setNotice(
        result.certificateNumbers.length > 1
          ? "Every certificate in this Partner submission is now recorded as completed."
          : "Slab and seal completion recorded."
      );
      await refresh();
    },
  });
  const error = [prepare.error, confirm.error, writeNfc.error, verifyNfc.error, lockNfc.error, complete.error].find(
    Boolean
  );
  const pending =
    prepare.isPending ||
    confirm.isPending ||
    writeNfc.isPending ||
    verifyNfc.isPending ||
    lockNfc.isPending ||
    complete.isPending;
  const printPrepared = certificate.printState === "printing";
  const printConfirmed = ["printed", "reprinted", "completed"].includes(certificate.printState ?? "");
  const canComplete =
    ["printed", "reprinted"].includes(certificate.printState ?? "") && certificate.nfcState === "LOCKED";

  return (
    <div
      className="space-y-3 rounded-md border bg-muted/30 p-3 lg:col-span-6"
      data-testid={`partner-certificate-operations-${certificate.certificateNumber}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Label &amp; NFC operations</p>
          <p className="text-xs text-muted-foreground">
            MintVault confirms eligibility on every step. A preview never marks a label as printed.
          </p>
        </div>
        {labelPreviewUrl && (
          <Button asChild variant="outline" size="sm">
            <a href={labelPreviewUrl} target="_blank" rel="noreferrer">
              Open label PDF
            </a>
          </Button>
        )}
      </div>

      {!printConfirmed && (
        <div className="flex flex-wrap gap-2">
          {!printPrepared && (
            <Button size="sm" disabled={pending} onClick={() => prepare.mutate()}>
              Prepare label preview
            </Button>
          )}
          {printPrepared && (
            <Button size="sm" disabled={pending} onClick={() => confirm.mutate()}>
              Confirm label printed
            </Button>
          )}
        </div>
      )}

      {printConfirmed && certificate.nfcState === "NOT_WRITTEN" && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Input
            value={uid}
            onChange={(event) => setUid(event.target.value)}
            placeholder="NFC UID from writer"
            aria-label="NFC UID"
          />
          <Input
            value={chipType}
            onChange={(event) => setChipType(event.target.value)}
            placeholder="Chip type (optional)"
            aria-label="NFC chip type"
          />
          <Button size="sm" disabled={pending || !uid.trim()} onClick={() => writeNfc.mutate()}>
            Record NFC write
          </Button>
        </div>
      )}

      {printConfirmed && certificate.nfcState === "WRITTEN" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={uid}
            onChange={(event) => setUid(event.target.value)}
            placeholder="Read NFC UID again to verify"
            aria-label="Verified NFC UID"
            className="sm:max-w-sm"
          />
          <Button size="sm" disabled={pending || !uid.trim()} onClick={() => verifyNfc.mutate()}>
            Verify NFC tag
          </Button>
        </div>
      )}

      {printConfirmed && certificate.nfcState === "VERIFIED" && (
        <Button size="sm" disabled={pending} onClick={() => lockNfc.mutate()}>
          Lock NFC tag
        </Button>
      )}
      {certificate.nfcState === "LOCKED" && (
        <p className="text-xs text-muted-foreground">NFC is locked. Its state and audit trail are retained.</p>
      )}
      {canComplete && (
        <Button size="sm" disabled={pending} onClick={() => complete.mutate()}>
          Mark slab and seal completed
        </Button>
      )}
      {certificate.printState === "completed" && (
        <p className="text-xs text-muted-foreground">Fulfilment completion is recorded for this certificate.</p>
      )}
      {notice && (
        <p className="text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {partnerErrorMessage(error)}
        </p>
      )}
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
    </div>
  );
}

export default function PartnerCertificatesPage() {
  const { hasPermission } = usePartnerSession();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "approved" | "pending">("all");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/certificates"],
    queryFn: partnerCertificates.list,
  });
  const certificates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.certificates ?? []).filter((certificate) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "approved" ? certificate.approvalState === "APPROVED" : certificate.approvalState !== "APPROVED");
      const searchable = [
        certificate.certificateNumber,
        certificate.cardGame,
        certificate.cardName,
        certificate.setName,
        certificate.cardNumber,
        certificate.originLocationName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return matchesFilter && (!query || searchable.includes(query));
    });
  }, [data?.certificates, filter, search]);

  return (
    <div className="space-y-6" data-testid="partner-certificates-page">
      <div>
        <p className="text-xs font-semibold tracking-[0.18em] text-primary">SHOP OPERATIONS</p>
        <h1 className="mt-1 text-2xl font-bold">Certificates &amp; Completed</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Your shop’s certificate record. MintVault controls approval, printing and NFC eligibility; this page shows
          their current state.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search certificate, card or shop"
          aria-label="Search certificates"
          className="sm:max-w-md"
        />
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as "all" | "approved" | "pending")}
          aria-label="Filter certificate approval state"
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All certificate states</option>
          <option value="approved">Approved</option>
          <option value="pending">Awaiting approval</option>
        </select>
      </div>

      {isLoading && <PartnerLoadingState label="Loading certificates…" />}
      {error && <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />}
      {data && certificates.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {data.certificates.length === 0
              ? "No certificates are available for this shop yet. Approved cards will appear here automatically."
              : "No certificates match the current search or filter."}
          </CardContent>
        </Card>
      )}
      {certificates.length > 0 && (
        <div className="space-y-3">
          {certificates.map((certificate) => (
            <CompletionCard
              key={certificate.certificateNumber}
              certificate={certificate}
              canOperate={hasPermission("partner.cards.assess")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
