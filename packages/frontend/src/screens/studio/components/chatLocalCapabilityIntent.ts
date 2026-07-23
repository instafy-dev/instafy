import { resolveSingleLocalCapabilityHandleForPrompt } from "../../../capabilities/localCapabilityRuntime";
import { parseTerminalCommandRequest } from "../../../conversations/terminalCommand";
import type { ChatMessage } from "../types";

export function resolveChatLocalCapabilityHandle({
  activeConversationMessages,
  prompt,
  targetHandles,
}: {
  activeConversationMessages: ChatMessage[];
  prompt: string;
  targetHandles: Iterable<string>;
}) {
  if (parseTerminalCommandRequest(prompt)) {
    return null;
  }

  return resolveSingleLocalCapabilityHandleForPrompt({
    targetHandles,
    prompt,
    conversationMessages: activeConversationMessages,
  });
}
