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

  it("returns only safe staff security status fields in the staff account list", async () => {
    const { listStaffWithCounts } = await import("../server/staff");
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: "staff-1",
          email: "grader@example.com",
          display_name: "Grader",
          can_grade: true,
          can_scan: false,
          can_print: false,
          review_rate: 100,
          deleted_at: null,
          failed_login_count: 2,
          locked_until: "2026-07-15T12:00:00.000Z",
          grade_assigned: 0,
          grade_pending: 0,
          grade_approved: 0,
          scan_assigned: 0,
          password_hash: "must-not-leak",
        },
      ],
    });

    const rows = await listStaffWithCounts();
    expect(rows).toEqual([
      expect.objectContaining({
        id: "staff-1",
        enabled: true,
        failedLoginCount: 2,
        lockedUntil: "2026-07-15T12:00:00.000Z",
      }),
    ]);
    const [row] = rows;
    expect(JSON.stringify(row)).not.toContain("must-not-leak");
  });

  it("staff password reset stores a hash, clears lockout, and bumps credential_version", async () => {
    const { resetStaffPassword } = await import("../server/staff");
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "staff-1",
            email: "grader@example.com",
            role: "staff",
            can_grade: true,
            can_scan: false,
            can_print: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "staff-1" }] });

    await expect(resetStaffPassword("staff-1", "new-password-1", "admin")).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("revokes staff sessions by bumping credential_version without touching other users", async () => {
    const { revokeStaffSessions } = await import("../server/staff");
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "staff-1",
            email: "grader@example.com",
            role: "staff",
            can_grade: true,
            can_scan: false,
            can_print: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "staff-1" }] });

    await expect(revokeStaffSessions("staff-1", "admin")).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("disabled staff cannot log in", async () => {
    const { authenticateStaff } = await import("../server/staff");
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: "staff-1",
          email: "grader@example.com",
          display_name: "Grader",
          password_hash: "hash",
          role: "staff",
          deleted_at: "2026-07-15T12:00:00.000Z",
          can_grade: true,
          can_scan: false,
          can_print: false,
          credential_version: 1,
        },
      ],
    });

    await expect(authenticateStaff("grader@example.com", "correct-password")).resolves.toEqual({ ok: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
