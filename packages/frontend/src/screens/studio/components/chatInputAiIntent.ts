import { startsWithAssistantMention } from "../../../conversations/assistantMentions";
import { shouldResolveAmbientGroupParticipation } from "../../../conversations/groupParticipation";
import { parseInviteCommandRequest } from "../../../conversations/inviteCommand";
import { extractExplicitGithubRepoReference } from "../../../services/runtimeController/githubImportPath";
import type { ChatMessage } from "../types";
import { shouldAutoTargetBrowserSessionMessage } from "./browserSessionPages";
import { resolveChatLocalCapabilityHandle } from "./chatLocalCapabilityIntent";

type PromptAgentSelectionLike = {
  targetHandles: string[];
  explicitMentionedHandles: string[];
};

type AmbientPromptAgentSelectionLike = PromptAgentSelectionLike & {
  activeHandles: string[];
  usesDefaultAssistantOnly: boolean;
};

function resolveEffectiveChatInputText({
  inputValue,
  hasImageAttachments,
  fallbackSuggestion,
}: {
  inputValue: string;
  hasImageAttachments: boolean;
  fallbackSuggestion: string | null | undefined;
}): string {
  const trimmed = inputValue.trim();
  const fallback = !trimmed && !hasImageAttachments ? (fallbackSuggestion ?? "").trim() : "";
  return trimmed || fallback;
}

export function resolveChatInputRequiresAi({
  activeConversationMessages,
  inputValue,
  hasImageAttachments,
  fallbackSuggestion,
  resolvePromptAgentTargets,
}: {
  activeConversationMessages: ChatMessage[];
  inputValue: string;
  hasImageAttachments: boolean;
  fallbackSuggestion: string | null | undefined;
  resolvePromptAgentTargets: (
    prompt: string,
    options: { useSticky: boolean },
  ) => PromptAgentSelectionLike;
}): boolean {
  const effectiveText = resolveEffectiveChatInputText({
    inputValue,
    hasImageAttachments,
    fallbackSuggestion,
  });
  if (!effectiveText && !hasImageAttachments) {
    return false;
  }
  // These commands are completed by the local/controller preflight before an
  // agent dispatch. Keep Send available for a brand-new teammate who has not
  // connected AI yet; the preflight can then import/invite or show its own
  // validation error without ever consuming an AI credential.
  if (
    parseInviteCommandRequest(effectiveText) ||
    extractExplicitGithubRepoReference(effectiveText)
  ) {
    return false;
  }
  const aiOverride = startsWithAssistantMention(effectiveText);
  const selection = resolvePromptAgentTargets(effectiveText, { useSticky: true });
  const localBuiltInCapabilityHandle = resolveChatLocalCapabilityHandle({
    activeConversationMessages,
    targetHandles: selection.targetHandles,
    prompt: effectiveText,
  });
  if (localBuiltInCapabilityHandle) {
    return false;
  }
  return (
    selection.targetHandles.length > 0 ||
    aiOverride ||
    selection.explicitMentionedHandles.length > 0
  );
}

export function resolveChatInputHasBrowserTask({
  inputValue,
  hasImageAttachments,
  fallbackSuggestion,
  personalBrowserActive,
  sharedBrowserModeActive,
  pendingNewBrowser,
  sharedBrowserPageTargetAvailable,
}: {
  inputValue: string;
  hasImageAttachments: boolean;
  fallbackSuggestion: string | null | undefined;
  personalBrowserActive: boolean;
  sharedBrowserModeActive: boolean;
  pendingNewBrowser: boolean;
  sharedBrowserPageTargetAvailable: boolean;
}): boolean {
  const effectiveText = resolveEffectiveChatInputText({
    inputValue,
    hasImageAttachments,
    fallbackSuggestion,
  });
  return (
    personalBrowserActive ||
    sharedBrowserModeActive ||
    pendingNewBrowser ||
    (sharedBrowserPageTargetAvailable &&
      shouldAutoTargetBrowserSessionMessage(effectiveText))
  );
}

/**
 * The final participation decision is asynchronous. This identifies only the
 * narrow ambient/default-Octo case that is allowed to reach that decision
 * before applying the sender's AI credential and credit gates.
 */
export function resolveChatInputCanRunAmbientParticipationPreflight({
  inputValue,
  hasImageAttachments,
  fallbackSuggestion,
  activeConversationControllerId,
  conversationHasHumanPeer,
  assistantEnabled,
  threadKind,
  ownerAgentHandle,
  hasBrowserTask,
  replyToOcto,
  defaultAssistantHandle,
  resolvePromptAgentTargets,
}: {
  inputValue: string;
  hasImageAttachments: boolean;
  fallbackSuggestion: string | null | undefined;
  activeConversationControllerId: string | null;
  conversationHasHumanPeer: boolean;
  assistantEnabled: boolean;
  threadKind: string | null | undefined;
  ownerAgentHandle: string | null | undefined;
  hasBrowserTask: boolean;
  replyToOcto: boolean;
  defaultAssistantHandle: string;
  resolvePromptAgentTargets: (
    prompt: string,
    options: { useSticky: boolean },
  ) => AmbientPromptAgentSelectionLike;
}): boolean {
  if (
    !activeConversationControllerId ||
    !conversationHasHumanPeer ||
    hasImageAttachments
  ) {
    return false;
  }
  const effectiveText = resolveEffectiveChatInputText({
    inputValue,
    hasImageAttachments,
    fallbackSuggestion,
  });
  if (
    !effectiveText ||
    effectiveText.trimStart().startsWith("/") ||
    parseInviteCommandRequest(effectiveText) ||
    extractExplicitGithubRepoReference(effectiveText)
  ) {
    return false;
  }

  const selection = resolvePromptAgentTargets(effectiveText, { useSticky: true });
  return shouldResolveAmbientGroupParticipation({
    assistantEnabled,
    usesDefaultAssistantOnly: selection.usesDefaultAssistantOnly,
    activeHandles: selection.activeHandles,
    targetHandles: selection.targetHandles,
    explicitMentionedHandles: selection.explicitMentionedHandles,
    defaultAssistantHandle,
    threadKind,
    ownerAgentHandle,
    hasTerminalCommand: false,
    hasBrowserTask,
    hasExplicitAssistantOverride: startsWithAssistantMention(effectiveText),
    replyToOcto,
    isAmbientTurn: true,
  });
}
