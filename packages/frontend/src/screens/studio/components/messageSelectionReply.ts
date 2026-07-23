import type { ChatMessage } from "../types";

export type MessageSelectionReplyAction = "reply" | "summarize" | "explain_more";

export type MessageSelectionReplyContext = {
  kind: "message_selection";
  conversationId: string | null;
  messageId: string;
  action: MessageSelectionReplyAction;
  selectedText: string;
  textStart: number | null;
  textEnd: number | null;
  selectionHash: string;
  sourceContentHash: string;
};

export type CurrentMessageSelection = {
  messageId: string;
  selectedText: string;
};

const MAX_QUOTED_SELECTION_LENGTH = 1200;

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizeSelectedMessageText(value: string): string {
  const normalized = value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!normalized.includes("\n")) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const output: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current) {
      output.push(current);
      current = "";
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushCurrent();
      if (output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }

    const startsStructuredLine = /^([-*]|\d+[.)]|#{1,6}|>)\s+/.test(line);
    const previousLooksComplete = /[.!?:]$/.test(current);
    const nextStartsSentence = /^[A-Z0-9]/.test(line);
    if (!current || startsStructuredLine || (previousLooksComplete && nextStartsSentence)) {
      flushCurrent();
      current = line;
      continue;
    }

    current += /^[,.;:!?)]/.test(line) ? line : ` ${line}`;
  }

  flushCurrent();
  return output.join("\n").trim();
}

function getElementForSelectionNode(node: Node | null): Element | null {
  if (!node) {
    return null;
  }
  return node instanceof Element ? node : node.parentElement;
}

export function getCurrentMessageSelection(): CurrentMessageSelection | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) {
    return null;
  }
  const selectedText = selection.toString().trim();
  if (!selectedText) {
    return null;
  }
  const messageElement =
    Array.from(document.querySelectorAll<HTMLElement>("[data-chat-message-id]")).find((element) => {
      const anchorElement = getElementForSelectionNode(selection.anchorNode);
      const focusElement = getElementForSelectionNode(selection.focusNode);
      return Boolean(
        element.dataset.chatMessageId &&
          anchorElement &&
          focusElement &&
          element.contains(anchorElement) &&
          element.contains(focusElement),
      );
    }) ?? null;
  const messageId = messageElement?.dataset.chatMessageId ?? "";
  if (!messageId) {
    return null;
  }
  return { messageId, selectedText };
}

export function getCurrentSelectedTextForMessage(messageId: string): string | null {
  const selection = getCurrentMessageSelection();
  if (!selection || selection.messageId !== messageId) {
    return null;
  }
  return selection.selectedText;
}

export function shouldAttachPendingReplyContext(
  context: MessageSelectionReplyContext | null,
  message: string,
): context is MessageSelectionReplyContext {
  if (!context) {
    return false;
  }
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(">")) {
    return false;
  }
  return message.includes(context.selectedText.slice(0, Math.min(context.selectedText.length, 96)));
}

export function shouldStageSelectionReplyDraft(action: MessageSelectionReplyAction): boolean {
  return action === "reply";
}

export function buildMessageSelectionReplyContext({
  action,
  conversationId,
  message,
  selectedText,
}: {
  action: MessageSelectionReplyAction;
  conversationId: string | null;
  message: ChatMessage;
  selectedText: string;
}): MessageSelectionReplyContext | null {
  const normalizedSelection = normalizeSelectedMessageText(selectedText);
  if (!normalizedSelection) {
    return null;
  }

  const sourceContent = message.content ?? "";
  const exactStart = sourceContent.indexOf(normalizedSelection);
  const textStart = exactStart >= 0 ? exactStart : null;
  const textEnd = textStart !== null ? textStart + normalizedSelection.length : null;

  return {
    kind: "message_selection",
    conversationId,
    messageId: message.id,
    action,
    selectedText: normalizedSelection,
    textStart,
    textEnd,
    selectionHash: stableTextHash(normalizedSelection),
    sourceContentHash: stableTextHash(sourceContent),
  };
}

export function formatSelectionReplyComposerText({
  context,
  instruction,
}: {
  context: Pick<MessageSelectionReplyContext, "selectedText">;
  instruction?: string | null;
}): string {
  const trimmed = context.selectedText.trim();
  const clipped =
    trimmed.length > MAX_QUOTED_SELECTION_LENGTH
      ? `${trimmed.slice(0, MAX_QUOTED_SELECTION_LENGTH).trimEnd()}...`
      : trimmed;
  const quote = clipped
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const normalizedInstruction = instruction?.trim() ?? "";
  return normalizedInstruction ? `${quote}\n\n${normalizedInstruction}` : `${quote}\n\n`;
}
