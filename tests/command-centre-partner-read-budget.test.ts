import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  query: vi.fn(),
  active: 0,
  destroyed: 0,
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {
        return this;
      }
      connect(callback: (error: Error | undefined, client?: unknown, release?: (destroy?: boolean) => void) => void) {
        runtime.active += 1;
        let released = false;
        callback(undefined, { query: runtime.query }, (destroy?: boolean) => {
          if (released) return;
          released = true;
          runtime.active -= 1;
          if (destroy) runtime.destroyed += 1;
        });
      }
      async end() {}
    },
  },
}));

import { closePartnerPools, withPartnerAdminReadBudget } from "../server/partner/db";

beforeEach(() => {
  process.env.MINTVAULT_DATABASE_URL = "postgresql://admin:test@127.0.0.1:55433/mintvault_partner_budget";
  process.env.PARTNER_ADMIN_DATABASE_URL = process.env.MINTVAULT_DATABASE_URL;
  runtime.query.mockReset();
  runtime.active = 0;
  runtime.destroyed = 0;
});

afterEach(async () => {
  await closePartnerPools();
  vi.restoreAllMocks();
  delete process.env.MINTVAULT_DATABASE_URL;
  delete process.env.PARTNER_ADMIN_DATABASE_URL;
});

describe("Command Centre Partner read budget", () => {
  it.each(["BEGIN READ ONLY", "SET LOCAL statement_timeout = '500ms'"])(
    "destroys the admin client when setup stalls at %s",
    async (stalledQuery) => {
      runtime.query.mockImplementation((query: string) =>
        query === stalledQuery ? new Promise(() => {}) : Promise.resolve({ rows: [] })
      );
      const operation = vi.fn(async () => "unreachable");
      const started = Date.now();

      await expect(withPartnerAdminReadBudget(operation, 50)).rejects.toThrow("PARTNER_READ_TIMEOUT");

      expect(Date.now() - started).toBeLessThan(300);
      expect(runtime.destroyed).toBe(1);
      expect(runtime.active).toBe(0);
      expect(operation).not.toHaveBeenCalled();
    }
  );

  it("destroys a client acquired exactly as the absolute deadline expires without attempting rollback", async () => {
    runtime.query.mockImplementation(() => new Promise(() => {}));
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValue(1_050);
    const operation = vi.fn(async () => "unreachable");

    await expect(withPartnerAdminReadBudget(operation, 50)).rejects.toThrow("PARTNER_READ_TIMEOUT");

    expect(runtime.query).not.toHaveBeenCalled();
    expect(runtime.destroyed).toBe(1);
    expect(runtime.active).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });
});
