import { useEffect, useLayoutEffect, useRef } from "react";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";

/**
 * Switches to the Browser view once for each request to show it (a press,
 * the person's own open), as soon as the browser is open. Studio opening the
 * browser by itself for a card makes no request, so the person stays in Chat,
 * also when the browser opens after an earlier request was shown.
 */
export function useShowBrowserOnRequest(open: boolean, requestToken: number, show: () => void): void {
  const shownToken = useRef(0);
  useLayoutEffect(() => {
    if (!open || requestToken <= shownToken.current) return;
    shownToken.current = requestToken;
    show();
  }, [open, requestToken, show]);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Octo's pauses on `userId`'s fields in a chat (its `request_human_input`
 * step in a turn that person started), as message ids with the time each
 * came in. A pause in someone else's turn is theirs to act on.
 */
function humanInputPauses(
  messages: readonly ChatMessage[],
  runs: readonly RunRecord[],
  userId: string | null,
): Array<{ id: string; at: number }> {
  const pauses: Array<{ id: string; at: number }> = [];
  if (!userId) return pauses;
  for (const message of messages) {
    if (message.role !== "assistant" || getMessageType(message) !== "mcp_tool_call") continue;
    const details = extractMessageDetails(message.metadata);
    if (details?.tool !== "request_human_input" || details.status !== "completed") continue;
    const runId = stringValue(message.metadata?.runId);
    const jobId = stringValue(message.metadata?.jobId);
    const run = runs.find((entry) => (runId !== null && entry.id === runId) ||
      (jobId !== null && stringValue(entry.metadata?.jobId) === jobId));
    if (!run || stringValue(run.metadata?.initiatingUserId) !== userId) continue;
    pauses.push({ id: message.id, at: message.timestamp });
  }
  return pauses;
}

/**
 * Switches to the Browser view once for each pause on the person's fields
 * that comes in while the chat is open: it is the one moment they must act
 * there (a sign-in, a code), and the highlighted fields are on that page.
 * Only for the person whose turn paused; pauses from before the chat was
 * opened here (history, a reload) switch nothing.
 */
export function useShowBrowserOnHumanInput(input: {
  identity: string;
  userId: string | null;
  messages: readonly ChatMessage[];
  runs: readonly RunRecord[];
  show: () => void;
}): void {
  const { identity, userId, messages, runs, show } = input;
  const openedAt = useRef(Date.now());
  const previousIdentity = useRef(identity);
  const shown = useRef(new Set<string>());
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    openedAt.current = Date.now();
    shown.current = new Set();
  }
  useEffect(() => {
    let fresh = false;
    for (const pause of humanInputPauses(messages, runs, userId)) {
      if (shown.current.has(pause.id) || pause.at < openedAt.current - 1_000) continue;
      shown.current.add(pause.id);
      fresh = true;
    }
    if (fresh) show();
  }, [identity, messages, runs, show, userId]);
}
