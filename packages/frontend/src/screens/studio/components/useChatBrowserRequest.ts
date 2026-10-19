import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isRunFailurePromptFromThisClient,
  isRunFailureRecentForAutoRetry,
} from "../../../conversations/runFailurePresentation";
import { findPromptSentFromThisPageForRun } from "../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../types";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartedRecently,
  claimBrowserAutoStart,
  isBrowserAutoStartClaimed,
  isBrowserAutoStartDeclined,
  recordBrowserAutoStart,
  wasBrowserAutoStarted,
  type BrowserAutoStartPlan,
} from "./browserAutoStart";
import {
  BROWSER_AUTO_STARTED_METADATA_KEY,
  BROWSER_REQUEST_OF_METADATA_KEY,
  browserRequestContinuation,
  browserRequestContinuedKeys,
  browserRequestFromMessage,
  browserRequestJobId,
  browserRequestKey,
  browserRequestNotice,
  browserRequestTransport,
  browserRequestUnavailableReason,
  isBrowserTurnPromptMetadata,
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
  /** Studio opened the browser by itself: ask the desktop app for routine control. */
  autoStarted: boolean;
};

/** What Studio needs to start a card by itself. Absent, every card waits for a press. */
export type BrowserAutoStartOptions = {
  currentUserId: string | null;
  chatClientSessionId: string | null;
  /** Run and job ids still working in this conversation. */
  activeRunIds: ReadonlySet<string>;
  /**
   * Why Studio leaves this conversation's cards to the person right now (a
   * draft in the composer, a narrow layout), or null when it may start one.
   */
  blocked: { reason: string | null } | null;
  /** Another person or agent run holds the browser. */
  heldByOther: boolean;
  plan: (request: BrowserRequest, transport: BrowserTransport) => BrowserAutoStartPlan;
  /** A failure the browser surface reported for the automatic start in flight. */
  startFailure: string | null;
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

/** How long a press, or the reuse of a running browser, may take to open it. */
export const BROWSER_REQUEST_HANDOFF_DEADLINE_MS = 120_000;
/** How long switching this space's machine to the browser may take. */
export const BROWSER_REQUEST_CONVERSION_DEADLINE_MS = 240_000;

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
 * - once that run is finished, and once the tab is visible;
 * - once per card on this page, at most once per conversation in ten minutes,
 *   and never after the person closed, paused or stopped the browser there;
 * - when it is cheap (see browserAutoStartPlan): otherwise the card stays a
 *   button, with the reason.
 * A failed start leaves the button and says why.
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
  const [, setAutoStartTick] = useState(0);

  const setCardState = useCallback((key: string, state: BrowserRequestCardState) => {
    setCardStates((current) => new Map(current).set(key, state));
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const start = useCallback(async (message: ChatMessage, request: BrowserRequest, plan: BrowserAutoStartPlan | null) => {
    const captured = latest.current;
    const epoch = generation.current;
    if (pending.current) throw new Error("A browser task is already opening.");
    if (!captured.canWrite || !captured.ready) throw new Error("Wait for this conversation and browser selection to be ready.");
    const host = hostOf(captured);
    const unavailable = browserRequestUnavailableReason(request, host);
    if (unavailable) throw new Error(unavailable);
    const transport = browserRequestTransport(request, captured.transport, host);
    const autoStarted = plan !== null;
    pending.current = true;
    try {
      captured.activate(transport, plan);
      const deadline = Date.now() + (plan?.kind === "convert"
        ? BROWSER_REQUEST_CONVERSION_DEADLINE_MS : BROWSER_REQUEST_HANDOFF_DEADLINE_MS);
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
        if (autoStarted && current.auto?.startFailure) throw new Error(current.auto.startFailure);
        activated ||= current.open && current.transport === transport;
        if (activated && !current.busy && (transport === "personal" ? current.personalReady : current.sharedReady)) {
          // Never take the browser from someone using it.
          if (autoStarted && current.auto?.heldByOther) throw new Error(BROWSER_AUTO_START_COPY.inUse);
          const sent = await current.continueTask(transport, browserRequestContinuation(request), {
            display: browserRequestNotice(current.agentName ?? "Octo", request.task),
            metadata: {
              [BROWSER_REQUEST_OF_METADATA_KEY]: browserRequestKey(message),
              ...(autoStarted ? { [BROWSER_AUTO_STARTED_METADATA_KEY]: true } : {}),
            },
            autoStarted,
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

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; completion?: Promise<unknown> }>).detail;
      const captured = latest.current;
      const message = captured.messages.find((entry) => entry.id === detail?.messageId);
      const request = message && browserRequestFromMessage(message);
      if (!message || !request || !detail) return;
      const epoch = generation.current;
      const key = browserRequestKey(message);
      detail.completion = (async () => {
        // A pressed card is never also started by itself.
        claimBrowserAutoStart(key);
        await start(message, request, null);
        setCardState(key, { kind: "opened" });
      })().catch((error: unknown) => {
        if (generation.current === epoch) latest.current.onError(error instanceof Error ? error.message : "Unable to continue in the browser.");
        throw error;
      });
    };
    window.addEventListener("instafy:request-browser", handler);
    return () => {
      generation.current += 1;
      window.removeEventListener("instafy:request-browser", handler);
    };
  }, [setCardState, start]);

  // The newest card, found once per change of the transcript.
  const newestCardIndex = useMemo(() => {
    let index = options.messages.length - 1;
    while (index >= 0 && !browserRequestFromMessage(options.messages[index]!)) index -= 1;
    return index;
  }, [options.messages]);
  const autoEnabled = Boolean(options.auto);
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

    // From here the card is decided once on this page.
    if (!claimBrowserAutoStart(key)) return;
    const conversation = current.identity;
    if (isBrowserAutoStartDeclined(conversation) || browserAutoStartedRecently(conversation)) {
      setCardState(key, { kind: "button", reason: null });
      return;
    }
    const host = hostOf(current);
    // The card says itself why no browser opens here.
    if (browserRequestUnavailableReason(request, host)) return;
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
    recordBrowserAutoStart(conversation);
    setAutoStartTick((tick) => tick + 1);
    setCardState(key, {
      kind: "opening",
      note: plan.kind === "convert" ? BROWSER_AUTO_START_COPY.converting : null,
    });
    const epoch = generation.current;
    void start(message, request, plan).then(
      () => setCardState(key, { kind: "opened" }),
      (error: unknown) => {
        const reason = error instanceof Error && error.message ? error.message : BROWSER_AUTO_START_COPY.timedOut;
        setCardState(key, { kind: "button", reason });
        if (generation.current === epoch) latest.current.onError(reason);
      },
    );
  }, [
    activeRunIdsKey,
    autoEnabled,
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

  return {
    cardStates,
    /** Studio opened the browser by itself in this conversation, on this page. */
    autoStartedHere: wasBrowserAutoStarted(options.identity),
  };
}
