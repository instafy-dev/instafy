import { useState } from "react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { Text } from "../../../components/Text";
import { type ControllerOrgInvitation, type ControllerOrgMember } from "../../../sdk/instafy";
import type { OrgInvitationRoleConflict } from "../../../org/useInviteActions";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { PreparedEmailInviteNotice } from "./PreparedEmailInviteNotice";
import { SettingsSection } from "./SettingsSection";
import { SettingsSurface } from "./SettingsSurface";
import { HumanAvatar } from "../../../components/HumanAvatar";

function truncateIdentifier(value: string, max = 16) {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(4, max - 5))}…${trimmed.slice(-4)}`;
}

type OrgMembersSettingsSectionsProps = {
  currentUserId: string | null;
  canManageOrgMembers: boolean;
  canManageOwners: boolean;
  inviteEmail: string;
  inviteRole: string;
  invitePending: boolean;
  inviteError: string | null;
  inviteEmailValid: boolean;
  preparedEmailInvite: PreparedEmailInvite | null;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: string) => void;
  onInviteMember: () => void;
  invitationsCountLabel: string;
  invitationsError: string | null;
  invitationsLoading: boolean;
  invitations: ControllerOrgInvitation[];
  sortedInvitations: ControllerOrgInvitation[];
  inviteCancelPendingId: string | null;
  onCancelInvite: (invitationId: string, label: string) => void;
  inviteRoleUpdatePendingId: string | null;
  // Named apart from the invite FORM's onInviteRoleChange above: this one
  // retargets an already-sent invitation.
  onPendingInviteRoleChange: (invitationId: string, nextRole: string, label: string) => void;
  inviteRoleConflict: (OrgInvitationRoleConflict & { email: string }) | null;
  inviteConflictPending: boolean;
  onApplyInviteRoleConflict: () => void;
  onDismissInviteRoleConflict: () => void;
  membersCountLabel: string;
  memberQuery: string;
  onMemberQueryChange: (value: string) => void;
  membersLoading: boolean;
  membersLoadingMore: boolean;
  members: ControllerOrgMember[];
  sortedMembers: ControllerOrgMember[];
  membersHasMore: boolean;
  onLoadMoreMembers: () => void;
  memberUpdatePendingId: string | null;
  memberRemovePendingId: string | null;
  onRoleChange: (userId: string, nextRole: string) => void;
  onRemoveMember: (userId: string, label: string) => void;
};

export function OrgMembersSettingsSections({
  currentUserId,
  canManageOrgMembers,
  canManageOwners,
  inviteEmail,
  inviteRole,
  invitePending,
  inviteError,
  inviteEmailValid,
  preparedEmailInvite,
  onInviteEmailChange,
  onInviteRoleChange,
  onInviteMember,
  invitationsCountLabel,
  invitationsError,
  invitationsLoading,
  invitations,
  sortedInvitations,
  inviteCancelPendingId,
  onCancelInvite,
  inviteRoleUpdatePendingId,
  onPendingInviteRoleChange,
  inviteRoleConflict,
  inviteConflictPending,
  onApplyInviteRoleConflict,
  onDismissInviteRoleConflict,
  membersCountLabel,
  memberQuery,
  onMemberQueryChange,
  membersLoading,
  membersLoadingMore,
  members,
  sortedMembers,
  membersHasMore,
  onLoadMoreMembers,
  memberUpdatePendingId,
  memberRemovePendingId,
  onRoleChange,
  onRemoveMember,
}: OrgMembersSettingsSectionsProps) {
  const [invitationsExpanded, setInvitationsExpanded] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const hasInvitations = invitations.length > 0;
  const hasMemberQuery = memberQuery.trim().length > 0;
  const showInvitationsList =
    invitationsExpanded || invitationsLoading || Boolean(invitationsError) || !hasInvitations;
  const showMembersList = membersExpanded || hasMemberQuery || membersLoading || members.length === 0;

  return (
    <div className="space-y-4" data-testid="org-members-layout">
      <SettingsSection
        title="Prepare email invite"
        description="Prepare a secure link and deliver it yourself — Instafy never emails invites. Builders can edit; viewers can read; admins manage members; owners control billing."
      >
        {canManageOrgMembers ? (
          <SettingsSurface className="space-y-3">
            <div className="grid gap-3 @min-[32rem]/settings-content:grid-cols-[minmax(0,1fr)_minmax(180px,220px)]">
              <div className="min-w-0">
                <Text variant="caption" tone="muted">
                  Email
                </Text>
                <Input
                  type="email"
                  placeholder="teammate@instafy.dev"
                  value={inviteEmail}
                  onChange={(event) => onInviteEmailChange(event.target.value)}
                  data-testid="org-member-invite-email"
                  className="mt-1"
                />
                {!inviteEmailValid && inviteEmail.trim().length > 0 ? (
                  <Text variant="caption" tone="danger" className="mt-1">
                    Enter a valid email address.
                  </Text>
                ) : null}
              </div>
              <div className="min-w-0">
                <Text variant="caption" tone="muted">
                  Role
                </Text>
                <Select
                  value={inviteRole}
                  onChange={(event) => onInviteRoleChange(event.target.value)}
                  data-testid="org-member-invite-role"
                  className="mt-1"
                >
                  <option value="viewer">Viewer</option>
                  <option value="builder">Builder</option>
                  <option value="admin">Admin</option>
                  {canManageOwners ? <option value="owner">Owner</option> : null}
                </Select>
              </div>
            </div>
            {inviteError ? (
              <Text
                variant="caption"
                tone="danger"
                className="mt-1"
                data-testid="org-member-invite-error"
              >
                {inviteError}
              </Text>
            ) : null}
            {inviteRoleConflict ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/60 bg-amber-50/80 px-3 py-2 dark:border-amber-700/50 dark:bg-amber-950/30"
                data-testid="org-invite-role-conflict"
              >
                <Text variant="caption" tone="secondary">
                  {inviteRoleConflict.email} already has a pending{" "}
                  {inviteRoleConflict.existingRole} invite. Its link keeps working
                  either way.
                </Text>
                <div className="flex items-center gap-2">
                  <Button
                    onPress={onApplyInviteRoleConflict}
                    isDisabled={inviteConflictPending}
                    variant="primary"
                    size="xs"
                    radius="full"
                    data-testid="org-invite-role-conflict-apply"
                  >
                    {inviteConflictPending
                      ? "Updating…"
                      : `Change to ${inviteRoleConflict.requestedRole}`}
                  </Button>
                  <Button
                    onPress={onDismissInviteRoleConflict}
                    isDisabled={inviteConflictPending}
                    variant="ghost"
                    size="xs"
                    radius="full"
                    data-testid="org-invite-role-conflict-dismiss"
                  >
                    Keep {inviteRoleConflict.existingRole}
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                onPress={onInviteMember}
                isDisabled={invitePending || !inviteEmailValid}
                variant="primary"
                size="sm"
                radius="xl"
                data-testid="org-member-invite-submit"
                className="w-full @min-[32rem]/settings-content:w-auto"
              >
                {invitePending ? "Preparing…" : "Prepare"}
              </Button>
            </div>
            {preparedEmailInvite ? (
              <PreparedEmailInviteNotice
                invite={preparedEmailInvite}
                testIdPrefix="org-email-invite"
              />
            ) : null}
          </SettingsSurface>
        ) : (
          <SettingsSurface>
            <Text variant="body" tone="secondary">
              Only owners and admins can invite people.
            </Text>
          </SettingsSurface>
        )}
      </SettingsSection>

      {canManageOrgMembers ? (
        <SettingsSection
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Pending invitations
              <Text as="span" variant="caption" tone="muted" data-testid="org-invitations-count">
                {invitationsCountLabel}
              </Text>
            </span>
          }
          actions={
            hasInvitations && !invitationsError ? (
              <Button
                onPress={() => setInvitationsExpanded((value) => !value)}
                variant="ghost"
                size="xs"
                radius="full"
                data-testid="org-invitations-toggle"
              >
                {invitationsExpanded ? "Hide" : "Review"}
              </Button>
            ) : null
          }
        >
          <SettingsSurface padding="none" className="overflow-hidden">
            {invitationsError ? (
              <Text variant="caption" tone="danger" className="px-3 py-3">
                {invitationsError}
              </Text>
            ) : invitationsLoading && invitations.length === 0 ? (
              <Text variant="caption" tone="muted" className="px-3 py-3">
                Loading invitations…
              </Text>
            ) : invitations.length === 0 ? (
              <Text variant="body" tone="muted" className="px-3 py-3">
                No pending invitations.
              </Text>
            ) : !showInvitationsList ? (
              <div className="space-y-1 p-3">
                <Text variant="body" tone="secondary">
                  {invitationsCountLabel} pending invitation{invitations.length === 1 ? "" : "s"}.
                </Text>
                <Text variant="caption" tone="muted">
                  Review the list only when you need to cancel an invite.
                </Text>
              </div>
            ) : (
              <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {sortedInvitations.map((invite) => {
                  const cancelDisabled = inviteCancelPendingId === invite.id;
                  const roleUpdatePending = inviteRoleUpdatePendingId === invite.id;
                  // The org-scope pending list only ever receives org-level
                  // rows today, so this branch is defensive: if a
                  // project-scoped invitation is ever rendered here, its role
                  // options must stay viewer|builder — the same split the
                  // server enforces in normalize_project_share_role.
                  const isProjectScoped = Boolean(invite.projectId);
                  const sentAt = new Date(invite.createdAt);
                  const sentLabel = Number.isNaN(sentAt.valueOf()) ? null : sentAt.toLocaleDateString();
                  const expiresAt = invite.expiresAt ? new Date(invite.expiresAt) : null;
                  const expiresLabel =
                    expiresAt && !Number.isNaN(expiresAt.valueOf())
                      ? expiresAt.toLocaleDateString()
                      : null;
                  return (
                    <div
                      key={invite.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                      data-testid={`org-invite-row-${invite.id}`}
                    >
                      <div className="min-w-0">
                        <Text variant="bodyStrong" tone="primary" className="truncate">
                          {invite.email}
                        </Text>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          {sentLabel ? (
                            <Text variant="caption" tone="muted">
                              Created {sentLabel}
                            </Text>
                          ) : null}
                          {expiresLabel ? (
                            <Text
                              variant="caption"
                              tone="muted"
                              data-testid={`org-invite-expires-${invite.id}`}
                            >
                              Expires {expiresLabel}
                            </Text>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select
                          value={invite.role}
                          disabled={roleUpdatePending || cancelDisabled}
                          data-testid={`org-invite-role-${invite.id}`}
                          onChange={(event) =>
                            onPendingInviteRoleChange(invite.id, event.target.value, invite.email)
                          }
                          size="xs"
                          radius="lg"
                          fullWidth={false}
                          className="w-32 shrink-0"
                        >
                          <option value="viewer">Viewer</option>
                          <option value="builder">Builder</option>
                          {!isProjectScoped ? (
                            <>
                              <option value="admin">Admin</option>
                              <option value="owner" disabled={!canManageOwners}>
                                Owner
                              </option>
                            </>
                          ) : null}
                        </Select>
                        <Button
                          onPress={() => onCancelInvite(invite.id, invite.email)}
                          isDisabled={cancelDisabled || roleUpdatePending}
                          variant="outline"
                          size="xs"
                          radius="full"
                          data-testid={`org-invite-cancel-${invite.id}`}
                        >
                          {cancelDisabled ? "Canceling…" : "Cancel"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsSurface>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="People with access"
        actions={
          <div className="flex items-center gap-2">
            <Text variant="caption" tone="muted" data-testid="org-members-count">
              {membersCountLabel}
            </Text>
            {members.length > 0 ? (
              <Button
                onPress={() => setMembersExpanded((value) => !value)}
                variant="ghost"
                size="xs"
                radius="full"
                data-testid="org-members-toggle"
              >
                {membersExpanded ? "Hide" : "Manage"}
              </Button>
            ) : null}
          </div>
        }
      >
        <SettingsSurface padding="none" className="space-y-3 overflow-hidden">
          <div className="px-3 pt-3">
            <Input
              placeholder="Search by name, email, or id"
              value={memberQuery}
              onChange={(event) => onMemberQueryChange(event.target.value)}
              data-testid="org-member-search"
            />
          </div>

          {membersLoading && members.length === 0 ? (
            <Text variant="caption" tone="muted" className="px-3 pb-3">
              Loading members…
            </Text>
          ) : members.length === 0 ? (
            <Text variant="body" tone="muted" className="px-3 pb-3">
              No people have access yet.
            </Text>
          ) : !showMembersList ? (
            <div className="px-3 pb-3">
              <Text variant="caption" tone="muted">
                Search for someone or open the member list when you need to change roles.
              </Text>
            </div>
          ) : (
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
              {sortedMembers.map((member) => {
                const label =
                  member.fullName?.trim() ||
                  member.email?.trim() ||
                  `Member ${truncateIdentifier(member.userId, 14)}`;
                const secondary = member.email?.trim() || truncateIdentifier(member.userId, 24);
                const isSelf = member.userId === currentUserId;
                const isOwner = member.role === "owner";
                const canEditOwner = canManageOwners || !isOwner;
                const canEditRole = canManageOrgMembers && canEditOwner;
                const canRemove = canManageOrgMembers && !isSelf && canEditOwner;
                const roleDisabled =
                  !canEditRole ||
                  memberUpdatePendingId === member.userId ||
                  memberRemovePendingId === member.userId;
                const removeDisabled =
                  !canRemove ||
                  memberRemovePendingId === member.userId ||
                  memberUpdatePendingId === member.userId;

                return (
                  <div
                    key={member.userId}
                    className="px-3 py-3"
                    data-testid={`org-member-row-${member.userId}`}
                  >
                    <div className="flex flex-col gap-3 @min-[32rem]/settings-content:flex-row @min-[32rem]/settings-content:items-start @min-[32rem]/settings-content:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <HumanAvatar userId={member.userId} displayName={member.fullName} className="h-9 w-9 text-xs" />
                        <div className="min-w-0">
                          <Text variant="bodyStrong" tone="primary" className="break-words" title={label}>
                            {label}
                          </Text>
                          <Text variant="caption" tone="muted" className="break-all">
                            <span>{secondary}</span>
                            {isSelf ? " · You" : ""}
                          </Text>
                        </div>
                      </div>

                      <Select
                        value={member.role}
                        disabled={roleDisabled}
                        data-testid={`org-member-role-${member.userId}`}
                        onChange={(event) => onRoleChange(member.userId, event.target.value)}
                        size="xs"
                        radius="lg"
                        fullWidth={false}
                        className="w-32 shrink-0"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="builder">Builder</option>
                        <option value="admin">Admin</option>
                        <option value="owner" disabled={!canManageOwners}>
                          Owner
                        </option>
                      </Select>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span>Joined {new Date(member.createdAt).toLocaleDateString()}</span>
                      <Button
                        onPress={() => onRemoveMember(member.userId, label)}
                        isDisabled={removeDisabled}
                        variant="outline"
                        size="xs"
                        radius="full"
                        data-testid={`org-member-remove-${member.userId}`}
                      >
                        {memberRemovePendingId === member.userId ? "Removing…" : "Remove"}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {membersHasMore ? (
                <div className="px-3 pb-3 pt-3">
                  <Button
                    onPress={onLoadMoreMembers}
                    isDisabled={membersLoading || membersLoadingMore}
                    variant="outline"
                    size="sm"
                    radius="xl"
                    data-testid="org-members-load-more"
                    className="w-full"
                  >
                    {membersLoadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </SettingsSurface>
      </SettingsSection>
    </div>
  );
}
