import type { Ref } from "react";
import { QrCode, SendDiagonal } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioDialogDivider } from "../../../components/aria/StudioDialogLayout";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import {
  ComposerInviteRoleToggle,
  ComposerPendingInvitationList,
  type ComposerInviteRole,
} from "./ComposerInviteAccessControls";
import { PreparedEmailInviteNotice } from "./PreparedEmailInviteNotice";

type InviteLinkSummary = {
  id: string;
  role: string;
};

type PendingInvitation = {
  email: string;
  id: string;
  role: string;
};

type ComposerInviteProjectAccessSectionProps = {
  accessRole: ComposerInviteRole;
  activeInviteLink: InviteLinkSummary | null;
  activeNearbyInviteUrl: string | null;
  canInviteIntoChat: boolean;
  canShareProject: boolean;
  canWriteProject: boolean;
  copyPendingRole: ComposerInviteRole | null;
  currentInviteLink: InviteLinkSummary | null;
  emailInputRef: Ref<HTMLInputElement>;
  emailInvitePending: boolean;
  emailValid: boolean;
  emailValue: string;
  inviteCancelPendingId: string | null;
  inviteLinkRevokePendingId: string | null;
  nearbyQrPendingRole: ComposerInviteRole | null;
  nearbyShareAvailable: boolean;
  nearbySharePendingRole: ComposerInviteRole | null;
  pendingInvitations: PendingInvitation[];
  preparedEmailInvite: PreparedEmailInvite | null;
  preparedEmailInviteRef: Ref<HTMLDivElement>;
  sharingPermissionsLoading: boolean;
  sharingTargetReady: boolean;
  onAccessRoleChange: (role: ComposerInviteRole) => void;
  onCancelInvitation: (invitationId: string, email: string) => void;
  onCopyInviteLink: () => void;
  onEmailValueChange: (value: string) => void;
  onInviteByEmail: () => void;
  onNearbyShare: () => void;
  onRevokeInviteLink: () => void;
  onShowNearbyQr: () => void;
};

export function ComposerInviteProjectAccessSection({
  accessRole,
  activeInviteLink,
  activeNearbyInviteUrl,
  canInviteIntoChat,
  canShareProject,
  canWriteProject,
  copyPendingRole,
  currentInviteLink,
  emailInputRef,
  emailInvitePending,
  emailValid,
  emailValue,
  inviteCancelPendingId,
  inviteLinkRevokePendingId,
  nearbyQrPendingRole,
  nearbyShareAvailable,
  nearbySharePendingRole,
  pendingInvitations,
  preparedEmailInvite,
  preparedEmailInviteRef,
  sharingPermissionsLoading,
  sharingTargetReady,
  onAccessRoleChange,
  onCancelInvitation,
  onCopyInviteLink,
  onEmailValueChange,
  onInviteByEmail,
  onNearbyShare,
  onRevokeInviteLink,
  onShowNearbyQr,
}: ComposerInviteProjectAccessSectionProps) {
  if (sharingPermissionsLoading) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-400"
        data-testid="composer-invite-permissions-loading"
      >
        <Spinner aria-hidden="true" size="xs" />
        Checking sharing permissions…
      </div>
    );
  }

  if (!canShareProject) {
    return (
      <Text
        as="p"
        variant="caption"
        tone="muted"
        className="text-xs leading-snug"
        data-testid="composer-invite-permission-message"
      >
        {canWriteProject
          ? "You can edit this space, but your role cannot grant access to new people."
          : "You have read-only access and cannot grant access to new people."}
        {canInviteIntoChat && canWriteProject
          ? " You can still add existing teammates to this chat below."
          : ""}
      </Text>
    );
  }

  const pendingInviteCount = pendingInvitations.length;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <Text variant="bodyStrong" tone="primary" className="text-sm">
          Access
        </Text>
        <ComposerInviteRoleToggle
          value={accessRole}
          onChange={onAccessRoleChange}
          viewerLabel="Read"
          builderLabel="Edit"
          testIdPrefix="composer-invite-access-role"
        />
      </div>
      <Text
        as="p"
        variant="caption"
        tone="muted"
        className="text-xs leading-snug"
        data-testid="composer-invite-scope"
      >
        {canInviteIntoChat
          ? "New people get access to this space and this private chat."
          : "New people get access to this space."}
      </Text>
      {!sharingTargetReady ? (
        <Text
          as="p"
          variant="caption"
          tone="muted"
          className="text-xs leading-snug"
          data-testid="composer-invite-sync-message"
        >
          Send the first message before inviting someone to this private chat.
        </Text>
      ) : null}

      <StudioDialogDivider />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Text variant="bodyStrong" tone="primary" className="text-sm">
            Invite link
          </Text>
          <Text variant="caption" tone="muted" className="mt-0.5">
            {activeInviteLink?.role === accessRole
              ? "Ready"
              : currentInviteLink
                ? `Create · replaces ${currentInviteLink.role === "builder" ? "Edit" : "Read"} link`
                : "Create"}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {currentInviteLink ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              radius="full"
              onPress={onRevokeInviteLink}
              isDisabled={inviteLinkRevokePendingId !== null}
              data-testid="composer-invite-revoke-link"
            >
              {inviteLinkRevokePendingId === currentInviteLink.id ? (
                <Spinner aria-hidden="true" tone="primary" size="xs" />
              ) : null}
              Revoke
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            radius="full"
            onPress={onCopyInviteLink}
            isDisabled={
              !sharingTargetReady ||
              copyPendingRole !== null ||
              inviteLinkRevokePendingId !== null
            }
            className="shrink-0"
            data-testid="composer-invite-copy-link"
          >
            {copyPendingRole === accessRole ? (
              <Spinner aria-hidden="true" tone="primary" size="xs" />
            ) : null}
            Copy
          </Button>
        </div>
      </div>

      <StudioDialogDivider />

      <div className="flex items-center justify-between gap-3">
        <Text variant="bodyStrong" tone="primary" className="text-sm">
          QR or share
        </Text>
        <div className="flex items-center gap-2">
          <IconButton
            type="button"
            variant="outline"
            size="sm"
            radius="full"
            onPress={onShowNearbyQr}
            isDisabled={
              !sharingTargetReady ||
              nearbyQrPendingRole !== null ||
              nearbySharePendingRole !== null ||
              inviteLinkRevokePendingId !== null
            }
            className="shrink-0"
            data-testid="composer-invite-nearby-show-qr"
            aria-label={activeNearbyInviteUrl ? "Refresh QR code" : "Show QR code"}
            title={activeNearbyInviteUrl ? "Refresh QR" : "Show QR"}
          >
            {nearbyQrPendingRole === accessRole ? (
              <Spinner aria-hidden="true" tone="primary" size="xs" />
            ) : (
              <QrCode className="h-4 w-4" aria-hidden="true" />
            )}
          </IconButton>
          {nearbyShareAvailable ? (
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onNearbyShare}
              isDisabled={
                !sharingTargetReady ||
                nearbyQrPendingRole !== null ||
                nearbySharePendingRole !== null ||
                inviteLinkRevokePendingId !== null
              }
              className="shrink-0"
              data-testid="composer-invite-nearby-share"
              aria-label="Share invite"
              title="Share invite"
            >
              {nearbySharePendingRole === accessRole ? (
                <Spinner aria-hidden="true" tone="primary" size="xs" />
              ) : (
                <SendDiagonal className="h-4 w-4" aria-hidden="true" />
              )}
            </IconButton>
          ) : null}
        </div>
      </div>

      <StudioDialogDivider />

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Text variant="bodyStrong" tone="primary" className="text-sm">
            Email
          </Text>
          {pendingInviteCount > 0 ? (
            <Text variant="caption" tone="muted">
              {pendingInviteCount} pending
            </Text>
          ) : null}
        </div>
        <Text as="p" variant="caption" tone="muted" className="text-xs leading-snug">
          Prepare a secure link, then send it with your email or share app. Instafy does not send the
          message yet.
        </Text>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            onInviteByEmail();
          }}
        >
          <Input
            ref={emailInputRef}
            value={emailValue}
            onChange={(event) => onEmailValueChange(event.target.value)}
            aria-label="Prepare email invite"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="name@company.com"
            autoComplete="email"
            enterKeyHint="done"
            size="sm"
            radius="xl"
            disabled={!sharingTargetReady || emailInvitePending}
            className="scroll-mb-24"
            data-testid="composer-invite-email-input"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            radius="full"
            isDisabled={!sharingTargetReady || !emailValid || emailInvitePending}
            className="shrink-0"
            data-testid="composer-invite-email-submit"
          >
            {emailInvitePending ? <Spinner aria-hidden="true" tone="primary" size="xs" /> : null}
            {emailInvitePending ? "Preparing…" : "Prepare"}
          </Button>
        </form>
        {preparedEmailInvite ? (
          <div ref={preparedEmailInviteRef} className="scroll-mb-24">
            <PreparedEmailInviteNotice
              invite={preparedEmailInvite}
              testIdPrefix="composer-email-invite"
            />
          </div>
        ) : null}
        <ComposerPendingInvitationList
          invitations={pendingInvitations}
          pendingId={inviteCancelPendingId}
          onCancel={(invitation) => onCancelInvitation(invitation.id, invitation.email)}
        />
      </div>
    </>
  );
}
