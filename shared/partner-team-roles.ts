/** Portal transport names only. Server RBAC and step-up remain the authority for grants. */
export const PORTAL_ROLE_TO_PARTNER_ROLE = {
  OWNER: "PARTNER_OWNER",
  ADMIN: "PARTNER_MANAGER",
  GRADER: "MVGS_ASSESSMENT_TECHNICIAN",
  STAFF: "PARTNER_RECEPTION",
  SCANNER_OPERATOR: "SCANNER_OPERATOR",
} as const;

export type PortalTeamRole = keyof typeof PORTAL_ROLE_TO_PARTNER_ROLE;

export const PORTAL_TEAM_ROLE_OPTIONS: ReadonlyArray<{ value: PortalTeamRole; label: string }> = [
  { value: "OWNER", label: "Owner" },
  { value: "ADMIN", label: "Admin" },
  { value: "GRADER", label: "Grader" },
  { value: "STAFF", label: "Staff" },
  { value: "SCANNER_OPERATOR", label: "Scanner Operator" },
];

export function isPortalTeamRole(value: unknown): value is PortalTeamRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PORTAL_ROLE_TO_PARTNER_ROLE, value);
}
