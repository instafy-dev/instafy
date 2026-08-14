import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { Text } from "../../../components/Text";
import { type ControllerOrgInvitation, type ControllerProjectMember } from "../../../sdk/instafy";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { PreparedEmailInviteNotice } from "./PreparedEmailInviteNotice";
import { ProjectProviderBindingsCard } from "./ProjectProviderBindingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSurface } from "./SettingsSurface";

function resolveInitials(value: string) {
  const base = value.trim();
  if (!base) {
    return "U";
  }
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}

function truncateIdentifier(value: string, max = 16) {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(4, max - 5))}…${trimmed.slice(-4)}`;
}

type ProjectSettingsSectionsProps = {
  activeProjectId: string | null;
  activeProjectName: string | null;
  canShareProject: boolean;
  canWriteProject: boolean;
  runtimeControllerEnabled: boolean;
  currentUserId: string | null;
  showProjectBasics: boolean;
  projectAccessPanel: "guests" | "providers" | null;
  projectInviteEmail: string;
  projectInviteRole: string;
  projectInvitePending: boolean;
  projectInviteError: string | null;
  projectInviteEmailValid: boolean;
  preparedEmailInvite: PreparedEmailInvite | null;
  onProjectInviteEmailChange: (value: string) => void;
  onProjectInviteRoleChange: (value: string) => void;
  onInviteProjectMember: () => void;
  projectInvitationsError: string | null;
  projectInvitationsLoading: boolean;
  projectInvitations: ControllerOrgInvitation[];
  sortedProjectInvitations: ControllerOrgInvitation[];
  projectInviteCancelPendingId: string | null;
  onCancelProjectInvite: (invitationId: string, label: string) => void;
  projectInviteRoleUpdatePendingId: string | null;
  onPendingProjectInviteRoleChange: (
    invitationId: string,
    nextRole: string,
    label: string,
  ) => void;
  inviteLinkRole: string;
  activeInviteLinkRole: string | null;
  inviteLinkPending: boolean;
  inviteLinksError: string | null;
  inviteLinksLoading: boolean;
  inviteLinkUrl: string | null;
  onInviteLinkRoleChange: (value: string) => void;
  onCreateInviteLink: () => void;
  onCopyInviteLink: () => void;
  onRevokeInviteLink: () => void;
  projectMembersLoading: boolean;
  projectMembers: ControllerProjectMember[];
  sortedProjectMembers: ControllerProjectMember[];
  projectMembersError: string | null;
  projectMemberUpdatePendingId: string | null;
  projectMemberRemovePendingId: string | null;
  onProjectRoleChange: (userId: string, nextRole: string) => void;
  onRemoveProjectMember: (userId: string, label: string) => void;
  projectNameDraft: string;
  projectNameSaving: boolean;
  projectNameDirty: boolean;
  projectNameInvalid: boolean;
  onProjectNameChange: (value: string) => void;
  onProjectNameSave: () => void;
  onProjectNameCancel: () => void;
  projectDefaultsRefreshPending: boolean;
  onRefreshProjectDefaults: () => void;
};

export function ProjectSettingsSections({
  activeProjectId,
  activeProjectName,
  canShareProject,
  canWriteProject,
  runtimeControllerEnabled,
  currentUserId,
  showProjectBasics,
  projectAccessPanel,
  projectInviteEmail,
  projectInviteRole,
  projectInvitePending,
  projectInviteError,
  projectInviteEmailValid,
  preparedEmailInvite,
  onProjectInviteEmailChange,
  onProjectInviteRoleChange,
  onInviteProjectMember,
  projectInvitationsError,
  projectInvitationsLoading,
  projectInvitations,
  sortedProjectInvitations,
  projectInviteCancelPendingId,
  onCancelProjectInvite,
  projectInviteRoleUpdatePendingId,
  onPendingProjectInviteRoleChange,
  inviteLinkRole,
  activeInviteLinkRole,
  inviteLinkPending,
  inviteLinksError,
  inviteLinksLoading,
  inviteLinkUrl,
  onInviteLinkRoleChange,
  onCreateInviteLink,
  onCopyInviteLink,
  onRevokeInviteLink,
  projectMembersLoading,
  projectMembers,
  sortedProjectMembers,
  projectMembersError,
  projectMemberUpdatePendingId,
  projectMemberRemovePendingId,
  onProjectRoleChange,
  onRemoveProjectMember,
  projectNameDraft,
  projectNameSaving,
  projectNameDirty,
  projectNameInvalid,
  onProjectNameChange,
  onProjectNameSave,
  onProjectNameCancel,
  projectDefaultsRefreshPending,
  onRefreshProjectDefaults,
}: ProjectSettingsSectionsProps) {
  const showGuestAccess = projectAccessPanel === "guests";
  const showProviderAccess = projectAccessPanel === "providers";

  return (
    <div className="space-y-4">
      {showProjectBasics ? (
        <>
          <SettingsSection
            title="Space name"
            description="Rename this space. Guests will see the updated name in the studio header and invite links."
          >
            <SettingsSurface>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
                <div className="min-w-0">
                  <Text variant="caption" tone="muted">
                    Name
                  </Text>
                  <Input
                    value={projectNameDraft}
                    onChange={(event) => onProjectNameChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onProjectNameSave();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        onProjectNameCancel();
                      }
                    }}
                    disabled={!canWriteProject || projectNameSaving}
                    data-testid="project-settings-name-input"
                    className="mt-1"
                  />
                </div>
                <Button
                  onPress={onProjectNameSave}
                  isDisabled={!canWriteProject || projectNameSaving || projectNameInvalid || !projectNameDirty}
                  variant="outline"
                  size="sm"
                  radius="xl"
                  data-testid="project-settings-name-save"
                  className="w-full md:w-auto"
                >
                  {projectNameSaving ? "Saving…" : "Save"}
                </Button>
                <Button
                  onPress={onProjectNameCancel}
                  isDisabled={!canWriteProject || projectNameSaving || !projectNameDirty}
                  variant="ghost"
                  size="sm"
                  radius="xl"
                  data-testid="project-settings-name-cancel"
                  className="w-full md:w-auto"
                >
                  Cancel
                </Button>
              </div>
            </SettingsSurface>
          </SettingsSection>

          <SettingsSection
            title="Managed defaults"
            description="Pull in the latest pinned skills and docs for this project without overwriting local edits."
            data-testid="project-defaults-section"
          >
            <SettingsSurface>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Text variant="bodyStrong" tone="secondary">
                    Refresh defaults
                  </Text>
                  <Text variant="caption" tone="muted" className="mt-1">
                    Adds missing defaults and updates untouched managed files to the latest repo version.
                  </Text>
                </div>
                <Button
                  onPress={onRefreshProjectDefaults}
                  isDisabled={!canWriteProject || !activeProjectId || !runtimeControllerEnabled || projectDefaultsRefreshPending}
                  variant="outline"
                  size="sm"
                  radius="xl"
                  data-testid="project-defaults-refresh"
                  className="w-full sm:w-auto"
                >
                  {projectDefaultsRefreshPending ? "Refreshing…" : "Refresh defaults"}
                </Button>
              </div>
            </SettingsSurface>
          </SettingsSection>
        </>
      ) : null}

      {showGuestAccess ? (
        <>
          <SettingsSection
            title="Prepare email invite"
            description="Create a space-specific secure link to send yourself. Instafy does not send the email yet. Read & write can edit; read-only can view."
          >
        {projectInvitationsError ? (
          <Text variant="caption" tone="danger">
            {projectInvitationsError}
          </Text>
        ) : null}
        {!canShareProject ? (
          <Text variant="caption" tone="muted">
            {canWriteProject
              ? "You can edit this space, but your role cannot grant access to new people."
              : "You have read-only access and cannot invite people to this space."}
          </Text>
        ) : null}
        <SettingsSurface className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,220px)]">
            <div className="min-w-0">
              <Text variant="caption" tone="muted">
                Email
              </Text>
              <Input
                type="email"
                placeholder="guest@instafy.dev"
                value={projectInviteEmail}
                onChange={(event) => onProjectInviteEmailChange(event.target.value)}
                data-testid="project-member-invite-email"
                className="mt-1"
              />
              {!projectInviteEmailValid && projectInviteEmail.trim().length > 0 ? (
                <Text variant="caption" tone="danger" className="mt-1">
                  Enter a valid email address.
                </Text>
              ) : null}
            </div>
            <div className="min-w-0">
              <Text variant="caption" tone="muted">
                Access
              </Text>
              <Select
                value={projectInviteRole}
                onChange={(event) => onProjectInviteRoleChange(event.target.value)}
                data-testid="project-member-invite-role"
                className="mt-1"
                disabled={!canShareProject || projectInvitePending}
              >
                <option value="viewer">Read-only</option>
                <option value="builder">Read &amp; write</option>
              </Select>
            </div>
          </div>
          {projectInviteError ? (
            <Text
              variant="caption"
              tone="danger"
              className="mt-1"
              data-testid="project-member-invite-error"
            >
              {projectInviteError}
            </Text>
          ) : null}
          <div className="flex justify-end">
            <Button
              onPress={onInviteProjectMember}
              isDisabled={projectInvitePending || !projectInviteEmailValid || !canShareProject}
              variant="primary"
              size="sm"
              radius="xl"
              data-testid="project-member-invite-submit"
              className="w-full sm:w-auto"
            >
              {projectInvitePending ? "Preparing…" : "Prepare"}
            </Button>
          </div>
          {preparedEmailInvite ? (
            <PreparedEmailInviteNotice
              invite={preparedEmailInvite}
              testIdPrefix="project-email-invite"
            />
          ) : null}
        </SettingsSurface>
          </SettingsSection>

          <SettingsSection
            title="Pending invitations"
            actions={
              <Text variant="caption" tone="muted" data-testid="project-invitations-count">
                {projectInvitations.length}
              </Text>
            }
          >
        <SettingsSurface className="overflow-hidden p-0">
          {projectInvitationsError ? (
            <Text variant="caption" tone="danger" className="px-3 py-3">
              {projectInvitationsError}
            </Text>
          ) : projectInvitationsLoading && projectInvitations.length === 0 ? (
            <Text variant="caption" tone="muted" className="px-3 py-3">
              Loading invitations…
            </Text>
          ) : projectInvitations.length === 0 ? (
            <Text variant="caption" tone="muted" className="px-3 py-3">
              No pending invitations.
            </Text>
          ) : (
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
              {sortedProjectInvitations.map((invite) => {
                const cancelDisabled = projectInviteCancelPendingId === invite.id;
                const roleUpdatePending = projectInviteRoleUpdatePendingId === invite.id;
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
                    data-testid={`project-invite-row-${invite.id}`}
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
                            data-testid={`project-invite-expires-${invite.id}`}
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
                        data-testid={`project-invite-role-${invite.id}`}
                        onChange={(event) =>
                          onPendingProjectInviteRoleChange(
                            invite.id,
                            event.target.value,
                            invite.email,
                          )
                        }
                        size="xs"
                        radius="lg"
                        fullWidth={false}
                        className="w-32"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="builder">Builder</option>
                      </Select>
                      <Button
                        onPress={() => onCancelProjectInvite(invite.id, invite.email)}
                        isDisabled={cancelDisabled || roleUpdatePending}
                        variant="outline"
                        size="xs"
                        radius="full"
                        data-testid={`project-invite-cancel-${invite.id}`}
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

          <SettingsSection
            title="Invite link"
            description={
              <>
                Create a link that grants access to{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {activeProjectName ?? "this space"}
                </span>
                . Guests won&apos;t see your other spaces.
              </>
            }
          >
        {inviteLinksError ? (
          <Text variant="caption" tone="danger">
            {inviteLinksError}
          </Text>
        ) : null}
        {!canShareProject ? (
          <Text variant="caption" tone="muted">
            {canWriteProject
              ? "You can edit this space, but your role cannot manage invite links."
              : "You have read-only access and cannot manage invite links."}
          </Text>
        ) : null}
        <SettingsSurface className="space-y-3">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <Text variant="caption" tone="muted">
                {inviteLinkUrl ? "Access for replacement link" : "Access"}
              </Text>
              <Select
                value={inviteLinkRole}
                onChange={(event) => onInviteLinkRoleChange(event.target.value)}
                data-testid="org-invite-link-role"
                className="mt-1"
                disabled={!canShareProject || inviteLinkPending}
              >
                <option value="viewer">Read-only</option>
                <option value="builder">Read &amp; write</option>
              </Select>
            </div>
            <Button
              onPress={onCreateInviteLink}
              isDisabled={!canShareProject || inviteLinkPending}
              variant="outline"
              size="sm"
              radius="xl"
              data-testid="org-invite-link-create"
              className="w-full md:w-auto"
            >
              {inviteLinkPending ? "Working…" : inviteLinkUrl ? "Rotate link" : "Create link"}
            </Button>
          </div>
          {inviteLinkUrl ? (
            <div className="space-y-2" data-testid="org-invite-link-current">
              <Text variant="caption" tone="muted">
                Current link · {activeInviteLinkRole === "builder" ? "Read & write" : "Read-only"}
              </Text>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
                <Input value={inviteLinkUrl} readOnly data-testid="org-invite-link-url" className="min-w-0" />
                <Button
                  onPress={onCopyInviteLink}
                  variant="primary"
                  size="sm"
                  radius="xl"
                  data-testid="org-invite-link-copy"
                  className="w-full md:w-auto"
                >
                  Copy current link
                </Button>
                <Button
                  onPress={onRevokeInviteLink}
                  isDisabled={!canShareProject || inviteLinkPending}
                  variant="outline"
                  size="sm"
                  radius="xl"
                  data-testid="org-invite-link-revoke"
                  className="w-full md:w-auto"
                >
                  Revoke
                </Button>
              </div>
              <Text variant="caption" tone="muted">
                Rotating creates the selected access level and immediately disables this link.
              </Text>
            </div>
          ) : inviteLinksLoading ? (
            <Text variant="caption" tone="muted">
              Loading invite link…
            </Text>
          ) : null}
        </SettingsSurface>
          </SettingsSection>

          <SettingsSection
            title="Space guests"
            description="Guests invited by email or link can access only this space."
            actions={
              <Text variant="caption" tone="muted" data-testid="project-members-count">
                {projectMembers.length === 1 ? "1 guest" : `${projectMembers.length} guests`}
              </Text>
            }
            data-testid="project-guests-section"
          >
        {projectMembersLoading ? (
          <SettingsSurface>
            <Text variant="body" tone="secondary">
              Loading guests…
            </Text>
          </SettingsSurface>
        ) : projectMembers.length === 0 ? (
          <SettingsSurface>
            <Text variant="body" tone="secondary">
              No guests have accepted access yet.
            </Text>
          </SettingsSurface>
        ) : (
          <SettingsSurface className="overflow-hidden p-0">
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
              {sortedProjectMembers.map((member) => {
                const rawLabel = member.fullName || member.email || member.userId;
                const label =
                  member.fullName?.trim() ||
                  member.email?.trim() ||
                  `Member ${truncateIdentifier(member.userId, 14)}`;
                const secondary = member.email?.trim() || truncateIdentifier(member.userId, 24);
                const initials = resolveInitials(rawLabel);
                const isSelf = member.userId === currentUserId;
                const canEditRole = canShareProject && !isSelf;
                const canRemove = canShareProject && !isSelf;
                const roleDisabled =
                  !canEditRole ||
                  projectMemberUpdatePendingId === member.userId ||
                  projectMemberRemovePendingId === member.userId;
                const removeDisabled =
                  !canRemove ||
                  projectMemberRemovePendingId === member.userId ||
                  projectMemberUpdatePendingId === member.userId;

                return (
                  <div key={member.userId} className="px-3 py-3" data-testid={`project-member-row-${member.userId}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <Text variant="bodyStrong" tone="primary" className="truncate">
                            {label}
                          </Text>
                          <Text variant="caption" tone="muted" className="truncate">
                            <span className="font-mono">{secondary}</span>
                            {isSelf ? " · You" : ""}
                          </Text>
                        </div>
                      </div>
                      <Select
                        value={member.role}
                        disabled={roleDisabled}
                        data-testid={`project-member-role-${member.userId}`}
                        onChange={(event) => onProjectRoleChange(member.userId, event.target.value)}
                        size="xs"
                        radius="lg"
                        fullWidth={false}
                        className="w-32"
                      >
                        <option value="viewer">Read-only</option>
                        <option value="builder">Read &amp; write</option>
                      </Select>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span>Joined {new Date(member.createdAt).toLocaleDateString()}</span>
                      <Button
                        onPress={() => onRemoveProjectMember(member.userId, label)}
                        isDisabled={removeDisabled}
                        variant="outline"
                        size="xs"
                        radius="full"
                        data-testid={`project-member-remove-${member.userId}`}
                      >
                        {projectMemberRemovePendingId === member.userId ? "Removing…" : "Remove"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsSurface>
        )}
        {projectMembersError ? (
          <Text variant="caption" tone="danger">
            {projectMembersError}
          </Text>
        ) : null}
          </SettingsSection>

        </>
      ) : null}

      {showProviderAccess && activeProjectId ? (
        <ProjectProviderBindingsCard
          projectId={activeProjectId}
          canManageAccess={canWriteProject}
        />
      ) : null}
    </div>
  );
}
