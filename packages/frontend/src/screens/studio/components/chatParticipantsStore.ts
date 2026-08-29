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

/** The runtime (machine) an agent runs in, for grouping the roster by machine. */
export interface ParticipantRuntimeInfo {
  /** Grouping key — agents that share a machine share this id. */
  id: string;
  /** Machine label, e.g. "Instafy Cloud" or "Your Mac". */
  label: string;
  /**
   * How this agent relates to the machine: the shared workspace runtime, a
   * dedicated one it pinned, or a native runtime on the user's own machine.
   */
  kind: "shared" | "dedicated" | "native";
  /** Runtime status: "ready" | "booting" | "offline" | "expired" | "unknown". */
  status: string;
  /** Static capacity, e.g. "2 vCPU · 4 GB" — null when unknown. */
  resourcesSummary: string | null;
}

/** How the AI credential an agent draws from resolves right now. */
export type ParticipantCredentialState =
  | "default" // uses the workspace default credential
  | "pinned" // pinned to a specific credential
  | "missing" // pinned credential no longer exists
  | "revoked" // pinned credential was revoked
  | "none"; // no usable credential

/**
 * One rate-limit window reported by the BYOC subscription (ChatGPT/Codex). The
 * upstream splits usage into a short rolling window and a longer one; we keep
 * both verbatim and let the UI classify by `windowMinutes` (≈300 → "5h",
 * ≈10080 → "Weekly").
 */
export interface ParticipantUsageWindow {
  /** Upstream slot: "primary" is the short window, "secondary" the long one. */
  kind: "primary" | "secondary";
  /** 0–100, how much of this window's allowance is already spent. */
  usedPercent: number;
  /** Window length in minutes (300 = 5h, 10080 = weekly). */
  windowMinutes: number;
  /** When this window's allowance resets, unix seconds. */
  resetAt: number;
}

/** Live remaining-usage snapshot for a subscription-backed credential. */
export interface ParticipantSubscriptionUsage {
  windows: readonly ParticipantUsageWindow[];
  /** Plan/limit name upstream reports, e.g. "GPT-5.3-Codex-Spark". */
  planName: string | null;
  /** When the proxy last captured these numbers, unix seconds. */
  capturedAt: number;
}

export interface ParticipantAgent extends ConversationRosterAgent {
  /** Controller agent id — present when the agent is editable in place. */
  agentId?: string | null;
  /** Effective AI provider id (e.g. "openai"), for model options + gating. */
  providerId?: string | null;
  /** Resolved model id, e.g. "gpt-5.5". */
  model: string | null;
  /** Per-agent reasoning effort (minimal|low|medium|high), or null to inherit. */
  reasoningEffort?: string | null;
  /** The machine this agent runs in — used to group the roster by runtime. */
  runtime?: ParticipantRuntimeInfo | null;
  /** Provider label for display, e.g. "OpenAI". */
  providerLabel: string | null;
  /** Id of the credential this agent draws from (dedupes shared meters). */
  credentialId: string | null;
  /** Human-readable name of the credential this agent draws from. */
  credentialLabel: string | null;
  /** Credential kind (e.g. "codex_auth_json"), for a friendly type descriptor. */
  credentialKind?: string | null;
  credentialState: ParticipantCredentialState;
  /** Subscription usage for the drawn credential, when it reports any. */
  subscriptionUsage: ParticipantSubscriptionUsage | null;
}

/** A credential the drawer can offer as an agent's option. */
export interface ParticipantCredentialOption {
  id: string;
  label: string;
  kind: string;
  revoked: boolean;
}

/**
 * Editing capability the drawer uses to make agent rows two-way. ChatPanel is
 * the single owner of the agent/credential data and the refresh, so it hands
 * the drawer a `saveAgent` that wraps its own update + refresh — the drawer
 * never talks to the controller directly. Present only when editing is possible
 * (a persisted agent + a signed-in workspace); `null` keeps the drawer read-only.
 */
export interface ParticipantEditingContext {
  credentials: readonly ParticipantCredentialOption[];
  saveAgent: (
    agentId: string,
    patch: {
      model?: string | null;
      reasoningEffort?: string | null;
      credentialId?: string | null;
    },
  ) => Promise<boolean>;
}

export interface ChatParticipantsSnapshot {
  conversationId: string | null;
  humans: readonly ConversationRosterHuman[];
  agents: readonly ParticipantAgent[];
  /** Agent handles with an actively progressing run in this conversation. */
  runningAgentHandles: readonly string[];
  /** Messages waiting in this conversation's send queue. */
  totalQueuedCount: number;
  /** Editing capability, or null/absent when the drawer is read-only. */
  editing?: ParticipantEditingContext | null;
}

export const EMPTY_CHAT_PARTICIPANTS_SNAPSHOT: ChatParticipantsSnapshot = {
  conversationId: null,
  humans: [],
  agents: [],
  runningAgentHandles: [],
  totalQueuedCount: 0,
  editing: null,
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
