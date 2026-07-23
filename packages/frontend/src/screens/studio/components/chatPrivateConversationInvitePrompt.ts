import { extractUserMentionTokensFromEditorState } from "../../../conversations/userMentions";
import type { ControllerConversationParticipant } from "../../../services/runtimeController/conversations";
import type { BrowserSessionPageTarget } from "./browserSessionPages";
import type { PendingConversationInvitePrompt } from "./useChatInvitePromptHandlers";

type ResolvePrivateConversationInvitePromptOptions = {
  activeConversationId: string | null;
  browserLaunchMode: "new_page" | null;
  browserPageTarget: BrowserSessionPageTarget | null;
  controllerId: string | null;
  editorState: string | null;
  imageFiles: File[];
  isPrivateConversation: boolean;
  listConversationParticipants: (input: {
    conversationId: string;
    accessToken: null;
  }) => Promise<ControllerConversationParticipant[] | null>;
  message: string;
};

export async function resolvePrivateConversationInvitePrompt({
  activeConversationId,
  browserLaunchMode,
  browserPageTarget,
  controllerId,
  editorState,
  imageFiles,
  isPrivateConversation,
  listConversationParticipants,
  message,
}: ResolvePrivateConversationInvitePromptOptions): Promise<PendingConversationInvitePrompt | null> {
  if (!isPrivateConversation || !controllerId) {
    return null;
  }

  const userMentions = extractUserMentionTokensFromEditorState(editorState);
  if (userMentions.length === 0) {
    return null;
  }

  const participants = await listConversationParticipants({
    conversationId: controllerId,
    accessToken: null,
  });
  if (!participants) {
    return null;
  }

  const participantIds = new Set(participants.map((participant) => participant.userId));
  const missingUsers = userMentions.filter((mention) => !participantIds.has(mention.userId));
  if (missingUsers.length === 0) {
    return null;
  }

  return {
    conversationId: activeConversationId,
    controllerId,
    message,
    editorState,
    missingUsers,
    imageFiles,
    browserPageTarget,
    browserLaunchMode,
  };
}
