import { useCallback, useRef } from "react";
import type { ChatMessage } from "../types";
import { readChatRunStopNotice } from "./ChatRunStopNotice";
import type { QueuedChatSendItem } from "./chatSendQueueStorage";
import type { SubmitMessageFn } from "./useChatSubmitFlow";

type Options = {
  conversationId: string | null;
  viewerUserId: string | null;
  humanLabelByUserId: ReadonlyMap<string, string>;
  canWrite: boolean;
  busy: boolean;
  messages: readonly ChatMessage[];
  queuedSends: readonly QueuedChatSendItem[];
  submitMessage: SubmitMessageFn;
};

/** Continue is a new targeted instruction, preserving the person's composer draft. */
export function useChatRunStopContinuation(options: Options) {
  const current = useRef(options);
  current.current = options;
  const submitted = useRef(new Set<string>());
  const canContinue = useCallback((message: ChatMessage) => {
    const state = current.current;
    const notice = readChatRunStopNotice(message);
    const key = `${state.conversationId}:${message.id}`;
    return Boolean(state.conversationId && state.viewerUserId && state.canWrite && !state.busy
      && notice.requested && notice.handles.length && notice.jobIds.length && notice.runIds.length
      && state.messages.some((entry) => entry.id === message.id)
      && !submitted.current.has(key)
      && !state.messages.some((entry) => entry.metadata?.continuedStopMessageId === message.id)
      && !state.queuedSends.some((entry) => entry.metadata?.continuedStopMessageId === message.id));
  }, []);
  const onContinue = useCallback(async (message: ChatMessage) => {
    if (!canContinue(message)) return false;
    const state = current.current;
    const key = `${state.conversationId}:${message.id}`;
    const notice = readChatRunStopNotice(message);
    submitted.current.add(key);
    let accepted = false;
    try {
      const sent = await state.submitMessage({
        message: "Continue the stopped turn from its current state. Check what has already finished before proceeding; do not repeat completed actions.",
        editorState: null,
        targetAgentHandles: notice.handles,
        metadata: { continuedStopMessageId: message.id, continuedRunIds: notice.runIds },
      }, { automatic: true, intent: "send", onQueued: () => { accepted = true; } });
      accepted = sent || accepted;
      return accepted;
    } finally {
      if (!accepted) submitted.current.delete(key);
    }
  }, [canContinue]);
  return {
    viewerUserId: options.viewerUserId,
    humanLabelByUserId: options.humanLabelByUserId,
    canContinue,
    onContinue,
  };
}
