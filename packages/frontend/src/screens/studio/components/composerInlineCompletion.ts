const COMPOSER_INLINE_COMPLETION_MIN_CHARS = 3;
const COMPOSER_INLINE_COMPLETION_PATH_PREFIX = ".instafy/chat";
const COMPOSER_INLINE_BRIDGE_PUNCTUATION_PATTERN = /[.!?]$/;
const COMPOSER_INLINE_REMAINDER_WORD_START_PATTERN = /^[A-Za-z0-9"'([{]/;
export const COMPOSER_INLINE_COMPLETION_DEBOUNCE_MS = 80;

export function buildComposerInlineCompletionPath(
  conversationId: string | null | undefined,
): string {
  const normalizedConversationId =
    typeof conversationId === "string"
      ? conversationId.trim().replace(/[^a-z0-9_-]+/gi, "-")
      : "";
  return `${COMPOSER_INLINE_COMPLETION_PATH_PREFIX}/${normalizedConversationId || "composer"}.md`;
}

export function shouldRequestComposerInlineCompletion(params: {
  projectId: string | null;
  inputValue: string;
  anyAgentsEnabled: boolean;
  credentialsReady: boolean;
  hasImageAttachments: boolean;
  onboardingInputLocked: boolean;
  sendingAttachment: boolean;
}): boolean {
  if (!params.projectId || !params.anyAgentsEnabled || !params.credentialsReady) {
    return false;
  }
  if (params.hasImageAttachments || params.onboardingInputLocked || params.sendingAttachment) {
    return false;
  }

  const normalizedInput = params.inputValue.replace(/\r/g, "");
  if (normalizedInput.includes("\n")) {
    return false;
  }
  if (normalizedInput.trim().length < COMPOSER_INLINE_COMPLETION_MIN_CHARS) {
    return false;
  }
  if (normalizedInput.trimStart().startsWith("/")) {
    return false;
  }

  return true;
}

export function buildComposerInlineSuggestion(
  inputValue: string,
  completion: string | null | undefined,
): string | null {
  if (typeof completion !== "string" || completion.length === 0) {
    return null;
  }
  const normalizedInput = inputValue.replace(/\r/g, "");
  const normalizedCompletion = normalizeComposerCompletionTail(normalizedInput, completion);
  if (normalizedCompletion.length === 0) {
    return null;
  }
  return `${normalizedInput}${normalizedCompletion}`;
}

export function normalizeComposerCompletionTail(inputValue: string, completion: string): string {
  if (completion.length === 0) {
    return "";
  }
  if (/^\s/.test(completion)) {
    return completion;
  }
  if (!COMPOSER_INLINE_BRIDGE_PUNCTUATION_PATTERN.test(inputValue)) {
    return completion;
  }
  if (!COMPOSER_INLINE_REMAINDER_WORD_START_PATTERN.test(completion)) {
    return completion;
  }
  return ` ${completion}`;
}
