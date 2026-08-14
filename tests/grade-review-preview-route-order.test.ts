import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
});

describe("Pending Review label preview route registration", () => {
  it("reaches the explicit revision-bound preview route before the generic :id/:action proxy", async () => {
    // Route modules create the database client on import. This test never
    // reaches storage (the deliberately invalid id is rejected first), so use
    // a syntactically valid disposable URL rather than any live database.
    process.env.MINTVAULT_DATABASE_URL ??= "postgresql://mintvault_test:mintvault_test@127.0.0.1:5432/mintvault_test";
    const { registerReviewPreviewRoutes } = await import("../server/routes/review-preview");
    const app = express();
    app.use(express.json());
    // This is a server-only test harness flag. It exercises the real route
    // declarations without an auth database lookup; production clients cannot
    // set it because the flag is request-local and only the grader proxy does.
    app.use((req, _res, next) => {
      Object.assign(req, { __graderProxy: true });
      next();
    });
    registerReviewPreviewRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/grade-review/certificates/label/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certificateId: "not-a-certificate" }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Valid certificateId required" });
  }, 20_000);
});
