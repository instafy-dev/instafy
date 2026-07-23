import { useCallback, useEffect, useState } from "react";
import { Settings } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import {
  StudioDialogBody,
  StudioDialogDivider,
  StudioDialogHeader,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
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

  const handleNativeBack = useCallback(() => {
    if (qrState) {
      closeQr();
      return;
    }
    onOpenChange(false);
  }, [closeQr, onOpenChange, qrState]);
  useNativeBackButtonAction(isOpen, handleNativeBack);

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

  return (
    <>
      <StudioDialogModal
        isOpen={isOpen && qrState === null}
        onOpenChange={onOpenChange}
        isDismissable
        appearance="dark"
        dialogAriaLabel="Invite"
        data-testid="chat-invite-modal"
        modalStyle={{
          maxHeight:
            "calc(100dvh - max(var(--instafy-safe-area-inset-top), 1rem) - max(var(--instafy-safe-area-inset-bottom), 1rem))",
        }}
        modalClassName="flex min-h-0 max-h-full max-w-md flex-col overflow-hidden rounded-[1.6rem] border p-0 shadow-modal"
        dialogClassName="flex min-h-0 flex-1 flex-col"
      >
        <StudioDialogHeader
          title="Invite"
          onClose={() => onOpenChange(false)}
          closeLabel="Close invite modal"
          className="border-[rgba(255,255,255,0.08)]"
          titleClassName="text-slate-50"
        />

        <StudioDialogBody className="studio-dark-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain scroll-pb-24 pt-3">
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
                      size="sm"
                      radius="full"
                      onPress={() => {
                        onOpenChange(false);
                        onOpenProjectSettings();
                      }}
                      className="gap-2"
                      data-testid="composer-invite-open-settings"
                    >
                      <Text as="span" variant="bodyStrong" tone="inherit" className="text-sm">
                        Space settings
                      </Text>
                      <Settings className="h-4 w-4 text-current" aria-hidden="true" />
                    </Button>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        </StudioDialogBody>
      </StudioDialogModal>

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
