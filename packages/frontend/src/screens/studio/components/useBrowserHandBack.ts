import { useEffect, useMemo, useRef } from "react";
import { findPromptSentFromThisPageForRun } from "../../../conversations/sentPromptRegistry";
import type { RunStatus } from "../../../types";
import type { ChatMessage } from "../types";
import {
  BROWSER_HAND_BACK_CLAIM_KEY,
  BROWSER_HAND_BACK_PROMPT,
  browserHandBackCandidate,
  browserHandBackNotice,
  claimBrowserHandBack,
  readBrowserHandBackOf,
} from "./browserHandBack";

/** How a hand-back is shown and recorded. */
export type BrowserHandBackExtras = {
  /** What the chat shows in place of the prompt: a one-line notice. */
  display: string;
  /** Prompt metadata naming the browser job (the controller checks it). */
  metadata: Record<string, unknown>;
  /** The agents it goes to; the chat's own agent when absent. */
  agentHandles?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agents a stored prompt went to: its selection's mentions, else its active agents. */
function promptAgentHandles(metadata: unknown): string[] {
  const records = isRecord(metadata) ? [metadata] : [];
  for (const key of ["prompt_metadata", "promptMetadata"]) {
    const nested = records[0]?.[key];
    if (isRecord(nested)) records.push(nested);
  }
  for (const record of records) {
    const selection = record.agentSelection;
    if (!isRecord(selection)) continue;
    const handles = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((handle): handle is string => typeof handle === "string" && handle.trim().length > 0)
        : [];
    const mentions = handles(selection.mentions);
    const chosen = mentions.length > 0 ? mentions : handles(selection.active);
    if (chosen.length > 0) return chosen;
  }
  return [];
}

/**
 * Try again on a hand-back whose turn failed: the same hand-back, sent again.
 * Its claim on the browser turn and Studio's words go out, never the notice
 * the chat shows for it ("Octo continued in the chat"), which alone would
 * reach Octo as the person's request, with nothing of what the browser turn
 * found or what they asked. It goes to the agent the hand-back went to, and
 * carries the retry's metadata. Null for any other prompt.
 */
export function browserHandBackRetry(
  promptMessage: Pick<ChatMessage, "role" | "content" | "metadata">,
  retryMetadata: Record<string, unknown>,
): { message: string; extras: BrowserHandBackExtras } | null {
  const jobId = readBrowserHandBackOf(promptMessage);
  if (!jobId) return null;
  const agentHandles = promptAgentHandles(promptMessage.metadata);
  return {
    message: BROWSER_HAND_BACK_PROMPT,
    extras: {
      display: promptMessage.content.trim() || browserHandBackNotice("Octo"),
      metadata: { ...retryMetadata, [BROWSER_HAND_BACK_CLAIM_KEY]: jobId },
      ...(agentHandles.length > 0 ? { agentHandles } : {}),
    },
  };
}

type Options = {
  /** Changes with the conversation: a new one starts with no history to hand back. */
  identity: string;
  messages: readonly ChatMessage[];
  canWrite: boolean;
  /** A turn is running in this conversation. */
  busy: boolean;
  /** Run and job ids still working in this conversation. */
  activeRunIds: ReadonlySet<string>;
  /** Status by run id and by job id. */
  runStatuses: ReadonlyMap<string, RunStatus>;
  /**
   * The person is about to say something themselves (a draft) or has a step
   * of their own in the browser: the hand-back waits, and a message they
   * send in the meantime replaces it.
   */
  held: boolean;
  /** The agent the notice names, as in "Octo continued with what it found in the browser". */
  agentName?: string;
  /** Sends the hand-back as an ordinary turn of the building lane; resolves to whether it went out. */
  send: (message: string, extras: BrowserHandBackExtras) => Promise<boolean>;
};

/**
 * Sends one hand-back after a browser turn that continued Octo's card
 * finishes, so Octo keeps building with what the browser found (see
 * browserHandBackCandidate for exactly when). The prompt is fixed; the
 * findings reach Octo from the controller as quoted page data. A hand-back
 * the controller refuses shows nothing: the browser turn stays the last word,
 * and the person can write as usual.
 */
export function useBrowserHandBack(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const openedAt = useRef(Date.now());
  const previousIdentity = useRef(options.identity);
  if (previousIdentity.current !== options.identity) {
    previousIdentity.current = options.identity;
    openedAt.current = Date.now();
  }
  const activeRunIdsKey = useMemo(() => [...options.activeRunIds].sort().join(","), [options.activeRunIds]);

  useEffect(() => {
    const current = latest.current;
    if (!current.canWrite || current.busy || current.held) return;
    const jobId = browserHandBackCandidate({
      messages: current.messages,
      openedAtMs: openedAt.current,
      activeRunIds: current.activeRunIds,
      runStatus: (id) => current.runStatuses.get(id) ?? null,
      sentPromptForRun: findPromptSentFromThisPageForRun,
    });
    if (!jobId || !claimBrowserHandBack(jobId)) return;
    void current.send(BROWSER_HAND_BACK_PROMPT, {
      display: browserHandBackNotice(current.agentName ?? "Octo"),
      metadata: { [BROWSER_HAND_BACK_CLAIM_KEY]: jobId },
    }).catch(() => false);
  }, [
    activeRunIdsKey,
    options.busy,
    options.canWrite,
    options.held,
    options.identity,
    options.messages,
    options.runStatuses,
  ]);
}
