import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isRunFailurePromptFromThisClient,
  isRunFailureRecentForAutoRetry,
} from "../../../conversations/runFailurePresentation";
import { findPromptSentFromThisPageForRun } from "../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../types";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartAddressesSeen,
  browserAutoStartedRecently,
  claimBrowserAutoStart,
  isBrowserAutoStartClaimed,
  isBrowserAutoStartDeclined,
  recordBrowserAutoStart,
  type BrowserAutoStartPlan,
} from "./browserAutoStart";
import {
  BROWSER_AUTO_STARTED_METADATA_KEY,
  BROWSER_REQUEST_OF_METADATA_KEY,
  browserRequestContinuation,
  browserRequestContinuedKeys,
  browserRequestDestinations,
  browserRequestFromContinuationPrompt,
  browserRequestFromMessage,
  browserRequestJobId,
  browserRequestKey,
  browserRequestNotice,
  browserRequestTransport,
  browserRequestUnavailableReason,
  isBrowserTurnPromptMetadata,
  readBrowserRequestOf,
  type BrowserRequest,
  type BrowserRequestCardState,
  type BrowserRequestHost,
} from "./browserRequest";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

/** How a continuation is shown and recorded. */
export type BrowserTaskExtras = {
  /** What the chat shows in place of the task: a one-line notice. */
  display: string;
  /** Prompt metadata naming the card, and whether Studio sent it by itself. */
  metadata: Record<string, unknown>;
  /**
   * The hosts the card shows (at most three). The browser on this device may
   * treat them as the run's own sites; they are not recorded with the prompt.
   */
  knownHosts: string[];
};

/** What Studio needs to start a card by itself. Absent, every card waits for a press. */
export type BrowserAutoStartOptions = {
  currentUserId: string | null;
  chatClientSessionId: string | null;
  /** Run and job ids still working in this conversation. */
  activeRunIds: ReadonlySet<string>;
  /**
   * Why Studio leaves this conversation's cards to the person right now (a
   * draft in the composer, a narrow layout, side-by-side view off), or null
   * when it may start one.
   */
  blocked: { reason: string | null } | null;
  /** Another person or agent run holds the browser. */
  heldByOther: boolean;
  plan: (request: BrowserRequest, transport: BrowserTransport) => BrowserAutoStartPlan;
  /**
   * Changes whenever something the decision reads changes (a draft, the
   * layout, who holds the browser, this space's runtimes), so a card held by
   * one of them is looked at again once it clears.
   */
  revision: string;
};

type Options = {
  identity: string;
  messages: ChatMessage[];
  canWrite: boolean;
  ready: boolean;
  transport: BrowserTransport;
  open: boolean;
  busy: boolean;
  personalAvailable: boolean;
  /** False when the person's turns use Instafy AI, which dispatch refuses on this device. */
  personalTurnsAllowed?: boolean;
  personalReady: boolean;
  sharedReady: boolean;
  /** The Workspace browser is already known not to open here; unknown counts as available. */
  sharedUnavailable: boolean;
  /** The agent the notice names, as in "Octo opened Instafy's browser". */
  agentName?: string;
  activate: (transport: BrowserTransport, plan: BrowserAutoStartPlan | null) => void;
  continueTask: (transport: BrowserTransport, message: string, extras: BrowserTaskExtras) => Promise<boolean>;
  onError: (message: string) => void;
  auto?: BrowserAutoStartOptions | null;
};

/**
 * How long an automatic start may take to open the browser: a profile restore
 * plus a start of Instafy's browser on the space's machine fit in it.
 */
export const BROWSER_REQUEST_HANDOFF_DEADLINE_MS = 120_000;
/**
 * How long a press for Instafy's browser may take: it can also start the
 * space's machine first (up to three minutes) and then its browser.
 */
export const BROWSER_REQUEST_PRESS_DEADLINE_MS = 240_000;

function hostOf(options: Options): BrowserRequestHost {
  return {
    transport: options.transport,
    personalAvailable: options.personalAvailable,
    sharedUnavailable: options.sharedUnavailable,
    personalTurnsAllowed: options.personalTurnsAllowed,
  };
}

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function sameCardState(a: BrowserRequestCardState | undefined, b: BrowserRequestCardState): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "opening" && b.kind === "opening") return a.note === b.note;
  if (a.kind === "button" && b.kind === "button") return a.reason === b.reason;
  return true;
}

/**
 * An automatic start that no longer applies by the time the browser is
 * ready: the card stays a button, without a reason or a toast.
 */
class BrowserAutoStartDropped extends Error {
  constructor() {
    super("");
    this.name = "BrowserAutoStartDropped";
  }
}

/**
 * Whether an automatic start still applies right before its continuation is
 * sent: the card is still the newest, nobody wrote after it or continued it,
 * and the conversation is idle with no draft.
 */
function autoStartStillApplies(current: Options, key: string): boolean {
  const auto = current.auto;
  if (!auto || current.busy || auto.activeRunIds.size > 0 || auto.blocked) return false;
  const index = current.messages.findIndex((message) =>
    browserRequestKey(message) === key && browserRequestFromMessage(message) !== null);
  if (index < 0) return false;
  if (current.messages.slice(index + 1).some((message) =>
    message.role === "user" || browserRequestFromMessage(message) !== null)) return false;
  return !browserRequestContinuedKeys(current.messages).has(key);
}

/**
 * The model requests a handoff with a `request_browser` card. Pressing the
 * card starts the browser and continues the task there. Studio also presses
 * it by itself (owner decision, Oct 19: Octo opens Instafy's browser on its
 * own), but only:
 * - in the tab whose prompt started the run that sent the card, by the person
 *   who sent it ({@link findPromptSentFromThisPageForRun}): never for history,
 *   another viewer, another device, a reload, an automation or a worker;
 * - for the newest card, sent after the conversation was opened and within ten
 *   minutes, with no message after it and no continuation for it;
 * - never for a card a browser turn sent, so a pause or a denial cannot loop;
 * - for an address the person could have seen ({@link browserAutoStartAddressesSeen});
 * - once that run is finished, and once the tab is visible;
 * - once per card on this page, at most once per conversation in ten minutes,
 *   and never after the person closed, paused or stopped the browser there;
 * - only in the desktop app's browser, for a person on their own AI (see
 *   browserAutoStartPlan): Instafy's hosted browser, and every other case,
 *   leaves the card a button, with the reason;
 * - and, checked again once the browser is ready, only while nobody wrote
 *   after the card, the conversation is idle and no one else holds the browser.
 * A start opens with the person's own approval settings, exactly as a press
 * does. A failed start leaves the button and says why.
 */
export function useChatBrowserRequest(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const previousIdentity = useRef(options.identity);
  const openedAt = useRef(Date.now());
  if (previousIdentity.current !== options.identity) {
    previousIdentity.current = options.identity;
    generation.current += 1;
    openedAt.current = Date.now();
  }
  const pending = useRef(false);
  const [cardStates, setCardStates] = useState<ReadonlyMap<string, BrowserRequestCardState>>(() => new Map());
  const [visible, setVisible] = useState(isDocumentVisible);

  const setCardState = useCallback((key: string, state: BrowserRequestCardState) => {
    setCardStates((current) => sameCardState(current.get(key), state) ? current : new Map(current).set(key, state));
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const start = useCallback(async (
    key: string,
    request: BrowserRequest,
    plan: BrowserAutoStartPlan | null,
    extraMetadata: Record<string, unknown> | null = null,
  ) => {
    const captured = latest.current;
    const epoch = generation.current;
    if (pending.current) throw new Error("A browser task is already opening.");
    if (!captured.canWrite || !captured.ready) throw new Error("Wait for this conversation and browser selection to be ready.");
    const host = hostOf(captured);
    const unavailable = browserRequestUnavailableReason(request, host);
    if (unavailable) throw new Error(unavailable);
    const transport = browserRequestTransport(request, captured.transport, host);
    const autoStarted = plan !== null;
    // Studio starts only the browser on this device by itself, never
    // Instafy's hosted browser (see browserAutoStartPlan).
    if (autoStarted && (plan.kind !== "personal" || transport !== "personal")) throw new BrowserAutoStartDropped();
    pending.current = true;
    try {
      captured.activate(transport, plan);
      // Only a press for Instafy's browser may first start the space's
      // machine; the browser on this device keeps the shorter bound.
      const deadline = Date.now() +
        (!autoStarted && transport === "shared" ? BROWSER_REQUEST_PRESS_DEADLINE_MS : BROWSER_REQUEST_HANDOFF_DEADLINE_MS);
      let activated = false;
      // Let React commit the chosen surface before considering a cached
      // ready runtime. Identity, closure and explicit location changes cancel
      // the handoff instead of sending it to a different browser.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      for (;;) {
        const current = latest.current;
        if (generation.current !== epoch || !current.canWrite ||
            (activated && (!current.open || current.transport !== transport))) {
          throw new Error("The browser or conversation changed before this task could continue.");
        }
        activated ||= current.open && current.transport === transport;
        if (activated && !current.busy &&
            (transport === "personal" ? current.personalReady : current.sharedReady)) {
          if (autoStarted) {
            // Nobody wrote or started anything while the browser opened.
            if (!autoStartStillApplies(current, key)) throw new BrowserAutoStartDropped();
            // Never a browser in use.
            if (current.auto?.heldByOther) throw new Error(BROWSER_AUTO_START_COPY.inUse);
          }
          const sent = await current.continueTask(transport, browserRequestContinuation(request), {
            display: browserRequestNotice(current.agentName ?? "Octo", request.task),
            metadata: {
              ...(extraMetadata ?? {}),
              [BROWSER_REQUEST_OF_METADATA_KEY]: key,
              ...(autoStarted ? { [BROWSER_AUTO_STARTED_METADATA_KEY]: true } : {}),
            },
            knownHosts: browserRequestDestinations(request.task),
          });
          if (!sent) throw new Error("The browser task was not sent. You can retry from its message.");
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(autoStarted
            ? BROWSER_AUTO_START_COPY.timedOut
            : "The browser is not ready yet. Finish opening it, then retry from the message.");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    } finally {
      pending.current = false;
    }
  }, []);

  /**
   * Runs a press, or a retry, of a card: the card reads Opened once the task
   * went out, and keeps its button with the error when it did not.
   */
  const startByHand = useCallback(async (
    key: string,
    request: BrowserRequest,
    extraMetadata: Record<string, unknown> | null,
  ) => {
    const epoch = generation.current;
    // A pressed card is never also started by itself.
    claimBrowserAutoStart(key);
    try {
      await start(key, request, null, extraMetadata);
      setCardState(key, { kind: "opened" });
    } catch (error: unknown) {
      const message = error instanceof Error && error.message ? error.message : "Unable to continue in the browser.";
      if (generation.current === epoch) {
        setCardState(key, { kind: "button", reason: message });
        latest.current.onError(message);
      }
      throw error;
    }
  }, [setCardState, start]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; completion?: Promise<unknown> }>).detail;
      const captured = latest.current;
      const message = captured.messages.find((entry) => entry.id === detail?.messageId);
      const request = message && browserRequestFromMessage(message);
      if (!message || !request || !detail) return;
      detail.completion = startByHand(browserRequestKey(message), request, null);
    };
    window.addEventListener("instafy:request-browser", handler);
    return () => {
      generation.current += 1;
      window.removeEventListener("instafy:request-browser", handler);
    };
  }, [startByHand]);

  /**
   * Try again for a failed browser run: sends the card's task again, as the
   * same notice naming the card, with the retry's metadata. Never the notice
   * text in its place. Resolves to whether it went out.
   */
  const retryContinuation = useCallback(async (
    promptMessage: ChatMessage,
    retryMetadata: Record<string, unknown>,
  ): Promise<boolean> => {
    const key = readBrowserRequestOf(promptMessage);
    if (!key) return false;
    const card = latest.current.messages.find((message) =>
      browserRequestKey(message) === key && browserRequestFromMessage(message) !== null);
    const request = (card ? browserRequestFromMessage(card) : null) ?? browserRequestFromContinuationPrompt(promptMessage);
    if (!request) {
      latest.current.onError("Couldn't find the browser task to send again.");
      return false;
    }
    try {
      await startByHand(key, request, retryMetadata);
      return true;
    } catch {
      return false;
    }
  }, [startByHand]);

  // The newest card, found once per change of the transcript.
  const newestCardIndex = useMemo(() => {
    let index = options.messages.length - 1;
    while (index >= 0 && !browserRequestFromMessage(options.messages[index]!)) index -= 1;
    return index;
  }, [options.messages]);
  const autoEnabled = Boolean(options.auto);
  const autoRevision = options.auto?.revision ?? "";
  const activeRunIdsKey = options.auto ? [...options.auto.activeRunIds].sort().join(",") : "";

  useEffect(() => {
    const current = latest.current;
    const auto = current.auto;
    if (!auto || !current.canWrite || !current.ready || pending.current) return;
    const index = newestCardIndex;
    if (index < 0 || index >= current.messages.length) return;
    const message = current.messages[index]!;
    const request = browserRequestFromMessage(message)!;
    const key = browserRequestKey(message);
    if (isBrowserAutoStartClaimed(key)) return;
    // Answered already: someone wrote after it, or it was continued.
    if (current.messages.slice(index + 1).some((entry) => entry.role === "user")) return;
    if (browserRequestContinuedKeys(current.messages).has(key)) return;
    // History never starts a browser: only a card that arrived after this
    // conversation was opened, and within ten minutes.
    if (!isRunFailureRecentForAutoRetry(message) || message.timestamp < openedAt.current - 1_000) return;
    // Only the tab whose own prompt started the run that sent the card, by
    // the person who sent it, and never for a card a browser turn sent.
    const jobId = browserRequestJobId(message);
    const sent = jobId ? findPromptSentFromThisPageForRun(jobId) : null;
    if (!jobId || !sent) return;
    const sentMetadata = typeof sent.metadata === "object" && sent.metadata !== null && !Array.isArray(sent.metadata)
      ? sent.metadata as Record<string, unknown> : null;
    if (!isRunFailurePromptFromThisClient({
      promptMessage: { authorId: null, metadata: sentMetadata },
      currentUserId: auto.currentUserId,
      chatClientSessionId: auto.chatClientSessionId,
    })) return;
    if (isBrowserTurnPromptMetadata(sent.metadata)) return;
    // Wait for that run to finish and for the person to see this tab.
    if (current.busy || auto.activeRunIds.has(jobId) || !visible) return;

    // Settled for good: the card is left to the person on this page.
    const leave = (reason: string | null) => {
      claimBrowserAutoStart(key);
      setCardState(key, { kind: "button", reason });
    };
    const conversation = current.identity;
    if (isBrowserAutoStartDeclined(conversation) || browserAutoStartedRecently(conversation)) {
      leave(null);
      return;
    }
    // An address Octo found itself, such as on a page or in a search result,
    // is the person's to check first.
    if (!browserAutoStartAddressesSeen({
      task: request.task,
      messages: current.messages,
      cardIndex: index,
      currentUserId: auto.currentUserId,
    })) {
      leave(BROWSER_AUTO_START_COPY.unseenAddress);
      return;
    }
    const host = hostOf(current);
    // The card says itself why no browser opens here.
    if (browserRequestUnavailableReason(request, host)) return;
    // Held for now: the button shows why, and the card is looked at again
    // once that changes.
    if (auto.blocked) {
      setCardState(key, { kind: "button", reason: auto.blocked.reason });
      return;
    }
    if (auto.heldByOther) {
      setCardState(key, { kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
      return;
    }
    const plan = auto.plan(request, browserRequestTransport(request, current.transport, host));
    if (plan.kind === "button") {
      setCardState(key, { kind: "button", reason: plan.reason });
      return;
    }
    if (!claimBrowserAutoStart(key)) return;
    recordBrowserAutoStart(conversation);
    setCardState(key, { kind: "opening", note: null });
    const epoch = generation.current;
    void start(key, request, plan).then(
      () => setCardState(key, { kind: "opened" }),
      (error: unknown) => {
        if (error instanceof BrowserAutoStartDropped) {
          setCardState(key, { kind: "button", reason: null });
          return;
        }
        const reason = error instanceof Error && error.message ? error.message : BROWSER_AUTO_START_COPY.timedOut;
        setCardState(key, { kind: "button", reason });
        if (generation.current === epoch) latest.current.onError(reason);
      },
    );
  }, [
    activeRunIdsKey,
    autoEnabled,
    autoRevision,
    newestCardIndex,
    options.busy,
    options.canWrite,
    options.identity,
    options.messages,
    options.ready,
    setCardState,
    start,
    visible,
  ]);

  return { cardStates, retryContinuation };
}
