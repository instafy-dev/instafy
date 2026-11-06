import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";

type InvitePrompt = {
  missingUsers: Array<{
    displayName?: string | null;
    handle?: string | null;
  }>;
};

export function ChatInvitePromptOverlay({
  invitePrompt,
  invitePromptBusy,
  onClose,
  onSendWithout,
  onInviteAndSend,
}: {
  invitePrompt: InvitePrompt | null;
  invitePromptBusy: boolean;
  onClose: () => void;
  onSendWithout: () => void;
  onInviteAndSend: () => void;
}) {
  if (!invitePrompt) return null;

  const close = () => { if (!invitePromptBusy) onClose(); };
  const names = invitePrompt.missingUsers.map((user) => user.displayName || user.handle || "Teammate").join(", ");

  return (
    <StudioDialogModal
      isOpen
      isDismissable={!invitePromptBusy}
      isKeyboardDismissDisabled={invitePromptBusy}
      onOpenChange={(open) => { if (!open) close(); }}
      size="sm"
      layout="editor"
      gutter="responsive"
      dialogAriaLabel="Invite teammate"
      data-testid="chat-invite-prompt"
    >
      <StudioDialogBody scrollable padding="none">
        <StudioDialogHeader
          title="Add to this private chat?"
          wrapTitle
          onClose={close}
          closeLabel="Cancel invitation"
          closeButtonDisabled={invitePromptBusy}
        />
        <StudioDialogBody>
          <Text className="break-words">
            {invitePrompt.missingUsers.length === 1 ? (
              <><Text as="span" variant="bodyStrong" tone="inherit">{names}</Text> can’t see this conversation yet.</>
            ) : (
              <>These teammates can’t see this conversation yet: <Text as="span" variant="bodyStrong" tone="inherit">{names}</Text>.</>
            )}
          </Text>
        </StudioDialogBody>
      </StudioDialogBody>
      <StudioDialogFooter padding="default" divider className="flex flex-wrap items-center justify-end gap-2">
        <Button
          preset="form"
          variant="ghost"
          isDisabled={invitePromptBusy}
          onPress={() => { if (!invitePromptBusy) onSendWithout(); }}
        >
          Send without @
        </Button>
        <Button
          preset="form"
          variant="primary"
          isPending={invitePromptBusy}
          pendingLabel="beside"
          onPress={() => { if (!invitePromptBusy) onInviteAndSend(); }}
        >
          {invitePromptBusy ? "Inviting…" : "Invite & send"}
        </Button>
      </StudioDialogFooter>
    </StudioDialogModal>
  );
}
