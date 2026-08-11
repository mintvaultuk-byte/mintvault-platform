import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createScannerEvidenceAdmission } from "../server/lib/scanner-evidence-admission";

function response() {
  const result = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    payload?: unknown;
    headers: Record<string, string>;
    setHeader: (key: string, value: string) => void;
    status: (code: number) => typeof result;
    json: (body: unknown) => typeof result;
  };
  result.headers = {};
  result.setHeader = (key, value) => {
    result.headers[key] = value;
  };
  result.status = (code) => {
    result.statusCode = code;
    return result;
  };
  result.json = (body) => {
    result.payload = body;
    return result;
  };
  return result;
}

describe("scanner TIFF admission", () => {
  it("rejects before multipart handling when the bounded receive capacity is full, then releases on response finish", () => {
    const admission = createScannerEvidenceAdmission(1);
    const first = response();
    let firstNext = false;
    admission.middleware({} as any, first as any, () => {
      firstNext = true;
    });
    expect(firstNext).toBe(true);
    expect(admission.stats()).toEqual({ active: 1, max: 1, rejected: 0 });

    const second = response();
    let secondNext = false;
    admission.middleware({} as any, second as any, () => {
      secondNext = true;
    });
    expect(secondNext).toBe(false);
    expect(second.statusCode).toBe(503);
    expect(second.headers["Retry-After"]).toBe("5");
    expect(second.payload).toEqual(expect.objectContaining({ code: "scanner_evidence_backpressure" }));
    expect(admission.stats()).toEqual({ active: 1, max: 1, rejected: 1 });

    first.emit("finish");
    first.emit("close");
    expect(admission.stats()).toEqual({ active: 0, max: 1, rejected: 1 });
  });
});
