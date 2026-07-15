import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("../server/db", () => ({
  db: { execute },
}));

vi.mock("../server/storage", () => ({
  storage: { writeAuditLog: vi.fn(async () => {}) },
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => {}),
}));

vi.mock("../server/grader", () => ({
  invalidateGraderSessionCache: vi.fn(),
}));

vi.mock("../server/account-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/account-auth")>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string) => password === "correct-password"),
  };
});

describe("staff auth hardening", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("increments shared DB failure state on a wrong staff password", async () => {
    const { authenticateStaff } = await import("../server/staff");
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "staff-1",
            email: "grader@example.com",
            display_name: "Grader",
            password_hash: "hash",
            role: "staff",
            deleted_at: null,
            can_grade: true,
            can_scan: false,
            can_print: false,
            failed_login_count: 0,
            locked_until: null,
            credential_version: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateStaff("grader@example.com", "wrong-password")).resolves.toEqual({ ok: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toBeTruthy();
  });

  it("blocks a staff account while locked without checking the password hash", async () => {
    const { authenticateStaff } = await import("../server/staff");
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: "staff-1",
          email: "grader@example.com",
          display_name: "Grader",
          password_hash: "hash",
          role: "staff",
          deleted_at: null,
          can_grade: true,
          can_scan: false,
          can_print: false,
          locked_until: new Date(Date.now() + 60_000).toISOString(),
          credential_version: 1,
        },
      ],
    });

    await expect(authenticateStaff("grader@example.com", "correct-password")).resolves.toEqual({ ok: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("resets shared DB failure state on successful staff login", async () => {
    const { authenticateStaff } = await import("../server/staff");
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "staff-1",
            email: "grader@example.com",
            display_name: "Grader",
            password_hash: "hash",
            role: "staff",
            deleted_at: null,
            can_grade: true,
            can_scan: false,
            can_print: false,
            failed_login_count: 4,
            locked_until: null,
            credential_version: 7,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateStaff("grader@example.com", "correct-password")).resolves.toMatchObject({
      ok: true,
      id: "staff-1",
      credentialVersion: 7,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
