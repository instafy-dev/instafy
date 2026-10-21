import { useCallback, useEffect, useState } from "react";
import { Settings } from "iconoir-react";
import { Button } from "../../../components/Button";
import {
  StudioDialogBody,
  StudioDialogDivider,
  StudioDialogHeader,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { MobileFocusDialog } from "../../../components/aria/MobileFocusDialog";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import type { ControllerProjectMember } from "../../../sdk/instafy";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import type { ComposerInviteRole } from "./ComposerInviteAccessControls";
import { ComposerInviteDeviceHandoff } from "./ComposerInviteDeviceHandoff";
import { ComposerInvitePrivateChatSection } from "./ComposerInvitePrivateChatSection";
import { ComposerInviteProjectAccessSection } from "./ComposerInviteProjectAccessSection";
import { ComposerInviteQrModal } from "./ComposerInviteQrModal";
import { useComposerAccessInvites } from "./useComposerAccessInvites";
import { useComposerDeviceHandoff } from "./useComposerDeviceHandoff";

export { buildAuthenticatedDeviceHandoffUrl } from "./useComposerDeviceHandoff";

type ComposerInviteModalProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  mentionableUsers: ControllerProjectMember[];
  inviteParticipantIdSet: Set<string>;
  inviteParticipantBusyUserId: string | null;
  inviteParticipantsLoading: boolean;
  onInviteTeammate: (member: ControllerProjectMember) => Promise<void>;
  activeConversationVisibility: string | null;
  activeConversationControllerId: string | null;
  activeOrgId: string | null;
  activeProjectId: string | null;
  canShareProject: boolean;
  canWriteProject: boolean;
  preparedEmailInvite?: PreparedEmailInvite | null;
  onPreparedEmailInviteConsumed?: (() => void) | null;
  sharingPermissionsLoading: boolean;
  onOpenProjectSettings?: (() => void) | null;
};

type ComposerInviteQrState =
  | { kind: "access"; role: ComposerInviteRole }
  | { kind: "device" }
  | null;

export function ComposerInviteModal({
  isOpen,
  onOpenChange,
  mentionableUsers,
  inviteParticipantIdSet,
  inviteParticipantBusyUserId,
  inviteParticipantsLoading,
  onInviteTeammate,
  activeConversationVisibility,
  activeConversationControllerId,
  activeOrgId,
  activeProjectId,
  canShareProject,
  canWriteProject,
  preparedEmailInvite: requestedPreparedEmailInvite = null,
  onPreparedEmailInviteConsumed = null,
  sharingPermissionsLoading,
  onOpenProjectSettings = null,
}: ComposerInviteModalProps) {
  const isDesktop = useBreakpoint("sm", { freeze: isOpen });
  const [qrState, setQrState] = useState<ComposerInviteQrState>(null);
  const closeQr = useCallback(() => setQrState(null), []);
  const closeAccessQr = useCallback(() => {
    setQrState((current) => (current?.kind === "access" ? null : current));
  }, []);
  const openAccessQr = useCallback((role: ComposerInviteRole) => {
    setQrState({ kind: "access", role });
  }, []);
  const openDeviceQr = useCallback(() => {
    setQrState({ kind: "device" });
  }, []);
  const accessQrRole = qrState?.kind === "access" ? qrState.role : null;
  const deviceHandoff = useComposerDeviceHandoff({
    activeConversationControllerId,
    activeProjectId,
    onOpenQr: openDeviceQr,
  });
  const accessInvites = useComposerAccessInvites({
    accessQrRole,
    activeConversationControllerId,
    activeConversationVisibility,
    activeOrgId,
    activeProjectId,
    canShareProject,
    canWriteProject,
    isOpen,
    nearbyShareAvailable: deviceHandoff.sectionProps.shareAvailable,
    onCloseAccessQr: closeAccessQr,
    onOpenAccessQr: openAccessQr,
    onPreparedEmailInviteConsumed,
    requestedPreparedEmailInvite,
    sharingPermissionsLoading,
  });
  const canInviteIntoChat = activeConversationVisibility === "private";

  useEffect(() => {
    closeQr();
  }, [activeConversationControllerId, activeOrgId, activeProjectId, closeQr]);

  useEffect(() => {
    if (!isOpen) {
      closeQr();
    }
  }, [closeQr, isOpen]);

  const qrRole = qrState?.kind === "device" ? "device" : accessQrRole;
  const qrViewModel =
    qrState?.kind === "device" ? deviceHandoff.qr : accessInvites.qr;

  const body = (
    <StudioDialogBody scrollable={isDesktop} className="studio-dark-scrollbar scroll-pb-24">
      <div className="mx-auto w-full max-w-[24rem] space-y-3.5">
        <section className="space-y-3.5">
          <ComposerInviteDeviceHandoff {...deviceHandoff.sectionProps} />

          <StudioDialogDivider />

          <ComposerInviteProjectAccessSection {...accessInvites.sectionProps} />

          {canInviteIntoChat && canWriteProject ? (
            <>
              <StudioDialogDivider />
              <ComposerInvitePrivateChatSection
                conversationReady={Boolean(activeConversationControllerId)}
                loading={inviteParticipantsLoading}
                members={mentionableUsers}
                participantIdSet={inviteParticipantIdSet}
                busyUserId={inviteParticipantBusyUserId}
                onInvite={(member) => void onInviteTeammate(member)}
              />
            </>
          ) : null}

          {onOpenProjectSettings ? (
            <>
              <StudioDialogDivider />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  preset="inline"
                  onPress={() => {
                    onOpenChange(false);
                    onOpenProjectSettings();
                  }}
                  data-testid="composer-invite-open-settings"
                >
                  Space settings
                  <Settings className="h-4 w-4 text-current" aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </StudioDialogBody>
  );

  return (
    <>
      {/* Keep the originating focus scope and draft mounted under the QR overlay.
          Closing QR restores its trigger; closing Invite then restores its opener. */}
      {isDesktop ? <StudioDialogModal
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        isDismissable
        appearance="dark"
        dialogAriaLabel="Invite"
        data-testid="chat-invite-modal"
        layout="editor"
        gutter="responsive"
        modalStyle={{ maxWidth: "28rem" }}
      >
        <StudioDialogHeader
          title="Invite"
          onClose={() => onOpenChange(false)}
          closeLabel="Close invite modal"
        />

        {body}
      </StudioDialogModal> : (
        <MobileFocusDialog
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          appearance="dark"
          gutter="responsive"
          dialogAriaLabel="Invite"
          dismissLabel="Close invite modal"
          data-testid="chat-invite-modal"
        >
          {body}
        </MobileFocusDialog>
      )}

      <ComposerInviteQrModal
        role={qrRole}
        inviteUrl={qrViewModel.inviteUrl}
        shareAvailable={deviceHandoff.sectionProps.shareAvailable}
        sharePending={qrViewModel.sharePending}
        onClose={closeQr}
        onCopy={qrViewModel.copy}
        onShare={qrViewModel.share}
      />
    </>
  );
}
