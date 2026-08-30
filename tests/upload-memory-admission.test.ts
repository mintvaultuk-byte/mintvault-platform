import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MIB,
  createUploadMemoryBudget,
  requestBodyMemoryAdmission,
  uploadMemoryBudget,
} from "../server/lib/upload-memory-admission";

function responseDouble() {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    status: (code: number) => typeof response;
    json: (body: unknown) => typeof response;
    setHeader: (name: string, value: string) => void;
  };
  response.statusCode = 200;
  response.body = null;
  response.headers = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = String(value);
  };
  return response;
}

describe("process-wide weighted body memory admission", () => {
  it("prevents individually-safe route classes from exceeding one shared budget", () => {
    const budget = createUploadMemoryBudget(700 * MIB);
    const scanner = budget.reserve("scanner", 512 * MIB);
    const grading = budget.reserve("grading", 384 * MIB);
    const first = responseDouble();
    scanner({} as never, first as never, vi.fn());

    const blocked = responseDouble();
    const blockedNext = vi.fn();
    grading({} as never, blocked as never, blockedNext);
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers["retry-after"]).toBe("5");
    expect(budget.stats()).toEqual({
      activeBytes: 512 * MIB,
      activeReservations: 1,
      maxBytes: 700 * MIB,
      rejected: 1,
    });

    first.emit("finish");
    const admitted = responseDouble();
    const admittedNext = vi.fn();
    grading({} as never, admitted as never, admittedNext);
    expect(admittedNext).toHaveBeenCalledOnce();
    admitted.emit("finish");
    admitted.emit("close");
    expect(budget.stats().activeBytes).toBe(0);
    expect(budget.stats().activeReservations).toBe(0);
  });

  it("rejects declared oversize JSON before parsing and reserves chunked bodies", () => {
    const before = uploadMemoryBudget.stats();
    const oversize = responseDouble();
    const oversizeNext = vi.fn();
    requestBodyMemoryAdmission(
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(MIB + 1) },
      } as never,
      oversize as never,
      oversizeNext
    );
    expect(oversize.statusCode).toBe(413);
    expect(oversizeNext).not.toHaveBeenCalled();
    expect(uploadMemoryBudget.stats()).toEqual(before);

    const chunked = responseDouble();
    const chunkedNext = vi.fn();
    requestBodyMemoryAdmission(
      { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } } as never,
      chunked as never,
      chunkedNext
    );
    expect(chunkedNext).toHaveBeenCalledOnce();
    expect(uploadMemoryBudget.stats().activeBytes).toBe(before.activeBytes + 4 * MIB);
    chunked.emit("finish");
    expect(uploadMemoryBudget.stats()).toEqual(before);
  });

  it("puts authority/quota and one shared admission ahead of every memoryStorage parser", () => {
    const files = [
      "server/routes.ts",
      "server/correction-mode.ts",
      "server/routes/staff.ts",
      "server/routes/pre-grade.ts",
      "server/routes/vault-quest-admin.ts",
      "server/partner/submission-routes.ts",
      "server/partner/supply-admin-routes.ts",
    ];
    const inventory: string[] = [];
    for (const filename of files) {
      const source = readFileSync(filename, "utf8");
      for (const match of source.matchAll(/\b\w*[Uu]pload\.(?:single|array|fields)\(/g)) {
        inventory.push(`${filename}:${match.index}:${match[0]}`);
        if (match[0] === "phoneUpload.single(") continue;
        const before = source.slice(Math.max(0, match.index! - 900), match.index);
        expect(before, `${filename} ${match[0]}`).toMatch(
          /(?:uploadMemoryAdmission\(|(?:publicImageProcessing|hotFolderUpload|scannerEvidence)Admission\.middleware)/
        );
        expect(before, `${filename} ${match[0]} authority`).toMatch(
          /(?:require[A-Z]\w+|\w+(?:Rate)?Limit|requireHotFolderUploadAuth)/
        );
      }
    }
    expect(inventory.length).toBeGreaterThan(20);

    const routes = readFileSync("server/routes.ts", "utf8");
    const phone = routes.slice(
      routes.indexOf('"/api/upload/:certId/:imageType"'),
      routes.indexOf("// ── Build 4: Hot folder")
    );
    expect(phone).toMatch(
      /requirePhoneUploadToken,[\s\S]+phoneUploadAdmission\.middleware,[\s\S]+phoneUploadWithLimits/
    );
  });

  it("places the weighted global parser gate before the lowered JSON and form parsers", () => {
    const index = readFileSync("server/index.ts", "utf8");
    const admission = index.indexOf("app.use(requestBodyMemoryAdmission)");
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(index.indexOf("express.json({")).toBeGreaterThan(admission);
    expect(index.indexOf('limit: "1mb"')).toBeGreaterThan(admission);
    expect(index.indexOf("express.urlencoded({ extended: false })")).toBeGreaterThan(admission);
    expect(index).not.toMatch(/ADMIN_PASSWORD env var|SESSION_SECRET env var/);

    const partner = readFileSync("server/partner/app.ts", "utf8");
    expect(partner.indexOf("app.use(requestBodyMemoryAdmission)")).toBeGreaterThanOrEqual(0);
    expect(partner.indexOf('express.json({ limit: "1mb" })')).toBeGreaterThan(
      partner.indexOf("app.use(requestBodyMemoryAdmission)")
    );
  });
});
