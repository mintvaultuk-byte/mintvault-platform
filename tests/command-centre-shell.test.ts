import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { navigationForCommandCentre } from "../client/src/components/admin/admin-shell";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Command Centre shell exposure", () => {
  it("keeps the Insight link absent unless availability is server-confirmed", () => {
    const hidden = navigationForCommandCentre(false);
    const visible = navigationForCommandCentre(true);

    expect(
      hidden.flatMap((section) => section.items).find((item) => "href" in item && item.href === "/admin/command")
    ).toBeUndefined();
    expect(
      visible.flatMap((section) => section.items).find((item) => "href" in item && item.href === "/admin/command")
    ).toMatchObject({
      href: "/admin/command",
      label: "Command Centre",
      children: [
        { href: "/admin/command?view=overview", label: "Overview" },
        { href: "/admin/command?view=attention", label: "Attention" },
        { href: "/admin/command?view=tree", label: "Work Tree" },
        { href: "/admin/command?view=skills", label: "Skills" },
      ],
    });
  });

  it("uses a server-derived availability value and disables shell polling", () => {
    const server = read("server/routes/admin-config.ts");
    const shell = read("client/src/components/admin/admin-shell.tsx");
    const page = read("client/src/pages/admin-command-centre.tsx");

    expect(server).toContain("isCommandCentreEnabledRuntime()");
    expect(server).toContain("isSuperAdminEmail");
    expect(server).toContain("command_centre_available");
    expect(shell).toContain("refetchInterval: disableEnvironmentPolling ? false : 60000");
    expect(page).toContain("disableEnvironmentPolling");
    expect(page).not.toContain("VITE_SUPER_ADMIN_COMMAND_CENTRE_ENABLED");
  });

  it("registers the exact Command Centre route before the general admin route", () => {
    const app = read("client/src/App.tsx");
    const commandRoute = app.indexOf('path="/admin/command"');
    const generalAdminRoute = app.indexOf('path="/admin" component={AdminPage}');

    expect(commandRoute).toBeGreaterThan(-1);
    expect(generalAdminRoute).toBeGreaterThan(commandRoute);
  });

  it("removes Command Centre animation and transition motion under reduced-motion preference", () => {
    const page = read("client/src/pages/admin-command-centre.tsx");
    const shell = read("client/src/components/admin/admin-shell.tsx");
    const css = read("client/src/index.css");

    expect(page).not.toContain("animate-pulse");
    expect(shell).toContain("command-centre-nav-chevron");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain('[data-testid="command-centre-page"] *');
    expect(css).toContain("animation-duration: 0.01ms !important");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });
});
