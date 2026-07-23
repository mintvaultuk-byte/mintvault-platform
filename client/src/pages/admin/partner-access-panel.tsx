/** Minimal Super Admin Partner invitation and membership-management panel. */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Panel, AdminButton, Chip } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";

const BASE = "/api/super-admin/partner-access";
const ROLE_OPTIONS = [
  ["PARTNER_OWNER", "Partner Owner"],
  ["PARTNER_MANAGER", "Partner Manager"],
  ["MVGS_ASSESSMENT_TECHNICIAN", "Partner Grader"],
  ["PARTNER_RECEPTION", "Reception"],
  ["PARTNER_FINANCE_VIEWER", "Finance Viewer"],
  ["PARTNER_TRAINEE", "Trainee"],
] as const;

interface LocationRow {
  id: string;
  name: string;
  status: string;
}
interface InvitationRow {
  id: string;
  invited_email: string;
  role: string;
  status: string;
  expires_at: string;
  delivery_status: string;
  location_ids: string[];
}
interface MemberRow {
  id: string;
  email: string;
  status: string;
  roles: string[];
  location_ids: string[];
}
interface AuditRow {
  id: string;
  action: string;
  actor_email: string | null;
  reason: string | null;
  created_at: string;
}

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find(([code]) => code === role)?.[1] ?? role;
}

export function PartnerAccessPanel({ partnerId }: { partnerId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MVGS_ASSESSMENT_TECHNICIAN");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [memberRoles, setMemberRoles] = useState<Record<string, string>>({});
  const [memberLocationScopes, setMemberLocationScopes] = useState<Record<string, string[]>>({});
  const key = useMemo(() => ["partner-access", partnerId], [partnerId]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const locations = useQuery({
    queryKey: [...key, "locations"],
    queryFn: async () =>
      (await apiRequest("GET", `${BASE}/partners/${partnerId}/locations`)).json() as Promise<{
        locations: LocationRow[];
      }>,
  });
  const invitations = useQuery({
    queryKey: [...key, "invitations"],
    queryFn: async () =>
      (await apiRequest("GET", `${BASE}/partners/${partnerId}/invitations`)).json() as Promise<{
        invitations: InvitationRow[];
      }>,
  });
  const members = useQuery({
    queryKey: [...key, "members"],
    queryFn: async () =>
      (await apiRequest("GET", `${BASE}/partners/${partnerId}/members`)).json() as Promise<{ members: MemberRow[] }>,
  });
  const audit = useQuery({
    queryKey: [...key, "audit"],
    queryFn: async () =>
      (await apiRequest("GET", `${BASE}/partners/${partnerId}/access-audit`)).json() as Promise<{ events: AuditRow[] }>,
  });
  const mutation = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) =>
      (await apiRequest("POST", `${BASE}/partners/${partnerId}${path}`, body)).json(),
    onSuccess: refresh,
  });

  function toggleLocation(id: string) {
    setLocationIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }
  function selectedMemberRole(member: MemberRow): string {
    return memberRoles[member.id] ?? member.roles[0] ?? "MVGS_ASSESSMENT_TECHNICIAN";
  }
  function selectedMemberLocations(member: MemberRow): string[] {
    return memberLocationScopes[member.id] ?? member.location_ids;
  }
  function toggleMemberLocation(member: MemberRow, locationId: string) {
    setMemberLocationScopes((current) => {
      const selected = current[member.id] ?? member.location_ids;
      return {
        ...current,
        [member.id]: selected.includes(locationId)
          ? selected.filter((value) => value !== locationId)
          : [...selected, locationId],
      };
    });
  }
  function invite(event: React.FormEvent) {
    event.preventDefault();
    mutation.mutate({ path: "/invitations", body: { email, role, locationIds, idempotencyKey: crypto.randomUUID() } });
  }
  const error = mutation.error as { body?: { error?: { message?: string } } } | null;

  return (
    <div className="space-y-4" data-testid="partner-access-panel">
      <Panel title="Invite Partner staff">
        <form className="grid gap-3" onSubmit={invite}>
          <label className="text-sm">
            Email
            <input
              className="ml-2 rounded border bg-transparent p-1"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="text-sm">
            Role
            <select
              className="ml-2 rounded border bg-transparent p-1"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLE_OPTIONS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="text-sm">Approved locations</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {(locations.data?.locations ?? [])
                .filter((location) => location.status === "ACTIVE")
                .map((location) => (
                  <label key={location.id} className="text-sm">
                    <input
                      type="checkbox"
                      checked={locationIds.includes(location.id)}
                      onChange={() => toggleLocation(location.id)}
                    />{" "}
                    {location.name}
                  </label>
                ))}
            </div>
          </fieldset>
          <AdminButton type="submit" variant="gold" size="sm" disabled={mutation.isPending || locationIds.length === 0}>
            Create and deliver invitation
          </AdminButton>
          {error?.body?.error?.message && <p role="alert">{error.body.error.message}</p>}
        </form>
      </Panel>

      <Panel title="Pending and historical invitations">
        <div className="space-y-2">
          {(invitations.data?.invitations ?? []).map((invitation) => (
            <div key={invitation.id} className="border-b pb-2 text-sm">
              <strong>{invitation.invited_email}</strong> · {roleLabel(invitation.role)} ·{" "}
              <Chip active={false}>{invitation.status}</Chip> · delivery {invitation.delivery_status}
              <div className="mt-1 flex gap-2">
                {invitation.status === "PENDING" && (
                  <>
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutation.mutate({
                          path: `/invitations/${invitation.id}/resend`,
                          body: { idempotencyKey: crypto.randomUUID() },
                        })
                      }
                    >
                      Resend / supersede
                    </AdminButton>
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutation.mutate({
                          path: `/invitations/${invitation.id}/revoke`,
                          body: { reason: reason || "Invitation revoked by Super Admin" },
                        })
                      }
                    >
                      Revoke
                    </AdminButton>
                  </>
                )}
              </div>
            </div>
          ))}
          {!invitations.isLoading && (invitations.data?.invitations ?? []).length === 0 && <p>No invitations.</p>}
        </div>
      </Panel>

      <Panel title="Partner members">
        <label className="block text-sm mb-2">
          Reason for high-risk change
          <input
            className="ml-2 rounded border bg-transparent p-1"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="space-y-2">
          {(members.data?.members ?? []).map((member) => (
            <div key={member.id} className="border-b pb-2 text-sm">
              <strong>{member.email}</strong> · {member.status} · {member.roles.map(roleLabel).join(", ") || "No role"}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label>
                  Role
                  <select
                    className="ml-1 rounded border bg-transparent p-1"
                    value={selectedMemberRole(member)}
                    onChange={(event) => setMemberRoles((current) => ({ ...current, [member.id]: event.target.value }))}
                  >
                    {ROLE_OPTIONS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending || !reason.trim()}
                  onClick={() =>
                    mutation.mutate({
                      path: `/members/${member.id}/role`,
                      body: { role: selectedMemberRole(member), reason },
                    })
                  }
                >
                  Save role
                </AdminButton>
              </div>
              <fieldset className="mt-2">
                <legend className="text-sm">Location scope</legend>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {(locations.data?.locations ?? [])
                    .filter((location) => location.status === "ACTIVE")
                    .map((location) => (
                      <label key={location.id}>
                        <input
                          type="checkbox"
                          checked={selectedMemberLocations(member).includes(location.id)}
                          onChange={() => toggleMemberLocation(member, location.id)}
                        />{" "}
                        {location.name}
                      </label>
                    ))}
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending || !reason.trim() || selectedMemberLocations(member).length === 0}
                    onClick={() =>
                      mutation.mutate({
                        path: `/members/${member.id}/locations`,
                        body: { locationIds: selectedMemberLocations(member), reason },
                      })
                    }
                  >
                    Save locations
                  </AdminButton>
                </div>
              </fieldset>
              <div className="mt-1 flex flex-wrap gap-2">
                <AdminButton
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending || !reason.trim()}
                  onClick={() =>
                    mutation.mutate({
                      path: `/members/${member.id}/revoke-sessions`,
                      body: { reason: reason || "Sessions revoked by Super Admin" },
                    })
                  }
                >
                  Revoke sessions
                </AdminButton>
                {member.status === "ACTIVE" ? (
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending || !reason.trim()}
                    onClick={() => mutation.mutate({ path: `/members/${member.id}/suspend`, body: { reason } })}
                  >
                    Suspend
                  </AdminButton>
                ) : (
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending || !reason.trim()}
                    onClick={() => mutation.mutate({ path: `/members/${member.id}/reactivate`, body: { reason } })}
                  >
                    Reactivate
                  </AdminButton>
                )}
              </div>
            </div>
          ))}
          {!members.isLoading && (members.data?.members ?? []).length === 0 && <p>No active Partner members.</p>}
        </div>
      </Panel>

      <Panel title="Immutable access history">
        <div className="space-y-1 text-sm">
          {(audit.data?.events ?? []).map((event) => (
            <div key={event.id}>
              {new Date(event.created_at).toLocaleString()} · {event.action} · {event.actor_email ?? "system"}
              {event.reason ? ` — ${event.reason}` : ""}
            </div>
          ))}
          {!audit.isLoading && (audit.data?.events ?? []).length === 0 && <p>No access events.</p>}
        </div>
      </Panel>
    </div>
  );
}
