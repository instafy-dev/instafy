export function shouldDeleteRestoredMessageStashAfterAction({
  submitted,
  action,
}: {
  submitted: boolean;
  action: "send" | "queue" | "steer";
}): boolean {
  if (!submitted) {
    return false;
  }
  return action === "send" || action === "queue" || action === "steer";
}

export type ComposerDraftReplaceBlock = "attachments" | "composer_text" | null;

export function resolveComposerDraftReplaceBlock({
  composerText,
  attachmentCount,
}: {
  composerText: string;
  attachmentCount: number;
}): ComposerDraftReplaceBlock {
  if (attachmentCount > 0) {
    return "attachments";
  }
  return composerText.trim().length > 0 ? "composer_text" : null;
}

export const resolveMessageStashRestoreBlock = resolveComposerDraftReplaceBlock;
