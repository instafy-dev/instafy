import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ControllerEventPayload } from "../services/runtimeController/runs";
import type { ChatMessage } from "../screens/studio/types";
import { getMessageType } from "../screens/studio/components/chatMessageMetadata";

/**
 * Octo's reply while the model writes it: the `run.reply_draft` events on
 * /events. Nothing here is stored or sent anywhere. The reply the job persists
 * replaces its draft in the transcript, in the same render that adds it, so
 * the text stays where it is.
 */
export const REPLY_DRAFT_EVENT_KIND = "run.reply_draft";

export type ReplyDraft = {
  /** The controller's id of the conversation. */
  conversationId: string;
  jobId: string;
  runId: string | null;
  segment: number;
  seq: number;
  text: string;
  /** When this segment's first draft arrived: the draft's place in the transcript. */
  startedAt: number;
  /** When the latest draft arrived. */
  updatedAt: number;
};

/** How long a draft stays once its run is no longer active, for the reply to land in its place. */
export const REPLY_DRAFT_RUN_ENDED_GRACE_MS = 1_500;
/** A job's drafts are forgotten this long after its last one. */
const REPLY_DRAFT_RETENTION_MS = 10 * 60_000;
/** Message types a persisted reply can have: the completion's message, or its failure. */
const REPLY_MESSAGE_TYPES = new Set(["", "message", "text", "assistant_message", "error"]);

const drafts = new Map<string, ReplyDraft>();
const listeners = new Set<() => void>();
const EMPTY: readonly ReplyDraft[] = Object.freeze([]);
let snapshots = new Map<string, readonly ReplyDraft[]>();

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The draft a `run.reply_draft` event carries, or null for anything malformed. */
export function parseReplyDraftEvent(event: ControllerEventPayload, now = Date.now()): ReplyDraft | null {
  if (event.kind !== REPLY_DRAFT_EVENT_KIND) return null;
  const data = event.data ?? null;
  if (!data) return null;
  const conversationId = readString(event.conversation_id) ?? readString(data.conversationId);
  const jobId = readString(data.jobId) ?? readString(event.job_id);
  const segment = readCount(data.segment);
  const seq = readCount(data.seq);
  if (!conversationId || !jobId || segment === null || seq === null || typeof data.text !== "string") {
    return null;
  }
  return {
    conversationId,
    jobId,
    runId: readString(data.runId) ?? readString(event.run_id),
    segment,
    seq,
    text: data.text,
    startedAt: now,
    updatedAt: now,
  };
}

function notify() {
  snapshots = new Map();
  for (const listener of listeners) listener();
}

/**
 * Keeps the latest draft of each job. One sent before the latest, which a
 * reconnect or another controller node can deliver late, changes nothing.
 */
export function applyReplyDraft(draft: ReplyDraft): void {
  const current = drafts.get(draft.jobId);
  if (current && draft.seq <= current.seq) return;
  const startedAt = current && current.segment === draft.segment ? current.startedAt : draft.startedAt;
  drafts.set(draft.jobId, { ...draft, startedAt });
  for (const [jobId, entry] of drafts) {
    if (draft.updatedAt - entry.updatedAt > REPLY_DRAFT_RETENTION_MS) drafts.delete(jobId);
  }
  notify();
}

export function applyReplyDraftEvent(event: ControllerEventPayload): void {
  const draft = parseReplyDraftEvent(event);
  if (draft) applyReplyDraft(draft);
}

/** Tests only. */
export function resetReplyDraftsForTests(): void {
  drafts.clear();
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest draft of each job in a conversation, oldest first. */
export function conversationReplyDrafts(conversationId: string | null): readonly ReplyDraft[] {
  if (!conversationId) return EMPTY;
  const cached = snapshots.get(conversationId);
  if (cached) return cached;
  const list = [...drafts.values()]
    .filter((draft) => draft.conversationId === conversationId)
    .sort((a, b) => a.startedAt - b.startedAt);
  const snapshot = list.length > 0 ? list : EMPTY;
  snapshots.set(conversationId, snapshot);
  return snapshot;
}

/**
 * Whether the transcript already shows what a draft stands in for: the job's
 * reply, or the job's thread, which shows the turn itself and folds its reply in.
 */
function transcriptCoversDraft(messages: readonly ChatMessage[], draft: ReplyDraft): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant" || isReplyDraftMessage(message)) return false;
    const metadata = message.metadata ?? {};
    const matchesJob = (readString(metadata.jobId) ?? readString(metadata.job_id)) === draft.jobId;
    const matchesRun =
      draft.runId !== null && (readString(metadata.runId) ?? readString(metadata.run_id)) === draft.runId;
    if (!matchesJob && !matchesRun) return false;
    const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
    return REPLY_MESSAGE_TYPES.has(messageType) || (matchesJob && messageType === "agent_job_thread");
  });
}

/**
 * The drafts to show: those with text, of a run still active or that ended
 * within the grace period, that the transcript does not cover yet.
 */
export function selectVisibleReplyDrafts(
  conversationDraftList: readonly ReplyDraft[],
  messages: readonly ChatMessage[],
  activeRunIds: ReadonlySet<string>,
  now: number,
): ReplyDraft[] {
  return conversationDraftList.filter((draft) => {
    if (draft.text.trim().length === 0) return false;
    const runActive = draft.runId !== null && activeRunIds.has(draft.runId);
    if (!runActive && now - draft.updatedAt >= REPLY_DRAFT_RUN_ENDED_GRACE_MS) return false;
    return !transcriptCoversDraft(messages, draft);
  });
}

/** A draft as the transcript row it becomes: an assistant message of the draft's job and run. */
export function replyDraftChatMessage(draft: ReplyDraft): ChatMessage {
  return {
    id: `reply-draft:${draft.jobId}`,
    role: "assistant",
    content: draft.text,
    timestamp: draft.startedAt,
    messageType: null,
    metadata: {
      source: "agent",
      replyDraft: true,
      jobId: draft.jobId,
      ...(draft.runId ? { runId: draft.runId } : {}),
    },
  };
}

export function isReplyDraftMessage(message: ChatMessage): boolean {
  return message.metadata?.replyDraft === true;
}

/**
 * The conversation's reply drafts to append to its transcript. A draft whose
 * run ended is dropped once the grace period passes, if no reply replaced it.
 * `draftingRunActive` stays true while a run that drafted is active, also once
 * its reply landed, so the typing row does not come back under that reply.
 */
export function useReplyDraftMessages(
  conversationControllerId: string | null,
  messages: readonly ChatMessage[],
  activeRunIds: ReadonlySet<string>,
): { messages: ChatMessage[]; draftingRunActive: boolean } {
  const list = useSyncExternalStore(
    subscribe,
    () => conversationReplyDrafts(conversationControllerId),
    () => EMPTY,
  );
  // Bumped when a draft's grace period runs out, so the selection runs again.
  const [expiryTick, setExpiryTick] = useState(0);
  const visible = useMemo(() => {
    // The tick only asks for another selection. The time is read at each one, not at mount:
    // a transcript that changes long after a run ended (a jump to older history) must not
    // bring that run's draft back.
    void expiryTick;
    return selectVisibleReplyDrafts(list, messages, activeRunIds, Date.now());
  }, [activeRunIds, expiryTick, list, messages]);
  // A draft shown only for the grace period needs one more look when it runs out.
  const nextExpiry = useMemo(() => {
    let earliest: number | null = null;
    for (const draft of visible) {
      if (draft.runId !== null && activeRunIds.has(draft.runId)) continue;
      const expiry = draft.updatedAt + REPLY_DRAFT_RUN_ENDED_GRACE_MS;
      earliest = earliest === null ? expiry : Math.min(earliest, expiry);
    }
    return earliest;
  }, [activeRunIds, visible]);
  useEffect(() => {
    if (nextExpiry === null) return;
    const timeoutId = window.setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [nextExpiry]);
  const draftMessages = useMemo(() => visible.map(replyDraftChatMessage), [visible]);
  const draftingRunActive =
    draftMessages.length > 0 ||
    list.some((draft) => draft.text.trim().length > 0 && draft.runId !== null && activeRunIds.has(draft.runId));
  return useMemo(
    () => ({ messages: draftMessages, draftingRunActive }),
    [draftMessages, draftingRunActive],
  );
}
