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

/** How the AI credential an agent draws from resolves right now. */
export type ParticipantCredentialState =
  | "default" // uses the workspace default credential
  | "pinned" // pinned to a specific credential
  | "missing" // pinned credential no longer exists
  | "revoked" // pinned credential was revoked
  | "none"; // no usable credential

export interface ParticipantAgent extends ConversationRosterAgent {
  /** Resolved model id, e.g. "gpt-5.5". */
  model: string | null;
  /** Provider label for display, e.g. "OpenAI". */
  providerLabel: string | null;
  /** Human-readable name of the credential this agent draws from. */
  credentialLabel: string | null;
  credentialState: ParticipantCredentialState;
}

export interface ChatParticipantsSnapshot {
  conversationId: string | null;
  humans: readonly ConversationRosterHuman[];
  agents: readonly ParticipantAgent[];
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

/**
 * Open/closed state for the participants drawer. The trigger (the roster
 * facepile) lives inside the chat surface while the drawer renders as a
 * StudioLayout sibling, so the toggle must be shared out of band. Persisted so
 * the drawer stays where the viewer left it across reloads. Default: closed —
 * the drawer is opened deliberately, not ambient chrome.
 */
const OPEN_STORAGE_KEY = "instafy.participantsDrawer.open.v1";

function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let drawerOpen = readStoredOpen();
const openListeners = new Set<() => void>();

function emitOpen(): void {
  for (const listener of openListeners) {
    listener();
  }
}

export function setParticipantsDrawerOpen(open: boolean): void {
  if (drawerOpen === open) {
    return;
  }
  drawerOpen = open;
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Preference just won't persist (private mode).
  }
  emitOpen();
}

export function toggleParticipantsDrawer(): void {
  setParticipantsDrawerOpen(!drawerOpen);
}

export function useParticipantsDrawerOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => drawerOpen,
    () => false,
  );
}
