import { pool } from "./db";
import { finalizeCertificateImageObjectWrite } from "./lib/certificate-image-persistence";
import {
  abandonCertificateCreateImagesObjectWrite,
  finalizeCertificateCreateImagesObjectWrite,
} from "./lib/certificate-create-persistence";
import { createPoolTransactionRunner } from "./lib/object-write-coordinator";
import { registerObjectWriteFinalizer } from "./lib/object-write-finalizer-registry";
import { finalizeSubmissionReceiptObjectWrite } from "./lib/submission-receipt-persistence";
import { finalizeScannerEvidenceCaptureObjectWrite } from "./lib/scanner-evidence-persistence";
import {
  abandonPrintArtifactObjectWrite,
  finalizePrintArtifactObjectWrite,
} from "./lib/print-artifact-persistence";
import { withTenant } from "./partner/db";
import { finalizePartnerCardImageObjectWrite } from "./partner/submission-service";

let installed = false;

/** Register only finalizers whose production writer has been migrated. */
export function registerBuiltInObjectWriteFinalizers(): void {
  if (installed) return;
  installed = true;
  const mainRunner = createPoolTransactionRunner(pool);
  for (const operationKind of ["CERTIFICATE_IMAGE_REVISION", "CERTIFICATE_DERIVATIVE_SET"] as const) {
    registerObjectWriteFinalizer(operationKind, {
      transactionRunner: () => mainRunner,
      finalize: finalizeCertificateImageObjectWrite,
    });
  }
  registerObjectWriteFinalizer("CERTIFICATE_CREATE_IMAGES", {
    transactionRunner: () => mainRunner,
    finalize: finalizeCertificateCreateImagesObjectWrite,
    abandon: abandonCertificateCreateImagesObjectWrite,
  });
  registerObjectWriteFinalizer("SCANNER_EVIDENCE_CAPTURE", {
    transactionRunner: () => mainRunner,
    finalize: finalizeScannerEvidenceCaptureObjectWrite,
  });
  registerObjectWriteFinalizer("PARTNER_CARD_IMAGE", {
    transactionRunner: (context) => {
      if (!context.tenantId) throw new Error("PARTNER_CARD_IMAGE finalization requires a tenant");
      return {
        transaction: (operation) => withTenant({ tenantId: context.tenantId! }, operation),
      };
    },
    finalize: finalizePartnerCardImageObjectWrite,
  });
  registerObjectWriteFinalizer("SUBMISSION_RECEIPT_PHOTOS", {
    transactionRunner: () => mainRunner,
    finalize: finalizeSubmissionReceiptObjectWrite,
  });
  registerObjectWriteFinalizer("PRINT_ARTIFACT", {
    transactionRunner: () => mainRunner,
    finalize: finalizePrintArtifactObjectWrite,
    abandon: abandonPrintArtifactObjectWrite,
  });
}

export function __resetBuiltInObjectWriteFinalizersForTests(): void {
  installed = false;
}
