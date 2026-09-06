import { EventEmitter } from "node:events";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotFolderUploadAdmission } from "../server/lib/hot-folder-upload-admission";
import { createHotFolderUploadAuth } from "../server/lib/hot-folder-upload-auth";
import { refuseRetiredScanIngest, RETIRED_SCAN_INGEST_RESPONSE } from "../server/lib/retired-scan-ingest";
import { parseHotFolderUploadSide } from "../server/lib/hot-folder-upload-side";

const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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

describe("hot-folder upload pre-body boundary", () => {
  it("refuses missing, malformed, and wrong credentials before calling the body stage", () => {
    const auth = createHotFolderUploadAuth({ MINTVAULT_ADMIN_TOKEN: "watcher-secret" }, (_req, _res, next) => next());
    for (const authorization of [undefined, "Basic abc", "Bearer wrong", "Bearer watcher-secret trailing"]) {
      const next = vi.fn();
      const response = responseDouble();
      auth({ session: {}, headers: authorization ? { authorization } : {} } as never, response as never, next);
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("preserves both existing authorities without exposing which one matched", () => {
    const adminAuthority = vi.fn((_req, _res, next) => next());
    const auth = createHotFolderUploadAuth({ MINTVAULT_ADMIN_TOKEN: "watcher-secret" }, adminAuthority);
    const adminNext = vi.fn();
    auth({ session: { isAdmin: true }, headers: {} } as never, responseDouble() as never, adminNext);
    expect(adminNext).toHaveBeenCalledOnce();
    expect(adminAuthority).toHaveBeenCalledOnce();

    const bearerNext = vi.fn();
    auth(
      { session: {}, headers: { authorization: "Bearer watcher-secret" } } as never,
      responseDouble() as never,
      bearerNext
    );
    expect(bearerNext).toHaveBeenCalledOnce();
  });

  it.each(["deleted admin", "credential-version mismatch", "absolute session expiry"])(
    "does not let a cached cookie reach body parsing after live authority rejects: %s",
    (_reason) => {
      const bodyStage = vi.fn();
      const liveAdminAuthority = vi.fn((_req, res) => res.status(401).json({ error: "Session expired" }));
      const auth = createHotFolderUploadAuth({ MINTVAULT_ADMIN_TOKEN: "watcher-secret" }, liveAdminAuthority);
      const response = responseDouble();

      auth({ session: { isAdmin: true }, headers: {} } as never, response as never, bodyStage);

      expect(liveAdminAuthority).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(401);
      expect(bodyStage).not.toHaveBeenCalled();
    }
  );

  it("admits only the configured number of in-memory bodies and releases on completion", () => {
    const admission = createHotFolderUploadAdmission(1);
    const firstResponse = responseDouble();
    const firstNext = vi.fn();
    admission.middleware({} as never, firstResponse as never, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    expect(admission.stats()).toEqual({ active: 1, max: 1, rejected: 0 });

    const rejectedResponse = responseDouble();
    const rejectedNext = vi.fn();
    admission.middleware({} as never, rejectedResponse as never, rejectedNext);
    expect(rejectedNext).not.toHaveBeenCalled();
    expect(rejectedResponse.statusCode).toBe(503);
    expect(rejectedResponse.headers["retry-after"]).toBe("5");
    expect(admission.stats()).toEqual({ active: 1, max: 1, rejected: 1 });

    firstResponse.emit("finish");
    const retryNext = vi.fn();
    admission.middleware({} as never, responseDouble() as never, retryNext);
    expect(retryNext).toHaveBeenCalledOnce();
  });

  it("accepts only exact front/back side values and preserves the legacy omitted default", () => {
    expect(parseHotFolderUploadSide(undefined)).toBe("front");
    expect(parseHotFolderUploadSide("front")).toBe("front");
    expect(parseHotFolderUploadSide("back")).toBe("back");
    for (const invalid of ["bak", "FRONT", " front ", 1, {}, []]) {
      expect(parseHotFolderUploadSide(invalid)).toBeNull();
    }
  });

  it("mounts authentication and admission before the body stage", async () => {
    const app = express();
    const auth = createHotFolderUploadAuth({ MINTVAULT_ADMIN_TOKEN: "watcher-secret" }, (_req, _res, next) => next());
    const admission = createHotFolderUploadAdmission(1);
    let releaseFirst: (() => void) | undefined;
    let parserStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      parserStarted = resolve;
    });
    const bodyStage = vi.fn((_req, _res, next) => {
      parserStarted();
      releaseFirst = next;
    });
    app.post("/upload", auth, admission.middleware, bodyStage, (_req, res) => res.status(204).end());
    const base = await listen(app);

    const unauthorized = await fetch(`${base}/upload`, { method: "POST", body: Buffer.alloc(1024 * 1024) });
    expect(unauthorized.status).toBe(401);
    expect(bodyStage).not.toHaveBeenCalled();

    const first = fetch(`${base}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer watcher-secret" },
      body: Buffer.alloc(1024),
    });
    await started;
    const second = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer watcher-secret" },
      body: Buffer.alloc(1024),
    });
    expect(second.status).toBe(503);
    expect(bodyStage).toHaveBeenCalledOnce();

    releaseFirst?.();
    expect((await first).status).toBe(204);
    expect(admission.stats().active).toBe(0);
  });

  it("mounts the retired scan-ingest refusal as a body-free terminal handler", async () => {
    const app = express();
    app.post("/api/admin/scan-ingest", refuseRetiredScanIngest);
    const base = await listen(app);

    const response = await fetch(`${base}/api/admin/scan-ingest`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(RETIRED_SCAN_INGEST_RESPONSE);
  });
});
