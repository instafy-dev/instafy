import { useEffect, useLayoutEffect, useRef } from "react";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { runIdsEndedByStop } from "./controllerConversationNotice";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The codes a browser turn ends on to wait for the person on the page: their
 * fields, a cookie notice the browser could not decline, or a step only they
 * take (runtime-agent `shared_browser.rs`, `terminal_consent_call_result`).
 */
const BROWSER_PAUSE_CODES: ReadonlySet<string> = new Set([
  "human_input_required",
  "cookie_notice_required",
  "human_step_required",
]);

/** Octo's `request_human_input` step, which pauses its turn on the page. */
function isHumanInputRequest(message: ChatMessage): boolean {
  if (message.role !== "assistant" || getMessageType(message) !== "mcp_tool_call") return false;
  const details = extractMessageDetails(message.metadata);
  return details?.tool === "request_human_input" && details.status === "completed";
}

/**
 * A step that paused its browser turn for the person: the pause itself, or
 * any step whose result ended the run on one of the pause codes.
 */
function isBrowserPause(message: ChatMessage): boolean {
  if (isHumanInputRequest(message)) return true;
  if (message.role !== "assistant" || getMessageType(message) !== "mcp_tool_call") return false;
  const consent = extractMessageDetails(message.metadata)?.terminalConsent;
  return isRecord(consent) && consent.state === "blocked" &&
    typeof consent.code === "string" && BROWSER_PAUSE_CODES.has(consent.code);
}

/** The run a chat message came from: by its run id, else by its job's. */
function messageRun(message: ChatMessage, runs: readonly RunRecord[]): RunRecord | null {
  const runId = stringValue(message.metadata?.runId) ?? stringValue(message.metadata?.run_id);
  const jobId = stringValue(message.metadata?.jobId) ?? stringValue(message.metadata?.job_id);
  return runs.find((entry) => (runId !== null && entry.id === runId) ||
    (jobId !== null && stringValue(entry.metadata?.jobId) === jobId)) ?? null;
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
    if (!isHumanInputRequest(message)) continue;
    const run = messageRun(message, runs);
    if (!run || stringValue(run.metadata?.initiatingUserId) !== userId) continue;
    pauses.push({ id: message.id, at: message.timestamp });
  }
  return pauses;
}

/** A pause in Instafy's browser that still waits for the person (openBrowserPause). */
export type OpenBrowserPause = {
  /** The chat's record of the pause. */
  messageId: string;
  runId: string;
  /** The machine and the tab the paused turn ran on, as its run names them. */
  runtimeId: string | null;
  pageId: string | null;
};

/**
 * The pause in Instafy's browser that still waits for `userId`, read from
 * the chat itself, so a reload, another device or a closed Browser view
 * keeps it: the chat's newest pause step (its fields, a cookie notice or a
 * step only they take), in a Shared Browser turn that person started, with
 * no person's message after it. A newer message closes it, a press of Let
 * Octo continue too, and so does a Stop of its turn. A pause in a turn not
 * known yet, or in someone else's, is none of theirs.
 */
export function openBrowserPause(
  messages: readonly ChatMessage[],
  runs: readonly RunRecord[],
  userId: string | null,
): OpenBrowserPause | null {
  if (!userId) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return null;
    if (!isBrowserPause(message)) continue;
    const run = messageRun(message, runs);
    if (
      !run ||
      stringValue(run.metadata?.initiatingUserId) !== userId ||
      run.metadata?.browserTransport !== "shared" ||
      runIdsEndedByStop(messages).has(run.id)
    ) {
      return null;
    }
    return {
      messageId: message.id,
      runId: run.id,
      runtimeId: stringValue(run.metadata?.browserRuntimeId),
      pageId: stringValue(run.metadata?.browserPageId),
    };
  }
  return null;
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
