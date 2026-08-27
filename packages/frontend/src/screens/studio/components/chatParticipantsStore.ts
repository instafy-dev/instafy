import { useSyncExternalStore } from "react";
import type {
  ConversationRosterAgent,
  ConversationRosterHuman,
} from "./conversationRosterMembers";

/**
 * Snapshot of "who is in this conversation" published by ChatPanel for
 * surfaces that live OUTSIDE the chat surface (the participants drawer is a
 * sibling of the workspace panels in StudioLayout, so props cannot reach it).
 * ChatPanel is the single writer — it already computes the roster, run state,
 * and queue depth for its own chrome; mirroring the values here keeps one
 * source of truth instead of re-running its stateful hooks elsewhere.
 */

export interface ChatParticipantsSnapshot {
  conversationId: string | null;
  humans: readonly ConversationRosterHuman[];
  agents: readonly ConversationRosterAgent[];
  /** Agent handles with an actively progressing run in this conversation. */
  runningAgentHandles: readonly string[];
  /** Messages waiting in this conversation's send queue. */
  totalQueuedCount: number;
}

export const EMPTY_CHAT_PARTICIPANTS_SNAPSHOT: ChatParticipantsSnapshot = {
  conversationId: null,
  humans: [],
  agents: [],
  runningAgentHandles: [],
  totalQueuedCount: 0,
};

let current: ChatParticipantsSnapshot = EMPTY_CHAT_PARTICIPANTS_SNAPSHOT;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function publishChatParticipants(next: ChatParticipantsSnapshot): void {
  current = next;
  emit();
}

/**
 * Clears the snapshot, but only if it still belongs to the given conversation
 * — an unmount racing a newer publish must not wipe the newer data.
 */
export function clearChatParticipants(conversationId: string | null): void {
  if (current.conversationId !== conversationId) {
    return;
  }
  current = EMPTY_CHAT_PARTICIPANTS_SNAPSHOT;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChatParticipantsSnapshot {
  return current;
}

export function useChatParticipantsSnapshot(): ChatParticipantsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
