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

export type MessageStashRestoreBlock = "attachments" | "composer_text" | null;

export function resolveMessageStashRestoreBlock({
  composerText,
  attachmentCount,
}: {
  composerText: string;
  attachmentCount: number;
}): MessageStashRestoreBlock {
  if (attachmentCount > 0) {
    return "attachments";
  }
  return composerText.trim().length > 0 ? "composer_text" : null;
}
