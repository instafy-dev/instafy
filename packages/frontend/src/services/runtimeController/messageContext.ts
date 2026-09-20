import { messageContextPath, type ControllerMessageContextPage } from "@instafy/sdk/conversation-search";
import type { ControllerConversationMessage } from "./conversations";
import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";
import { createControllerReadBudget } from "./readBudget";

export type MessageContextPage = ControllerMessageContextPage<ControllerConversationMessage>;
export class MessageContextUnavailableError extends Error {
  constructor(message: string, readonly accessDenied = false) { super(message); }
}

/** Read through the current authenticated controller binding, with one cancellable budget. */
export async function fetchMessageContext({ projectId, conversationId, messageId, before = 20, after = 20, signal }: {
  projectId: string;
  conversationId: string;
  messageId: string;
  before?: number;
  after?: number;
  signal: AbortSignal;
}): Promise<MessageContextPage> {
  if (!runtimeControllerEnabled) throw new Error("Message history is unavailable.");
  const budget = createControllerReadBudget(signal);
  try {
    const context = await budget.wait(() => resolveControllerRequestContext(null));
    if (!context.accessToken) throw new Error("Sign in to load this message.");
    const response = await budget.wait(() => fetch(
      `${context.baseUrl}${messageContextPath({ conversationId, messageId, before, after })}`,
      { headers: { authorization: `Bearer ${context.accessToken}` }, signal: budget.signal },
    ));
    if (response.status === 403 || response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      throw new MessageContextUnavailableError("This message is unavailable or you no longer have access.", response.status === 403);
    }
    if (!response.ok) {
      // Preserve the existing 401 recovery side effect without exposing response bodies in the UI.
      await budget.wait(() => readControllerError(response, "Unable to load this message.", context));
      throw new Error("Unable to load this message. Try again.");
    }
    const page = await budget.wait<MessageContextPage>(() => response.json());
    if (!page || page.anchorMessageId !== messageId || !Array.isArray(page.messages) ||
      !page.messages.some((message) => message.id === messageId) ||
      page.messages.some((message) => message.projectId !== projectId || message.conversationId !== conversationId) ||
      typeof page.hasOlder !== "boolean" || typeof page.hasNewer !== "boolean" ||
      (page.hasOlder && page.olderCursor !== page.messages.at(-1)?.id) ||
      (page.hasNewer && page.newerCursor !== page.messages[0]?.id)) {
      throw new Error("Unable to read this message's history.");
    }
    return page;
  } finally {
    budget.dispose();
  }
}
