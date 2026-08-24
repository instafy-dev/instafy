export type ComposerEnterAction =
  | "send"
  | "steer"
  | "queue"
  | "stash"
  | "newline"
  | "menu"
  | "ignore";

export type ComposerSendModifierAction = "queue" | "stash" | null;

export type ComposerSendModifierKeys = {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export function resolveComposerSendModifierAction({
  shiftKey,
  metaKey,
  ctrlKey,
  altKey,
}: ComposerSendModifierKeys): ComposerSendModifierAction {
  // Alt is a text-entry modifier, including Ctrl+Alt/AltGraph on
  // international layouts. It must never preview or execute a send mode.
  if (altKey || (!metaKey && !ctrlKey)) {
    return null;
  }
  return shiftKey ? "stash" : "queue";
}

export type ResolveComposerEnterActionInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  hasOpenMenu: boolean;
  hasActiveMatchingAgent: boolean;
};

/**
 * Resolves the composer's one-shot Enter action without consulting editor
 * contents. Multiline drafts use the same shortcuts as single-line drafts;
 * Shift+Enter is the deliberate newline gesture.
 */
export function resolveComposerEnterAction({
  key,
  shiftKey,
  metaKey,
  ctrlKey,
  altKey,
  isComposing,
  hasOpenMenu,
  hasActiveMatchingAgent,
}: ResolveComposerEnterActionInput): ComposerEnterAction {
  if (key !== "Enter" || isComposing) {
    return "ignore";
  }
  if (hasOpenMenu) {
    return "menu";
  }

  const sendModifierAction = resolveComposerSendModifierAction({
    shiftKey,
    metaKey,
    ctrlKey,
    altKey,
  });
  if (sendModifierAction) {
    return sendModifierAction;
  }
  if (shiftKey || altKey) {
    return "newline";
  }
  return hasActiveMatchingAgent ? "steer" : "send";
}
