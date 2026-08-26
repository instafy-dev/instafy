import {
  type ResolvedPromptAgentSelection,
  startsWithAssistantMention,
} from "../../../conversations/assistantMentions";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import { parseTerminalCommandRequest } from "../../../conversations/terminalCommand";
import type { ChatMessage } from "../types";
import {
  buildBrowserSessionTargetedMessage,
  buildNewBrowserSessionMessage,
  shouldAutoTargetBrowserSessionMessage,
  toBrowserSessionPageTarget,
  type BrowserSessionPage,
  type BrowserSessionPageTarget,
} from "./browserSessionPages";
import { resolveChatLocalCapabilityHandle } from "./chatLocalCapabilityIntent";

export type ChatSubmitOverride = {
  message: string;
  editorState: string | null;
  targetAgentHandles?: string[];
  browserPageTarget?: BrowserSessionPageTarget | null;
  browserLaunchMode?: "new_page" | null;
  metadata?: Record<string, unknown> | null;
  runtimeOverride?: SubmitConversationRuntimeOverride | null;
};

type BuildChatSubmitPlanOptions = {
  activeConversationMessages: ChatMessage[];
  browserTargetingEnabled: boolean;
  browserSessionOpen: boolean;
  hasHiddenBrowserSession: boolean;
  imageAttachmentCount: number;
  inputValue: string;
  override?: ChatSubmitOverride;
  pendingBrowserLaunchMode: "new_page" | null;
  preferredBrowserPage: BrowserSessionPage | null;
  resolvePromptAgentTargets: (
    prompt: string,
    options?: {
      useSticky?: boolean;
      updateSticky?: boolean;
    },
  ) => ResolvedPromptAgentSelection;
  softPrefillSuggestion: string | null | undefined;
};

export type ChatSubmitPlan = {
  agentSelection: ResolvedPromptAgentSelection;
  browserLaunchMode: "new_page" | null;
  browserPageTarget: BrowserSessionPageTarget | null;
  dispatchedMessage: string;
  messageRequiresAi: boolean;
  messageRequiresRuntime: boolean;
  messageToSend: string;
  shouldApplyBrowserPageTarget: boolean;
  shouldApplyNewBrowserLaunch: boolean;
  shouldConsumeNewBrowserLaunch: boolean;
  terminalRequest: ReturnType<typeof parseTerminalCommandRequest>;
  trimmed: string;
};

export function buildChatSubmitPlan({
  activeConversationMessages,
  browserTargetingEnabled,
  browserSessionOpen,
  hasHiddenBrowserSession,
  imageAttachmentCount,
  inputValue,
  override,
  pendingBrowserLaunchMode,
  preferredBrowserPage,
  resolvePromptAgentTargets,
  softPrefillSuggestion,
}: BuildChatSubmitPlanOptions): ChatSubmitPlan {
  const trimmed = override ? override.message.trim() : inputValue.trim();
  const fallback = override ? "" : (softPrefillSuggestion ?? "").trim();
  const messageToSend =
    trimmed || (!trimmed && !override && imageAttachmentCount === 0 ? fallback : "");
  const browserLaunchMode = browserTargetingEnabled
    ? (override?.browserLaunchMode ?? pendingBrowserLaunchMode)
    : null;
  const autoBrowserPageTarget =
    browserSessionOpen || hasHiddenBrowserSession
      ? preferredBrowserPage
        ? toBrowserSessionPageTarget(preferredBrowserPage)
        : null
      : null;
  const browserPageTarget = browserTargetingEnabled
    ? (override?.browserPageTarget ?? autoBrowserPageTarget)
    : null;
  const canApplyBrowserPageTarget =
    Boolean(browserPageTarget) &&
    !messageToSend.trimStart().startsWith("/") &&
    shouldAutoTargetBrowserSessionMessage(messageToSend);

  const aiOverride = startsWithAssistantMention(messageToSend);
  const resolvedAgentSelection = resolvePromptAgentTargets(messageToSend, {
    useSticky: true,
    updateSticky: true,
  });
  const overrideTargetAgentHandles = override?.targetAgentHandles
    ?.map((handle) => handle.trim().replace(/^@+/, "").toLowerCase())
    .filter((handle, index, all) => handle.length > 0 && all.indexOf(handle) === index);
  const agentSelection = overrideTargetAgentHandles
    ? { ...resolvedAgentSelection, targetHandles: overrideTargetAgentHandles }
    : resolvedAgentSelection;
  const hasMentionedAgent = agentSelection.explicitMentionedHandles.length > 0;
  const hasAgentTarget = agentSelection.targetHandles.length > 0;
  const terminalRequest = parseTerminalCommandRequest(messageToSend);
  const localBuiltInCapabilityHandle = resolveChatLocalCapabilityHandle({
    activeConversationMessages,
    targetHandles: agentSelection.targetHandles,
    prompt: messageToSend,
  });
  const shouldDispatchLocalCapability = Boolean(localBuiltInCapabilityHandle);
  const messageRequiresRuntime =
    imageAttachmentCount > 0 ||
    ((!shouldDispatchLocalCapability && hasAgentTarget) ||
      (!shouldDispatchLocalCapability && aiOverride) ||
      (!shouldDispatchLocalCapability && hasMentionedAgent)) ||
    Boolean(terminalRequest);
  const messageRequiresAi =
    !shouldDispatchLocalCapability && (hasAgentTarget || aiOverride || hasMentionedAgent);
  const shouldApplyBrowserPageTarget =
    canApplyBrowserPageTarget && messageRequiresAi && browserLaunchMode !== "new_page";
  const shouldApplyNewBrowserLaunch =
    browserLaunchMode === "new_page" &&
    messageRequiresAi &&
    !messageToSend.trimStart().startsWith("/");
  const dispatchedMessage = shouldApplyNewBrowserLaunch
    ? buildNewBrowserSessionMessage(messageToSend)
    : shouldApplyBrowserPageTarget && browserPageTarget
      ? buildBrowserSessionTargetedMessage(messageToSend, browserPageTarget)
      : messageToSend;
  const shouldConsumeNewBrowserLaunch = !override?.browserLaunchMode && shouldApplyNewBrowserLaunch;

  return {
    agentSelection,
    browserLaunchMode,
    browserPageTarget,
    dispatchedMessage,
    messageRequiresAi,
    messageRequiresRuntime,
    messageToSend,
    shouldApplyBrowserPageTarget,
    shouldApplyNewBrowserLaunch,
    shouldConsumeNewBrowserLaunch,
    terminalRequest,
    trimmed,
  };
}
