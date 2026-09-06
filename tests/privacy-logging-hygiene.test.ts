import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const emailProvider = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: emailProvider.send };
  },
}));
vi.mock("../server/growth-runtime-telemetry", () => ({ recordApplicationOutcome: vi.fn() }));

import { sendClaimVerification } from "../server/email";

const CUSTOMER_EMAIL = "private.customer@example.test";
const SECRET_URL = "https://mintvaultuk.com/claim/verify?token=secret-token-value";

function renderedConsoleCalls(path: string): string {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "console"
    ) {
      calls.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls.join("\n");
}

function identifiersReferencedByConsoleCalls(path: string, sensitiveNames: ReadonlySet<string>): string[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const inspectArgument = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && sensitiveNames.has(node.text)) found.push(node.text);
    ts.forEachChild(node, inspectArgument);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "console"
    ) {
      node.arguments.forEach(inspectArgument);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function consoleOutput(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flatMap((args) => args)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
}

describe("production privacy logging hygiene", () => {
  beforeEach(() => {
    emailProvider.send.mockReset();
    process.env.RESEND_API_KEY = "unit-test-key";
    vi.restoreAllMocks();
  });

  it("delivers the original recipient and secure URL while keeping success logs recipient-free", async () => {
    emailProvider.send.mockResolvedValue({ data: { id: "provider-message-secret" }, error: null });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendClaimVerification({ email: CUSTOMER_EMAIL, certId: "MV-PRIVACY-1", verifyUrl: SECRET_URL });

    expect(emailProvider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: CUSTOMER_EMAIL,
        html: expect.stringContaining(SECRET_URL),
      }),
      {}
    );
    const output = consoleOutput([log, error]);
    expect(output).toContain("claim_verification_sent certId=MV-PRIVACY-1");
    expect(output).not.toContain(CUSTOMER_EMAIL);
    expect(output).not.toContain(SECRET_URL);
    expect(output).not.toContain("provider-message-secret");
  });

  it.each([
    ["returned provider error", () => ({ data: null, error: { message: `${CUSTOMER_EMAIL} ${SECRET_URL}` } })],
    ["thrown provider error", () => Promise.reject(new Error(`${CUSTOMER_EMAIL} ${SECRET_URL} api_key=secret`))],
  ])("maps a %s to a stable failure without logging provider-controlled text", async (_label, providerResult) => {
    emailProvider.send.mockImplementationOnce(providerResult);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendClaimVerification({ email: CUSTOMER_EMAIL, certId: "MV-PRIVACY-2", verifyUrl: SECRET_URL })
    ).rejects.toThrow("Resend API error: delivery failed");

    const output = consoleOutput([log, error]);
    expect(output).toContain("claim_verification_failed certId=MV-PRIVACY-2");
    expect(output).not.toContain(CUSTOMER_EMAIL);
    expect(output).not.toContain(SECRET_URL);
    expect(output).not.toContain("api_key");
  });

  it("keeps provider-disabled logs free of the unsent recipient", async () => {
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendClaimVerification({ email: CUSTOMER_EMAIL, certId: "MV-PRIVACY-3", verifyUrl: SECRET_URL });

    expect(emailProvider.send).not.toHaveBeenCalled();
    const output = consoleOutput([log, warn]);
    expect(output).toContain("claim_verification_skipped certId=MV-PRIVACY-3 reason=provider_disabled");
    expect(output).not.toContain(CUSTOMER_EMAIL);
    expect(output).not.toContain(SECRET_URL);
  });

  it("prevents raw email fields and provider messages from being reintroduced into either logging surface", () => {
    const emailLogs = renderedConsoleCalls("server/email.ts");
    const supplyLogs = renderedConsoleCalls("server/partner/supply-service.ts");

    expect(
      identifiersReferencedByConsoleCalls(
        "server/email.ts",
        new Set([
          "email",
          "fromEmail",
          "toEmail",
          "ownerEmail",
          "claimantEmail",
          "oldEmail",
          "newEmail",
          "err",
          "error",
        ])
      )
    ).toEqual([]);
    expect(
      identifiersReferencedByConsoleCalls("server/partner/supply-service.ts", new Set(["email", "err", "error"]))
    ).toEqual([]);

    expect(emailLogs).not.toMatch(
      /\$\{(?:data\.)?(?:email|fromEmail|toEmail|ownerEmail|claimantEmail|oldEmail|newEmail)\}/
    );
    expect(emailLogs).not.toMatch(/\b(?:err|error)\.message\b|providerMessageId|result\.error\.message/);
    expect(supplyLogs).not.toMatch(/actor\.email|\b(?:err|error)\.message\b/);
  });
});
