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
import { browserHandBackOfPromptMetadata } from "./browserHandBack";
import {
  BROWSER_AUTO_STARTED_METADATA_KEY,
  BROWSER_HANDS_BACK_METADATA_KEY,
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
import { SHARED_BROWSER_HOST_COPY, SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS } from "./sharedBrowserHostAttach";
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
   * draft in the composer), or null when it may start one. The layout never
   * holds a card. The card shows the reason only while it holds a card that
   * would otherwise open by itself.
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

/**
 * Instafy's browser on the conversation's own machine, as a press and a card
 * that continues in an open browser see it.
 */
export type SharedBrowserPressHost = {
  /**
   * The conversation's machine when it starts Instafy's browser on demand
   * (conversationBrowserHostId); null otherwise.
   */
  runtimeId: string | null;
  /** Reads that browser again (see useSharedBrowserHostSnapshot). */
  refresh?: SharedBrowserHostRefresh;
  /**
   * Asks the open browser view to attach to its machine again, as the
   * person's own Retry does: it starts the browser when it went idle, and
   * shows why when it cannot.
   */
  reattach?: () => void;
  /** Another agent run or person holds the browser: a press never attaches again then. */
  heldByOther: boolean;
};

/** The error Instafy's browser view shows, and when it appeared. */
export type SharedBrowserViewError = { message: string; atMs: number };

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
  /** Instafy's browser on the conversation's machine; null when there is none. */
  sharedHost?: SharedBrowserPressHost | null;
  /** The error Instafy's browser view shows right now; null when none. */
  sharedError?: SharedBrowserViewError | null;
  /**
   * Since when Instafy's browser has kept answering that it is not running
   * yet, in one unbroken run of page reads; null once a read succeeds.
   */
  sharedNotReadySinceMs?: number | null;
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
 * space's machine first and then its browser. The browser view waits longer
 * for a slow machine (SPACE_MACHINE_COLD_START_TIMEOUT_MS); a card that gives
 * up first offers its button again while the view keeps waiting.
 */
export const BROWSER_REQUEST_PRESS_DEADLINE_MS = 240_000;
/**
 * A press for Instafy's browser on the conversation's machine reads that
 * browser this long after it opened when it was not open already, and then
 * this often while it waits, so a browser that cannot open says so at once.
 */
export const BROWSER_PRESS_HOST_CHECK_MS = 3_000;
/**
 * How long a browser the press opened has to start Instafy's browser itself
 * before the press asks it to attach again.
 */
export const BROWSER_PRESS_REATTACH_AFTER_MS = 10_000;

export const BROWSER_REQUEST_COPY = {
  browserFailed: "Instafy's browser could not open. See the browser for details, then try again.",
} as const;

const SHARED_BROWSER_HOST_MESSAGES = new Set<string>(Object.values(SHARED_BROWSER_HOST_COPY));

/** What a card says when the browser view could not open: its own words when they are plain. */
function browserViewFailure(message: string): string {
  return SHARED_BROWSER_HOST_MESSAGES.has(message) ? message : BROWSER_REQUEST_COPY.browserFailed;
}

/**
 * The machine Instafy's browser is open on, when that is the conversation's
 * own machine with Instafy's browser on demand; null otherwise.
 */
function openSharedBrowserHostId(options: Options): string | null {
  const hostId = options.sharedHost?.runtimeId ?? null;
  return options.open && options.transport === "shared" && hostId && (options.sharedRuntimeId ?? null) === hostId
    ? hostId
    : null;
}

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

/** The card a draft holds right now, and what it says while the hold lasts. */
type DraftHold = { key: string; reason: string | null };

/**
 * What deciding the newest card left: whether it waits on a reading of
 * Instafy's browser, and the card a draft holds.
 */
type CardDecision = { waiting: boolean; draftHold: DraftHold | null };
const DECIDED: CardDecision = { waiting: false, draftHold: null };
const WAITING: CardDecision = { waiting: true, draftHold: null };

function sameDraftHold(a: DraftHold | null, b: DraftHold | null): boolean {
  return a === b || (a !== null && b !== null && a.key === b.key && a.reason === b.reason);
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
 * - never for a card a browser turn sent, so a pause or a denial cannot loop,
 *   nor for one a hand-back turn sent (useBrowserHandBack: one hop only);
 * - for an address the person could have seen ({@link browserAutoStartAddressesSeen});
 * - once that run is finished, and once the tab is visible;
 * - once per card on this page, at most one start that opens the browser per
 *   conversation in ten minutes (a card that continues in Instafy's browser
 *   while it is open on the conversation's machine opens nothing, so the
 *   window does not hold it), and never after the person closed, paused or
 *   stopped the browser there;
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
 *
 * A press for Instafy's browser never waits silently: when the browser view
 * shows an error, or Instafy's browser keeps answering that it is not
 * running for two minutes, the card says so at once. On the conversation's
 * machine it also reads that browser (at once when it was open already,
 * otherwise after three seconds, then every three seconds): a poisoned one,
 * or one that failed again in a new start after the press asked it to
 * attach again, ends the press with the reason. A browser that was open
 * already but shows no page, or whose machine's browser went idle, stopped
 * or failed, is asked once to attach again, never while another run or
 * person holds it.
 *
 * A draft holds a card that would open by itself, and the card says so only
 * while the hold lasts.
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
  // Kept out of cardStates, so the draft's reason goes away with the hold:
  // once the draft is sent or cleared, or a newer card arrives.
  const [draftHold, setDraftHold] = useState<DraftHold | null>(null);
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
    // A press for Instafy's browser reads it while it waits, and may ask the
    // browser view to attach again; an automatic start never does either.
    const pressed = !autoStarted && transport === "shared";
    const wasOpen = captured.open && captured.transport === "shared";
    const startedAtMs = Date.now();
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
      // A press: when it asked the browser view to attach again (once at
      // most), the generation of the browser's run it read then (null while
      // idle; undefined when no reading said), and when it last read the
      // browser.
      let reattachedAtMs: number | null = null;
      let reattachedFromGeneration: string | null | undefined;
      let pressCheckedAtMs = Number.NEGATIVE_INFINITY;
      const reattach = (generation?: string | null) => {
        const sharedHost = latest.current.sharedHost;
        // Never while another run or person holds the browser.
        if (reattachedAtMs !== null || !sharedHost?.reattach || sharedHost.heldByOther) return;
        reattachedAtMs = Date.now();
        reattachedFromGeneration = generation;
        sharedHost.reattach();
      };
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
              ...(request.continueBuilding ? { [BROWSER_HANDS_BACK_METADATA_KEY]: true } : {}),
            },
            knownHosts: browserRequestDestinations(request.task),
          });
          if (!sent) throw new Error("The browser task was not sent. You can retry from its message.");
          return;
        }
        if (transport === "shared" && activated) {
          // The browser view shows why it cannot open: the card says so now
          // instead of waiting out the deadline. An error from before this
          // start is not this start's answer.
          const viewError = current.sharedError ?? null;
          if (viewError && viewError.atMs >= startedAtMs) throw new Error(browserViewFailure(viewError.message));
          // Instafy's browser kept answering that it is not running.
          const notReadySince = current.sharedNotReadySinceMs ?? null;
          if (notReadySince !== null &&
              Date.now() - Math.max(notReadySince, startedAtMs) >= SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS) {
            throw new Error(SHARED_BROWSER_HOST_COPY.didNotOpen);
          }
        }
        if (pressed && activated) {
          const sharedHost = current.sharedHost;
          const readable = Boolean(sharedHost?.refresh && sharedHost.runtimeId) &&
            (current.sharedRuntimeId ?? null) === sharedHost?.runtimeId;
          // A browser that was open already and still shows no page. One that
          // shows its page and only waits for the conversation is left alone.
          const openWithoutPage = wasOpen && !current.sharedReady;
          if (!readable) {
            // Not Instafy's browser on the conversation's machine.
            if (openWithoutPage) reattach();
          } else {
            const now = Date.now();
            if ((wasOpen || now - activatedAtMs >= BROWSER_PRESS_HOST_CHECK_MS) &&
                now - pressCheckedAtMs >= BROWSER_PRESS_HOST_CHECK_MS) {
              pressCheckedAtMs = now;
              const reading = await settledBefore(sharedHost!.refresh!({ force: true }), deadline);
              const snapshot = reading && reading.fetchedAtMs >= startedAtMs ? reading.snapshot : null;
              if (snapshot) {
                if (snapshot.state === "poisoned") throw new Error(SHARED_BROWSER_HOST_COPY.poisoned);
                // It failed again in a start after the browser view was asked
                // to attach again: a newer generation than the one read then.
                // The run that had failed before is not this press's answer;
                // without a reading then, the view's own error says it.
                if (snapshot.state === "failed" && reattachedFromGeneration !== undefined &&
                    snapshot.generation !== null && snapshot.generation !== reattachedFromGeneration) {
                  throw new Error(SHARED_BROWSER_HOST_COPY.didNotOpen);
                }
                // Attach again when the browser was open already and shows no
                // page, or when its browser went idle, is stopping or failed
                // after the view had its chance to start it; never while
                // another person's run works in it.
                const otherRun = snapshot.agentRunActive && !snapshot.agentRunStartedByYou;
                const stalled = snapshot.state === "idle" || snapshot.state === "stopping" || snapshot.state === "failed";
                if (!otherRun && (openWithoutPage || (stalled && Date.now() - activatedAtMs >= BROWSER_PRESS_REATTACH_AFTER_MS))) {
                  reattach(snapshot.generation);
                }
              } else if (openWithoutPage) {
                // No reading: attach again anyway; the view says why it cannot.
                reattach();
              }
              continue;
            }
          }
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
   * Runs a press, or a retry, of a card: the card reads Browser opened once
   * the task went out, and keeps its button with the error when it did not.
   */
  const startByHand = useCallback(async (
    key: string,
    request: BrowserRequest,
    extraMetadata: Record<string, unknown> | null,
  ) => {
    const epoch = generation.current;
    // A pressed card is never also started by itself, and no draft holds it
    // any more: the card shows how the press goes.
    claimBrowserAutoStart(key);
    setDraftHold((current) => current?.key === key ? null : current);
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
   * Waiting means it is left unclaimed until a reading of Instafy's browser
   * says more (a `pending` plan, or the browser is in use for now). A draft
   * holds only a card that would otherwise open by itself now.
   */
  function decideNewestCard(): CardDecision {
    const current = latest.current;
    const auto = current.auto;
    if (!auto || !current.canWrite || !current.ready || pending.current) return DECIDED;
    const index = newestCardIndex;
    if (index < 0 || index >= current.messages.length) return DECIDED;
    const message = current.messages[index]!;
    const request = browserRequestFromMessage(message)!;
    const key = browserRequestKey(message);
    if (isBrowserAutoStartClaimed(key)) return DECIDED;
    // Answered already: someone wrote after it, or it was continued.
    if (current.messages.slice(index + 1).some((entry) => entry.role === "user")) return DECIDED;
    if (browserRequestContinuedKeys(current.messages).has(key)) return DECIDED;
    // History never starts a browser: only a card that arrived after this
    // conversation was opened, and within ten minutes.
    if (!isRunFailureRecentForAutoRetry(message) || message.timestamp < openedAt.current - 1_000) return DECIDED;
    // Only the tab whose own prompt started the run that sent the card, by
    // the person who sent it, and never for a card a browser turn sent.
    const jobId = browserRequestJobId(message);
    const sent = jobId ? findPromptSentFromThisPageForRun(jobId) : null;
    if (!jobId || !sent) return DECIDED;
    const sentMetadata = typeof sent.metadata === "object" && sent.metadata !== null && !Array.isArray(sent.metadata)
      ? sent.metadata as Record<string, unknown> : null;
    if (!isRunFailurePromptFromThisClient({
      promptMessage: { authorId: null, metadata: sentMetadata },
      currentUserId: auto.currentUserId,
      chatClientSessionId: auto.chatClientSessionId,
    })) return DECIDED;
    if (isBrowserTurnPromptMetadata(sent.metadata)) return DECIDED;
    // Nor for a card a hand-back turn sent: one automatic hop only, so the
    // card stays a button for the person to press.
    if (browserHandBackOfPromptMetadata(sent.metadata)) return DECIDED;
    // Wait for that run to finish and for the person to see this tab.
    if (current.busy || auto.activeRunIds.has(jobId) || !visible) return DECIDED;

    // Settled for good: the card is left to the person on this page.
    const leave = (reason: string | null) => {
      claimBrowserAutoStart(key);
      setCardState(key, { kind: "button", reason });
    };
    const conversation = current.identity;
    if (isBrowserAutoStartDeclined(conversation)) {
      leave(null);
      return DECIDED;
    }
    // A card that continues in Instafy's browser while it is open on the
    // conversation's machine starts nothing new, so the once-per-conversation
    // window does not hold it; every other check still does.
    const openHostId = openSharedBrowserHostId(current);
    if (!openHostId && browserAutoStartedRecently(conversation)) {
      leave(null);
      return DECIDED;
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
      return DECIDED;
    }
    const host = hostOf(current);
    // The card says itself why no browser opens here.
    if (browserRequestUnavailableReason(request, host)) return DECIDED;
    // Held for now: the button shows why, and the card is looked at again
    // once that changes.
    if (auto.heldByOther) {
      setCardState(key, { kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
      return DECIDED;
    }
    const plan = auto.plan(request, browserRequestTransport(request, current.transport, host));
    // Instafy's browser on the space's machine needs a fresh reading first:
    // the reading changes the revision, and the card is decided again. A
    // draft that holds this card keeps saying so meanwhile.
    if (plan.kind === "pending") {
      void auto.refreshHost?.();
      return {
        waiting: true,
        draftHold: auto.blocked && draftHold?.key === key ? { key, reason: auto.blocked.reason } : null,
      };
    }
    // Studio does not open this card by itself: the button says why, also
    // over a draft.
    if (plan.kind === "button") {
      setCardState(key, { kind: "button", reason: plan.reason });
      // In use for now: read the browser again until it is free.
      return plan.reason === BROWSER_AUTO_START_COPY.hostInUse ? WAITING : DECIDED;
    }
    // Only a continuation in that same open browser skips the window.
    if (openHostId && (plan.kind !== "attach" || plan.runtimeId !== openHostId) &&
        browserAutoStartedRecently(conversation)) {
      leave(null);
      return DECIDED;
    }
    // It would open by itself now, but the person is writing: it waits, and
    // says why only while the draft holds it.
    if (auto.blocked) {
      setCardState(key, { kind: "button", reason: null });
      return { waiting: false, draftHold: { key, reason: auto.blocked.reason } };
    }
    if (!claimBrowserAutoStart(key)) return DECIDED;
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
    return DECIDED;
  }

  useEffect(() => {
    const decision = decideNewestCard();
    // Whether the newest card waits on Instafy's browser (see autoWaiting).
    setAutoWaiting(decision.waiting);
    setDraftHold((current) => sameDraftHold(current, decision.draftHold) ? current : decision.draftHold);
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
    options.open,
    options.ready,
    options.sharedRuntimeId,
    setCardState,
    start,
    visible,
  ]);

  // The draft's reason shows on the card it holds, over what the card said
  // before the hold.
  const shownCardStates = useMemo(() => {
    if (!draftHold) return cardStates;
    const held: BrowserRequestCardState = { kind: "button", reason: draftHold.reason };
    return sameCardState(cardStates.get(draftHold.key), held) ? cardStates : new Map(cardStates).set(draftHold.key, held);
  }, [cardStates, draftHold]);

  return { cardStates: shownCardStates, retryContinuation, autoWaiting };
}
