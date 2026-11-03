import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ControllerEventPayload } from "../services/runtimeController/runs";
import type { ChatMessage } from "../screens/studio/types";
import { getMessageType } from "../screens/studio/components/chatMessageMetadata";

/**
 * The assistant's reply while the model writes it: the `run.reply_draft` events on
 * /events. Nothing here is stored or sent anywhere. A draft shows in its
 * turn's row, in its reply's place ({@link placeReplyDrafts}), and the reply
 * the job persists replaces it there, in the same render that adds it, so the
 * text stays where it is.
 */
export const REPLY_DRAFT_EVENT_KIND = "run.reply_draft";

export type ReplyDraft = {
  /** The controller's id of the conversation. */
  conversationId: string;
  jobId: string;
  runId: string | null;
  attempt: number;
  segment: number;
  seq: number;
  text: string;
  /** When this segment's first draft arrived: the draft's place in the transcript. */
  startedAt: number;
  /** When the latest draft arrived. */
  updatedAt: number;
};

/** Grace for missing/inactive run snapshots; an explicit terminal event clears drafts immediately. */
export const REPLY_DRAFT_RUN_ENDED_GRACE_MS = 30_000;
/** A job's drafts are forgotten this long after its last one. */
const REPLY_DRAFT_RETENTION_MS = 10 * 60_000;
/** Message types a persisted reply can have: the completion's message, or its failure. */
const REPLY_MESSAGE_TYPES = new Set(["", "message", "text", "assistant_message", "error"]);

const drafts = new Map<string, ReplyDraft>();
const endedRuns = new Set<string>();
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
  const attempt = readCount(data.attempt ?? 0);
  const segment = readCount(data.segment);
  const seq = readCount(data.seq);
  if (!conversationId || !jobId || attempt === null || segment === null || seq === null || typeof data.text !== "string" || data.text.length > 128 * 1024) {
    return null;
  }
  return {
    conversationId,
    jobId,
    runId: readString(data.runId) ?? readString(event.run_id),
    attempt,
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
  if (draft.runId && endedRuns.has(draft.runId)) return;
  const current = drafts.get(draft.jobId);
  if (current && (draft.attempt < current.attempt || (draft.attempt === current.attempt && draft.seq <= current.seq))) return;
  const startedAt = current && current.attempt === draft.attempt && current.segment === draft.segment ? current.startedAt : draft.startedAt;
  drafts.set(draft.jobId, { ...draft, startedAt });
  for (const [jobId, entry] of drafts) {
    if (draft.updatedAt - entry.updatedAt > REPLY_DRAFT_RETENTION_MS) drafts.delete(jobId);
  }
  while (drafts.size > 128) drafts.delete(drafts.keys().next().value!);
  notify();
}

export function applyReplyDraftEvent(event: ControllerEventPayload): void {
  const draft = parseReplyDraftEvent(event);
  if (draft) applyReplyDraft(draft);
}

/** Discard speculative text at the same account/project boundary as run state. */
export function clearReplyDrafts(): void {
  drafts.clear();
  endedRuns.clear();
  notify();
}

/** Terminal controller state always wins over late or reordered draft delivery. */
export function endReplyDraftRun(runId: string): void {
  endedRuns.add(runId);
  for (const [jobId, draft] of drafts) if (draft.runId === runId) drafts.delete(jobId);
  // A bounded set suffices for live transport reordering; durable messages also
  // suppress any draft they replace, including after hydration.
  if (endedRuns.size > 1024) endedRuns.delete(endedRuns.values().next().value!);
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
 * Whether the transcript already has the job's durable reply or error. The
 * thread/status row alone does not mean the reply has arrived.
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
    return REPLY_MESSAGE_TYPES.has(messageType);
  });
}

/**
 * The drafts to show: those with text, of an active run or a recent draft
 * whose run snapshot is missing/inactive, not covered by a durable reply.
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

/** Metadata on a turn's row (`agent_job_thread`): the reply its model is writing. */
export const TURN_REPLY_DRAFT_METADATA_KEY = "turnReplyDraft";

/** The reply a turn's row carries while its model writes it ({@link placeReplyDrafts}). */
export function readTurnReplyDraft(metadata: Record<string, unknown> | null | undefined): string | null {
  const text = metadata?.[TURN_REPLY_DRAFT_METADATA_KEY];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

/**
 * The transcript with each draft in its turn: a turn that shows a row (its
 * activity line) carries the draft in that row, in the place its reply takes,
 * so the turn stays one Octo row and the reply lands where its draft grew. A
 * draft whose turn has no row yet is a row of its own, after the transcript.
 */
export function placeReplyDrafts(messages: ChatMessage[], drafts: readonly ChatMessage[]): ChatMessage[] {
  if (drafts.length === 0) return messages;
  const turnRowByJobId = new Map<string, number>();
  messages.forEach((message, index) => {
    if ((getMessageType(message) ?? "").trim().toLowerCase() !== "agent_job_thread") return;
    const jobId = readString(message.metadata?.jobId);
    if (jobId) turnRowByJobId.set(jobId, index);
  });
  const placed = [...messages];
  const ownRows: ChatMessage[] = [];
  for (const draft of drafts) {
    const jobId = readString(draft.metadata?.jobId);
    const index = jobId === null ? undefined : turnRowByJobId.get(jobId);
    if (index === undefined) {
      ownRows.push(draft);
      continue;
    }
    const row = placed[index]!;
    placed[index] = { ...row, metadata: { ...(row.metadata ?? {}), [TURN_REPLY_DRAFT_METADATA_KEY]: draft.content } };
  }
  return ownRows.length > 0 ? [...placed, ...ownRows] : placed;
}

/**
 * The conversation's reply drafts, for {@link placeReplyDrafts}. A draft whose
 * run is missing/inactive gets a short grace period for snapshot ordering.
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
  const { view, nextExpiry } = useMemo(() => {
    // The tick only asks for another selection. The time is read at each one, not at mount:
    // a transcript that changes long after a run ended (a jump to older history) must not
    // bring that run's draft back.
    void expiryTick;
    const visible = selectVisibleReplyDrafts(list, messages, activeRunIds, Date.now());
    // A draft shown only for the grace period needs one more look when it runs out.
    let earliest: number | null = null;
    for (const draft of visible) {
      if (draft.runId !== null && activeRunIds.has(draft.runId)) continue;
      const expiry = draft.updatedAt + REPLY_DRAFT_RUN_ENDED_GRACE_MS;
      earliest = earliest === null ? expiry : Math.min(earliest, expiry);
    }
    return {
      view: {
        messages: visible.map(replyDraftChatMessage),
        draftingRunActive: visible.length > 0 || list.some((draft) =>
          draft.text.trim().length > 0 && draft.runId !== null && activeRunIds.has(draft.runId)),
      },
      nextExpiry: earliest,
    };
  }, [activeRunIds, expiryTick, list, messages]);
  useEffect(() => {
    if (nextExpiry === null) return;
    const timeoutId = window.setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [nextExpiry]);
  return view;
}
