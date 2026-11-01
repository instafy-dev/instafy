import { useEffect, useMemo, useRef } from "react";
import { findPromptSentFromThisPageForRun } from "../../../conversations/sentPromptRegistry";
import type { RunStatus } from "../../../types";
import type { ChatMessage } from "../types";
import {
  BROWSER_HAND_BACK_CLAIM_KEY,
  BROWSER_HAND_BACK_PROMPT,
  browserBuildRequestNotice,
  browserHandBackCandidate,
  browserHandBackNotice,
  browserTurnRequestedABuild,
  claimBrowserHandBack,
} from "./browserHandBack";

/** How a hand-back is shown and recorded. */
export type BrowserHandBackExtras = {
  /** What the chat shows in place of the prompt: a one-line notice. */
  display: string;
  /** Prompt metadata naming the browser job (the controller checks it). */
  metadata: Record<string, unknown>;
};

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
 * the controller refuses shows nothing: the browser turn's reply stays the
 * last word, and the person can write as usual.
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
    const agentName = current.agentName ?? "Octo";
    void current.send(BROWSER_HAND_BACK_PROMPT, {
      display: browserTurnRequestedABuild(current.messages, jobId)
        ? browserBuildRequestNotice(agentName)
        : browserHandBackNotice(agentName),
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
