// Conversational undo (#165). Undo on an agent message is an *action* undo, not
// a file revert: the turn may have opened a door, posted a message, or created a
// PR, and reverting the workspace would silently imply those were undone too.
// Clicking Undo therefore sends a normal user message asking the agent to undo
// that specific message's change — the agent decides what undo means (revert
// files, close the door, or explain why it cannot be undone), and the request
// lives in the thread's record. The pure file-revert path stays available from
// the Changes view (Source Control drawer) and the per-file cards, where its
// scope is unambiguous.

/** Window event dispatched by the Undo chip; ChatPanel owns the composer and listens. */
export const REQUEST_MESSAGE_UNDO_EVENT = "instafy:request-message-undo";

export type MessageUndoRequestDetail = {
  /** Id of the agent message whose change should be undone. */
  messageId: string;
  /** The message's timestamp (ms), for a human-readable reference in the text. */
  messageTimestamp?: number | null;
};

export type MessageUndoRequestSubmission = {
  message: string;
  metadata: Record<string, unknown>;
};

export function parseMessageUndoRequestDetail(value: unknown): MessageUndoRequestDetail | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  if (!messageId) {
    return null;
  }
  const rawTimestamp = record.messageTimestamp;
  const messageTimestamp =
    typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? rawTimestamp
      : null;
  return { messageId, messageTimestamp };
}

export function formatUndoTargetShortId(messageId: string): string {
  const compact = messageId.replace(/[^a-zA-Z0-9]/g, "");
  return (compact || messageId).slice(0, 8);
}

/**
 * The structured reference is the metadata (the message-create path passes
 * metadata through to the controller verbatim, like replyContext does); the
 * text also carries a compact readable reference so the thread record — and
 * any consumer that only sees the text — stays unambiguous about which
 * message is being undone.
 */
export function buildUndoRequestSubmission(
  detail: MessageUndoRequestDetail,
): MessageUndoRequestSubmission {
  const shortId = formatUndoTargetShortId(detail.messageId);
  const timestamp =
    typeof detail.messageTimestamp === "number" &&
    Number.isFinite(detail.messageTimestamp) &&
    detail.messageTimestamp > 0
      ? new Date(detail.messageTimestamp)
      : null;
  const timeReference = timestamp
    ? ` at ${timestamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : "";
  return {
    message: `Please undo the change from your message${timeReference} (id ${shortId}).`,
    metadata: { undoTargetMessageId: detail.messageId },
  };
}

/**
 * Builds the window-event handler ChatPanel installs. Requests are serialized
 * through a local promise chain: the composer's submitMessage drops concurrent
 * calls while one is in flight, so chaining guarantees a rapid second click is
 * queued behind the first instead of being dropped — and a single click can
 * never double-send. Failures break out of the chain without poisoning it.
 */
export function createMessageUndoRequestHandler(
  submit: (submission: MessageUndoRequestSubmission) => Promise<boolean>,
): (event: Event) => void {
  let chain: Promise<unknown> = Promise.resolve();
  return (event: Event) => {
    const detail = parseMessageUndoRequestDetail((event as CustomEvent<unknown>).detail);
    if (!detail) {
      return;
    }
    const submission = buildUndoRequestSubmission(detail);
    chain = chain.then(() => submit(submission)).catch(() => undefined);
  };
}
