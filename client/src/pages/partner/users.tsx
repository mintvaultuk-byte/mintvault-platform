import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, ShieldOff, UserCheck, UserMinus, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerErrorMessage, partnerTeam, type PartnerTeamMember, type PartnerTeamRole } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";

const ROLES: Array<{ value: PartnerTeamRole; label: string }> = [
  { value: "OWNER", label: "Owner" },
  { value: "ADMIN", label: "Admin" },
  { value: "GRADER", label: "Grader" },
  { value: "STAFF", label: "Staff" },
];

type Action =
  | { kind: "resend"; user: PartnerTeamMember }
  | { kind: "revoke-invite"; user: PartnerTeamMember }
  | { kind: "suspend"; user: PartnerTeamMember }
  | { kind: "reactivate"; user: PartnerTeamMember }
  | { kind: "remove"; user: PartnerTeamMember }
  | { kind: "sessions"; user: PartnerTeamMember };

function fullName(u: PartnerTeamMember): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
}

function fmt(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function badgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ACTIVE" || status === "SENT") return "default";
  if (status === "SUSPENDED" || status === "DELIVERY_FAILED") return "destructive";
  if (status === "REVOKED") return "secondary";
  return "outline";
}

export default function PartnerUsersPage() {
  const qc = useQueryClient();
  const { session, hasPermission } = usePartnerSession();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [roleEdit, setRoleEdit] = useState<{ user: PartnerTeamMember; role: PartnerTeamRole } | null>(null);
  const [reason, setReason] = useState("");
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", role: "STAFF" as PartnerTeamRole });
  const canManage = hasPermission("partner.users.manage");
  const canRevokeSessions = hasPermission("partner.sessions.revoke");

  const query = useQuery({
    queryKey: ["/api/partner/users"],
    queryFn: () => partnerTeam.list(),
  });

  const currentUser = useMemo(
    () => query.data?.users.find((u) => u.id === session?.userId) ?? null,
    [query.data?.users, session?.userId]
  );
  const isOwner = currentUser?.role === "OWNER";
  const permittedRoles = isOwner ? ROLES : ROLES.filter((r) => r.value !== "OWNER");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["/api/partner/users"] });
  const inviteMutation = useMutation({
    mutationFn: () => partnerTeam.invite({ ...form, reason: "Partner portal team invitation" }),
    onSuccess: async () => {
      setInviteOpen(false);
      setForm({ firstName: "", lastName: "", email: "", role: "STAFF" });
      await invalidate();
    },
  });
  const actionMutation = useMutation({
    mutationFn: async () => {
      if (!action) return;
      if (action.kind === "resend") return partnerTeam.resend(action.user.id, "Partner portal invitation resent");
      if (action.kind === "revoke-invite") return partnerTeam.revokeInvitation(action.user.id, reason);
      if (action.kind === "suspend") return partnerTeam.setStatus(action.user.id, "SUSPENDED", reason);
      if (action.kind === "reactivate") return partnerTeam.setStatus(action.user.id, "ACTIVE", reason);
      if (action.kind === "remove") return partnerTeam.setStatus(action.user.id, "REVOKED", reason);
      return partnerTeam.revokeSessions(action.user.id, "Partner portal sessions revoked");
    },
    onSuccess: async () => {
      setAction(null);
      setReason("");
      await invalidate();
    },
  });
  const roleMutation = useMutation({
    mutationFn: () => partnerTeam.changeRole(roleEdit!.user.id, roleEdit!.role, reason),
    onSuccess: async () => {
      setRoleEdit(null);
      setReason("");
      await invalidate();
    },
  });

  if (query.isLoading) return <PartnerLoadingState label="Loading team members..." />;
  if (query.error)
    return <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />;

  const users = query.data?.users ?? [];

  return (
    <div className="space-y-5" data-testid="partner-team-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-partner-team-title">
            Users
          </h1>
          <p className="text-sm text-muted-foreground">Manage Partner Portal access for your team.</p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)} data-testid="button-team-add-member">
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Add team member
          </Button>
        )}
      </div>

      {!canManage && (
        <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground" data-testid="team-read-only-note">
          You can view team access, but only owners and admins can make changes.
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-md border bg-card p-8 text-center" data-testid="partner-team-empty">
          No team members yet.
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto" data-testid="partner-team-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invitation</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const isSelf = u.id === session?.userId;
                const isTargetOwner = u.role === "OWNER";
                const canModify = canManage && (isOwner || !isTargetOwner);
                const pendingInvite = ["PENDING", "SENT", "DELIVERY_FAILED"].includes(u.invitationStatus ?? "");
                return (
                  <TableRow key={u.id} data-testid={`team-row-${u.email}`}>
                    <TableCell className="font-medium">{fullName(u)}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      {canModify ? (
                        <Select
                          value={u.role}
                          onValueChange={(value) => setRoleEdit({ user: u, role: value as PartnerTeamRole })}
                        >
                          <SelectTrigger className="h-8 w-[130px]" data-testid={`select-team-role-${u.email}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(isOwner && !isSelf ? ROLES : permittedRoles).map((role) => (
                              <SelectItem key={role.value} value={role.value}>
                                {role.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span>{u.role}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badgeVariant(u.status)}>{u.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {u.invitationStatus ? (
                        <Badge variant={badgeVariant(u.invitationStatus)}>{u.invitationStatus}</Badge>
                      ) : (
                        "Accepted"
                      )}
                    </TableCell>
                    <TableCell>{fmt(u.lastLoginAt)}</TableCell>
                    <TableCell>{fmt(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2 flex-wrap">
                        {canModify && pendingInvite && (
                          <>
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => setAction({ kind: "resend", user: u })}
                              data-testid={`button-team-resend-${u.email}`}
                              aria-label={`Resend invitation to ${u.email}`}
                            >
                              <RotateCcw className="h-4 w-4" aria-hidden="true" />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => setAction({ kind: "revoke-invite", user: u })}
                              data-testid={`button-team-revoke-invite-${u.email}`}
                              aria-label={`Revoke invitation for ${u.email}`}
                            >
                              <ShieldOff className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </>
                        )}
                        {canModify && u.status === "ACTIVE" && (
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => setAction({ kind: "suspend", user: u })}
                            data-testid={`button-team-suspend-${u.email}`}
                            aria-label={`Suspend ${u.email}`}
                          >
                            <UserX className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                        {canModify && u.status === "SUSPENDED" && (
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => setAction({ kind: "reactivate", user: u })}
                            data-testid={`button-team-reactivate-${u.email}`}
                            aria-label={`Reactivate ${u.email}`}
                          >
                            <UserCheck className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                        {canModify && u.status !== "REVOKED" && (
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => setAction({ kind: "remove", user: u })}
                            data-testid={`button-team-remove-${u.email}`}
                            aria-label={`Remove ${u.email}`}
                          >
                            <UserMinus className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                        {canRevokeSessions && canModify && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setAction({ kind: "sessions", user: u })}
                            data-testid={`button-team-revoke-sessions-${u.email}`}
                          >
                            Revoke sessions
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent data-testid="dialog-team-invite">
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="team-first-name">First name</Label>
              <Input
                id="team-first-name"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                data-testid="input-team-first-name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-last-name">Last name</Label>
              <Input
                id="team-last-name"
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                data-testid="input-team-last-name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-email">Email</Label>
              <Input
                id="team-email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                data-testid="input-team-email"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-role">Role</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role: role as PartnerTeamRole })}>
                <SelectTrigger id="team-role" data-testid="select-team-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {permittedRoles.map((role) => (
                    <SelectItem key={role.value} value={role.value}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteMutation.error && (
              <p role="alert" className="text-sm text-destructive" data-testid="text-team-invite-error">
                {partnerErrorMessage(inviteMutation.error)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
              data-testid="button-team-invite-submit"
            >
              Send invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ActionDialog
        action={action}
        reason={reason}
        setReason={setReason}
        busy={actionMutation.isPending}
        error={actionMutation.error}
        onClose={() => setAction(null)}
        onConfirm={() => actionMutation.mutate()}
      />
      <RoleDialog
        roleEdit={roleEdit}
        reason={reason}
        setReason={setReason}
        busy={roleMutation.isPending}
        error={roleMutation.error}
        onClose={() => setRoleEdit(null)}
        onConfirm={() => roleMutation.mutate()}
      />
    </div>
  );
}

function ActionDialog({
  action,
  reason,
  setReason,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  action: Action | null;
  reason: string;
  setReason: (reason: string) => void;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const needsReason = action?.kind !== "resend" && action?.kind !== "sessions";
  return (
    <Dialog open={!!action} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dialog-team-action">
        <DialogHeader>
          <DialogTitle>{action ? actionTitle(action) : "Confirm action"}</DialogTitle>
        </DialogHeader>
        {action && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirm this action for <span className="font-medium text-foreground">{action.user.email}</span>.
              {action.user.role === "OWNER" && " A partner must keep at least one active owner."}
            </p>
            {needsReason && (
              <div className="grid gap-2">
                <Label htmlFor="team-action-reason">Reason</Label>
                <Textarea
                  id="team-action-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="textarea-team-action-reason"
                />
              </div>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive" data-testid="text-team-action-error">
                {partnerErrorMessage(error)}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy || (needsReason && !reason.trim())}
            data-testid="button-team-action-confirm"
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  roleEdit,
  reason,
  setReason,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  roleEdit: { user: PartnerTeamMember; role: PartnerTeamRole } | null;
  reason: string;
  setReason: (reason: string) => void;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!roleEdit} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dialog-team-role">
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
        </DialogHeader>
        {roleEdit && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Change <span className="font-medium text-foreground">{roleEdit.user.email}</span> to {roleEdit.role}.
              {roleEdit.user.role === "OWNER" && " A partner must keep at least one active owner."}
            </p>
            <div className="grid gap-2">
              <Label htmlFor="team-role-reason">Reason</Label>
              <Textarea
                id="team-role-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="textarea-team-role-reason"
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive" data-testid="text-team-role-error">
                {partnerErrorMessage(error)}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || !reason.trim()} data-testid="button-team-role-confirm">
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function actionTitle(action: Action): string {
  if (action.kind === "resend") return "Resend invitation";
  if (action.kind === "revoke-invite") return "Revoke invitation";
  if (action.kind === "suspend") return "Suspend team member";
  if (action.kind === "reactivate") return "Reactivate team member";
  if (action.kind === "remove") return "Remove team member";
  return "Revoke sessions";
}
