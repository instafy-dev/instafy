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
  sharedBrowserHostHeldByOther,
  type BrowserAutoStartPlan,
  type SharedBrowserPresence,
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
import type { SharedBrowserHostRefresh } from "./useSharedBrowserHostSnapshot";

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
   * Reads Instafy's browser on the conversation's machine again (see
   * useSharedBrowserHostSnapshot). A `pending` plan asks for it; an `attach`
   * start forces one before it sends.
   */
  refreshHost?: SharedBrowserHostRefresh;
  /** Who else is in Instafy's browser, from its collaboration roster; null before it is open. */
  presence?: SharedBrowserPresence | null;
  /**
   * Changes whenever something the decision reads changes (a draft, the
   * layout, who holds the browser, this space's runtimes, the last reading
   * of the space's browser), so a card held by one of them is looked at
   * again once it clears.
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
  /** The machine Instafy's browser is open on (or opening on). */
  sharedRuntimeId?: string | null;
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
 * plus a start of Instafy's browser on the space's machine fit in it. It also
 * bounds every wait before the task is sent, such as for the browser's
 * roster to connect.
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

/** How often an automatic start into Instafy's browser reads it again while it waits to send. */
export const BROWSER_AUTO_START_HOST_CHECK_MS = 1_000;

/** What a promise settles to before the deadline; null when it fails or is later. */
function settledBefore<T>(promise: Promise<T | null> | null, deadline: number): Promise<T | null> {
  if (!promise) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      () => { window.clearTimeout(timer); resolve(null); },
    );
  });
}

const BROWSER_CHANGED_MESSAGE = "The browser or conversation changed before this task could continue.";

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
 * - only where browserAutoStartPlan allows it: the browser in the desktop app
 *   for a person on their own AI, or Instafy's browser on the conversation's
 *   own machine in a space the controller covers, when nobody else has it,
 *   controls it, runs in it or is starting it. A separate browser session
 *   and every other case leave the card a button, with the reason;
 * - and, checked again once the browser is ready, only while nobody wrote
 *   after the card, the conversation is idle and no one else holds the
 *   browser. For Instafy's browser, Studio also waits for its roster to
 *   connect and for a fresh reading that says it is ready, and it stays on
 *   the machine it opened; only a known conflict refuses, and the two-minute
 *   bound ends every wait.
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
  // A card Studio has not claimed yet because it waits on a reading of
  // Instafy's browser, or because that browser is someone else's for now.
  const [autoWaiting, setAutoWaiting] = useState(false);
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
    // Studio starts by itself only the browser on this device, or Instafy's
    // browser on the conversation's own machine (see browserAutoStartPlan).
    if (autoStarted &&
        !(plan.kind === "personal" && transport === "personal") &&
        !(plan.kind === "attach" && transport === "shared")) {
      throw new BrowserAutoStartDropped();
    }
    const attachRuntimeId = plan?.kind === "attach" ? plan.runtimeId : null;
    pending.current = true;
    try {
      captured.activate(transport, plan);
      // Only a press for Instafy's browser may first start the space's
      // machine; the browser on this device keeps the shorter bound.
      const deadline = Date.now() +
        (!autoStarted && transport === "shared" ? BROWSER_REQUEST_PRESS_DEADLINE_MS : BROWSER_REQUEST_HANDOFF_DEADLINE_MS);
      let activated = false;
      let activatedAtMs = 0;
      // Instafy's browser on the space's machine: whether the browser has
      // shown that machine yet, and the last forced reading of it.
      let attachBound = false;
      let hostReading: Awaited<ReturnType<SharedBrowserHostRefresh>> = null;
      let hostCheckedAtMs = Number.NEGATIVE_INFINITY;
      // Let React commit the chosen surface before considering a cached
      // ready runtime. Identity, closure and explicit location changes cancel
      // the handoff instead of sending it to a different browser.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      for (;;) {
        const current = latest.current;
        if (generation.current !== epoch || !current.canWrite ||
            (activated && (!current.open || current.transport !== transport))) {
          throw new Error(BROWSER_CHANGED_MESSAGE);
        }
        if (!activated && current.open && current.transport === transport) {
          activated = true;
          activatedAtMs = Date.now();
        }
        if (attachRuntimeId && activated) {
          const sameRuntime = (current.sharedRuntimeId ?? null) === attachRuntimeId;
          // Once the browser showed that machine, it never moves elsewhere.
          if (attachBound && !sameRuntime) throw new Error(BROWSER_CHANGED_MESSAGE);
          attachBound ||= sameRuntime;
        }
        if (activated && !current.busy &&
            (transport === "personal" ? current.personalReady : current.sharedReady) &&
            (!attachRuntimeId || attachBound)) {
          if (autoStarted) {
            // Nobody wrote or started anything while the browser opened.
            if (!autoStartStillApplies(current, key)) throw new BrowserAutoStartDropped();
          }
          if (attachRuntimeId) {
            const auto = current.auto!;
            // The roster has not connected yet: wait for it rather than
            // guess who else is there.
            let wait = auto.presence?.status !== "known";
            if (!wait) {
              const now = Date.now();
              if (now - hostCheckedAtMs >= BROWSER_AUTO_START_HOST_CHECK_MS) {
                hostCheckedAtMs = now;
                // A reading that does not answer before the deadline counts
                // as none, so the deadline still ends the wait.
                hostReading = await settledBefore(auto.refreshHost?.({ force: true }) ?? null, deadline);
              }
              // A reading from before the browser opened, or one that is not
              // ready yet, is waited out.
              wait = !hostReading?.snapshot || hostReading.fetchedAtMs < activatedAtMs ||
                hostReading.snapshot.state !== "ready";
            }
            if (wait) {
              if (Date.now() >= deadline) {
                // The roster could not connect: say so rather than that the
                // browser did not start.
                throw new Error(latest.current.auto?.presence?.status === "unavailable"
                  ? BROWSER_AUTO_START_COPY.presenceUnavailable
                  : BROWSER_AUTO_START_COPY.timedOut);
              }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
              continue;
            }
            // Re-read after the await: the conversation may have moved on.
            const settled = latest.current;
            if (generation.current !== epoch || !settled.open || settled.transport !== transport ||
                (settled.sharedRuntimeId ?? null) !== attachRuntimeId) {
              throw new Error(BROWSER_CHANGED_MESSAGE);
            }
            if (!autoStartStillApplies(settled, key)) throw new BrowserAutoStartDropped();
            // Only a known conflict refuses.
            if (settled.auto?.heldByOther || settled.auto?.presence?.remoteController === true ||
                sharedBrowserHostHeldByOther(hostReading!.snapshot!)) {
              throw new Error(BROWSER_AUTO_START_COPY.inUse);
            }
          } else if (autoStarted && current.auto?.heldByOther) {
            // Never a browser in use.
            throw new Error(BROWSER_AUTO_START_COPY.inUse);
          }
          const sending = latest.current;
          const sent = await sending.continueTask(transport, browserRequestContinuation(request), {
            display: browserRequestNotice(sending.agentName ?? "Octo", request.task),
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

  /**
   * Decides the newest card once: starts it, leaves it a button, or waits.
   * True only while it is left unclaimed until a reading of Instafy's
   * browser says more (a `pending` plan, or the browser is in use for now).
   */
  function decideNewestCard(): boolean {
    const current = latest.current;
    const auto = current.auto;
    if (!auto || !current.canWrite || !current.ready || pending.current) return false;
    const index = newestCardIndex;
    if (index < 0 || index >= current.messages.length) return false;
    const message = current.messages[index]!;
    const request = browserRequestFromMessage(message)!;
    const key = browserRequestKey(message);
    if (isBrowserAutoStartClaimed(key)) return false;
    // Answered already: someone wrote after it, or it was continued.
    if (current.messages.slice(index + 1).some((entry) => entry.role === "user")) return false;
    if (browserRequestContinuedKeys(current.messages).has(key)) return false;
    // History never starts a browser: only a card that arrived after this
    // conversation was opened, and within ten minutes.
    if (!isRunFailureRecentForAutoRetry(message) || message.timestamp < openedAt.current - 1_000) return false;
    // Only the tab whose own prompt started the run that sent the card, by
    // the person who sent it, and never for a card a browser turn sent.
    const jobId = browserRequestJobId(message);
    const sent = jobId ? findPromptSentFromThisPageForRun(jobId) : null;
    if (!jobId || !sent) return false;
    const sentMetadata = typeof sent.metadata === "object" && sent.metadata !== null && !Array.isArray(sent.metadata)
      ? sent.metadata as Record<string, unknown> : null;
    if (!isRunFailurePromptFromThisClient({
      promptMessage: { authorId: null, metadata: sentMetadata },
      currentUserId: auto.currentUserId,
      chatClientSessionId: auto.chatClientSessionId,
    })) return false;
    if (isBrowserTurnPromptMetadata(sent.metadata)) return false;
    // Wait for that run to finish and for the person to see this tab.
    if (current.busy || auto.activeRunIds.has(jobId) || !visible) return false;

    // Settled for good: the card is left to the person on this page.
    const leave = (reason: string | null) => {
      claimBrowserAutoStart(key);
      setCardState(key, { kind: "button", reason });
    };
    const conversation = current.identity;
    if (isBrowserAutoStartDeclined(conversation) || browserAutoStartedRecently(conversation)) {
      leave(null);
      return false;
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
      return false;
    }
    const host = hostOf(current);
    // The card says itself why no browser opens here.
    if (browserRequestUnavailableReason(request, host)) return false;
    // Held for now: the button shows why, and the card is looked at again
    // once that changes.
    if (auto.blocked) {
      setCardState(key, { kind: "button", reason: auto.blocked.reason });
      return false;
    }
    if (auto.heldByOther) {
      setCardState(key, { kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
      return false;
    }
    const plan = auto.plan(request, browserRequestTransport(request, current.transport, host));
    // Instafy's browser on the space's machine needs a fresh reading first:
    // the reading changes the revision, and the card is decided again.
    if (plan.kind === "pending") {
      void auto.refreshHost?.();
      return true;
    }
    if (plan.kind === "button") {
      setCardState(key, { kind: "button", reason: plan.reason });
      // In use for now: read the browser again until it is free.
      return plan.reason === BROWSER_AUTO_START_COPY.hostInUse;
    }
    if (!claimBrowserAutoStart(key)) return false;
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
    return false;
  }

  useEffect(() => {
    // Whether the newest card waits on Instafy's browser (see autoWaiting).
    setAutoWaiting(decideNewestCard());
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return { cardStates, retryContinuation, autoWaiting };
}
