import { useCallback, useState } from "react";
import { replaceUserMentionsWithPlainText, type UserMentionToken } from "../../../conversations/userMentions";
import type { ControllerConversationParticipant } from "../../../services/runtimeController/conversations";
import type { StatusIntent } from "../../../status/useStatus";
import type { BrowserSessionPageTarget } from "./browserSessionPages";
import {
  buildBrowserSessionTargetedMessage,
  buildNewBrowserSessionMessage,
} from "./browserSessionPages";
import type { ChatSubmitDispatchPayload } from "./useChatSubmitDispatch";

export type PendingConversationInvitePrompt = {
  conversationId: string | null;
  controllerId: string;
  message: string;
  editorState: string | null;
  missingUsers: UserMentionToken[];
  imageFiles: File[];
  browserPageTarget: BrowserSessionPageTarget | null;
  browserLaunchMode: "new_page" | null;
  expectedLaneIdle: boolean;
};

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

type UseChatInvitePromptHandlersOptions = {
  addConversationParticipant: (input: {
    conversationId: string;
    userId: string;
    role: "member";
    accessToken: null;
  }) => Promise<ControllerConversationParticipant[] | null>;
  performSubmit: (payload: ChatSubmitDispatchPayload) => Promise<void>;
  showStatus: ShowStatus;
};

function resolveInvitePromptDispatchMessage(prompt: PendingConversationInvitePrompt, message: string) {
  if (prompt.browserLaunchMode === "new_page") {
    return buildNewBrowserSessionMessage(message);
  }
  if (prompt.browserPageTarget) {
    return buildBrowserSessionTargetedMessage(message, prompt.browserPageTarget);
  }
  return message;
}

export function useChatInvitePromptHandlers({
  addConversationParticipant,
  performSubmit,
  showStatus,
}: UseChatInvitePromptHandlersOptions) {
  const [invitePrompt, setInvitePrompt] = useState<PendingConversationInvitePrompt | null>(null);
  const [invitePromptBusy, setInvitePromptBusy] = useState(false);

  const handleInvitePromptClose = useCallback(() => {
    setInvitePrompt(null);
    setInvitePromptBusy(false);
  }, []);

  const handleInvitePromptSendWithout = useCallback(async () => {
    if (!invitePrompt) {
      return;
    }
    const includeIds = new Set(invitePrompt.missingUsers.map((user) => user.userId));
    const transformed = replaceUserMentionsWithPlainText(invitePrompt.editorState, {
      includeUserIds: includeIds,
    });
    const message = transformed.text.trim();
    if (!message) {
      showStatus("Message can't be empty.", "error", 3000);
      handleInvitePromptClose();
      return;
    }
    const dispatchedMessage = resolveInvitePromptDispatchMessage(invitePrompt, message);
    handleInvitePromptClose();
    await performSubmit({
      message: dispatchedMessage,
      composerMessage: invitePrompt.message,
      editorState: transformed.editorState,
      imageFiles: invitePrompt.imageFiles,
      expectedLaneIdle: invitePrompt.expectedLaneIdle,
    });
  }, [handleInvitePromptClose, invitePrompt, performSubmit, showStatus]);

  const handleInvitePromptInviteAndSend = useCallback(async () => {
    if (!invitePrompt || invitePromptBusy) {
      return;
    }
    setInvitePromptBusy(true);
    try {
      const uniqueUserIds = Array.from(new Set(invitePrompt.missingUsers.map((user) => user.userId)));
      const results = await Promise.all(
        uniqueUserIds.map((userId) =>
          addConversationParticipant({
            conversationId: invitePrompt.controllerId,
            userId,
            role: "member",
            accessToken: null,
          }),
        ),
      );
      if (results.some((result) => result === null)) {
        showStatus("Couldn't add everyone to this chat. Try again.", "error", 4000);
        return;
      }
      const message = invitePrompt.message.trim();
      if (!message) {
        handleInvitePromptClose();
        return;
      }
      handleInvitePromptClose();
      await performSubmit({
        message: resolveInvitePromptDispatchMessage(invitePrompt, message),
        composerMessage: invitePrompt.message,
        editorState: invitePrompt.editorState ?? null,
        imageFiles: invitePrompt.imageFiles ?? [],
        expectedLaneIdle: invitePrompt.expectedLaneIdle,
      });
    } finally {
      setInvitePromptBusy(false);
    }
  }, [
    addConversationParticipant,
    handleInvitePromptClose,
    invitePrompt,
    invitePromptBusy,
    performSubmit,
    showStatus,
  ]);

  return {
    handleInvitePromptClose,
    handleInvitePromptInviteAndSend,
    handleInvitePromptSendWithout,
    invitePrompt,
    invitePromptBusy,
    openInvitePrompt: setInvitePrompt,
  };
}
