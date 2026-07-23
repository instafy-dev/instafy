import { useCallback, useMemo } from "react";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import type { QueuedChatPrompt } from "./ChatSendQueue";
import { buildCollapsedQueuedMessageSummary } from "./chatSendQueueSummary";
import type { QueuedChatSendItem } from "./chatSendQueueStorage";
import { isServerQueuedChatSendItem } from "./useChatServerSendQueue";

type AgentProfileLike = {
  handle?: string | null;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
  displayName?: string | null;
};

type QueueStatusAction = {
  label: string;
  disabled: boolean;
  pending: boolean;
};

type QueueSummaryItem = {
  handle: string;
  count: number;
  avatarImageSrc: string | null;
  avatarText: string;
  avatarGradient: string;
};

export function useChatSendQueuePresentation({
  activeConversationControllerId,
  activeConversationRun,
  agentByHandle,
  chatSendQueue,
  currentRuntime,
  hostedRuntimeEnsuring,
  isAssistantTyping,
  resolvePromptAgentTargets,
  runtimeControllerEnabled,
  runtimeEnsureError,
  runtimeReady,
  sendingAttachment,
  waitingForPreferredRuntime,
}: {
  activeConversationControllerId: string | null;
  activeConversationRun: unknown;
  agentByHandle: Map<string, AgentProfileLike>;
  chatSendQueue: QueuedChatSendItem[];
  currentRuntime: { isLikelyLocal?: boolean | null } | null;
  hostedRuntimeEnsuring: boolean;
  isAssistantTyping: boolean;
  resolvePromptAgentTargets: (
    input: string,
    options: { useSticky: boolean; updateSticky?: boolean },
  ) => { targetHandles: string[] };
  runtimeControllerEnabled: boolean;
  runtimeEnsureError: string | null;
  runtimeReady: boolean;
  sendingAttachment: boolean;
  waitingForPreferredRuntime: boolean;
}) {
  const resolveQueuedItemTargets = useCallback(
    (item: QueuedChatSendItem): string[] => {
      if (item.targetAgentHandles.length > 0) {
        return item.targetAgentHandles;
      }
      return resolvePromptAgentTargets(item.message, { useSticky: false }).targetHandles;
    },
    [resolvePromptAgentTargets],
  );

  const queuedTargetHandlesByItemId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of chatSendQueue) {
      map.set(item.id, resolveQueuedItemTargets(item));
    }
    return map;
  }, [chatSendQueue, resolveQueuedItemTargets]);

  const queuedByAgentHandle = useMemo(() => {
    const map = new Map<string, number>();
    for (const handles of queuedTargetHandlesByItemId.values()) {
      for (const handle of handles) {
        map.set(handle, (map.get(handle) ?? 0) + 1);
      }
    }
    return map;
  }, [queuedTargetHandlesByItemId]);

  const chatSendQueueDisplay = useMemo<QueuedChatPrompt[]>(() => {
    return chatSendQueue.map((item) => ({
      id: item.id,
      message: item.message,
      targetHandles: queuedTargetHandlesByItemId.get(item.id) ?? [],
      browserTargetLabel:
        item.browserPageTarget?.label ?? (item.browserLaunchMode === "new_page" ? "Another site" : null),
      errorMessage:
        isServerQueuedChatSendItem(item) && item.status === "failed"
          ? item.errorMessage ?? "Send failed. Use send now to retry, or remove it."
          : null,
    }));
  }, [chatSendQueue, queuedTargetHandlesByItemId]);

  const queuedSummaryItems = useMemo<QueueSummaryItem[]>(() => {
    return Array.from(queuedByAgentHandle.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([handle, count]) => {
        const profile = agentByHandle.get(handle) ?? null;
        const avatarImageSrc = resolveAgentAvatarImageSrc(profile ?? { handle, avatarSeed: handle });
        const avatarText = resolveAgentAvatarText({
          handle: profile?.handle ?? handle,
          displayName: profile?.displayName ?? null,
        });
        const avatarGradient = resolveAgentAvatarGradient(profile?.avatarSeed ?? handle);
        return { handle, count, avatarImageSrc, avatarText, avatarGradient };
      });
  }, [agentByHandle, queuedByAgentHandle]);

  const totalQueuedCount = chatSendQueue.length;
  const queueQuickSendItem = chatSendQueueDisplay[0] ?? null;

  const queueStatusLabel = useMemo(() => {
    if (totalQueuedCount === 0) {
      return null;
    }
    if (waitingForPreferredRuntime || hostedRuntimeEnsuring) {
      return "Starting runtime";
    }
    if (runtimeEnsureError && !runtimeReady) {
      return "Runtime start failed";
    }
    if (!runtimeReady) {
      return "Runtime offline";
    }
    if (activeConversationRun || isAssistantTyping || sendingAttachment) {
      return "Reply in progress";
    }
    if (!activeConversationControllerId) {
      return "Syncing chat";
    }
    return "Ready to send";
  }, [
    activeConversationControllerId,
    activeConversationRun,
    hostedRuntimeEnsuring,
    isAssistantTyping,
    runtimeEnsureError,
    runtimeReady,
    sendingAttachment,
    totalQueuedCount,
    waitingForPreferredRuntime,
  ]);

  const queueStatusAction = useMemo<QueueStatusAction | null>(() => {
    if (totalQueuedCount === 0 || !runtimeControllerEnabled) {
      return null;
    }
    if (waitingForPreferredRuntime || hostedRuntimeEnsuring) {
      return {
        label: "Starting…",
        disabled: true,
        pending: true,
      };
    }
    if (runtimeEnsureError && !runtimeReady) {
      return {
        label: "Retry",
        disabled: false,
        pending: false,
      };
    }
    if (!runtimeReady) {
      return {
        label: currentRuntime?.isLikelyLocal ? "Reconnect" : "Start",
        disabled: false,
        pending: false,
      };
    }
    return null;
  }, [
    currentRuntime?.isLikelyLocal,
    hostedRuntimeEnsuring,
    runtimeControllerEnabled,
    runtimeEnsureError,
    runtimeReady,
    totalQueuedCount,
    waitingForPreferredRuntime,
  ]);

  const collapsedQueuedMessageSummary = useMemo(
    () => buildCollapsedQueuedMessageSummary(queueQuickSendItem, totalQueuedCount),
    [queueQuickSendItem, totalQueuedCount],
  );

  return {
    chatSendQueueDisplay,
    collapsedQueuedMessageSummary,
    queueQuickSendItem,
    queuedByAgentHandle,
    queuedSummaryItems,
    queuedTargetHandlesByItemId,
    queueStatusAction,
    queueStatusLabel,
    resolveQueuedItemTargets,
    totalQueuedCount,
  };
}
