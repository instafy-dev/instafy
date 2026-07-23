export const CHAT_MESSAGE_COPY_SELECTOR = "[data-chat-message-copy-root='true']";

export function normalizeChatMessageSelectionText(value: string): string {
  return value.replace(/[\t \n\r]+$/g, "");
}

function closestMessageCopyRoot(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest(CHAT_MESSAGE_COPY_SELECTOR) ?? null;
}

export function sanitizeChatMessageCopyEvent(event: ClipboardEvent): boolean {
  if (event.defaultPrevented || !event.clipboardData) {
    return false;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const selectedText = selection.toString();
  if (!selectedText) {
    return false;
  }

  const anchorRoot = closestMessageCopyRoot(selection.anchorNode);
  const focusRoot = closestMessageCopyRoot(selection.focusNode);
  if (!anchorRoot && !focusRoot) {
    return false;
  }
  if (anchorRoot && focusRoot && anchorRoot !== focusRoot) {
    return false;
  }

  const normalizedText = normalizeChatMessageSelectionText(selectedText);
  if (!normalizedText || normalizedText === selectedText) {
    return false;
  }

  event.preventDefault();
  event.clipboardData.setData("text/plain", normalizedText);
  return true;
}
