export type ComposerEnterAction =
  | "send"
  | "steer"
  | "queue"
  | "stash"
  | "newline"
  | "menu"
  | "ignore";

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

  const commandKey = metaKey || ctrlKey;
  if (commandKey && shiftKey) {
    return "stash";
  }
  if (commandKey) {
    return "queue";
  }
  if (shiftKey || altKey) {
    return "newline";
  }
  return hasActiveMatchingAgent ? "steer" : "send";
}
