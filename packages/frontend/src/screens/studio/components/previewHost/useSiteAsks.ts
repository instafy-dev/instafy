import { useCallback, useEffect, useRef, useState } from "react";
import { buildAskStatusMessage, type AskState } from "./hostMessages";
import {
  buildSiteIntentMetadata,
  renderAskMessage,
  studioAskLimiter,
  type AskLimiter,
  type AskRunOutcome,
  type SiteAsk,
} from "./siteAsks";

/**
 * What the conversation around a preview pane offers its site for Ask Octo
 * (docs/Bound-Sites.md §2a). ChatPanel builds it from the same access the
 * composer uses and its own send path, so an ask is exactly the person typing
 * that message: same conversation, same checks, same billing.
 */
export type SiteAskHost = {
  /** True when this person may send messages here; otherwise the plain reason they may not. */
  canAsk: true | string;
  /** The person asking, for the caps (per person and site). */
  userId: string | null;
  /**
   * Sends `text` as the person's own message, with `metadata`. False when
   * nothing was sent; the chat has already said why.
   */
  send: (message: { text: string; metadata: Record<string, unknown> }) => Promise<boolean>;
  /** What became of each ask's run in this conversation (siteAsks.ts askOutcomesFromRuns). */
  outcomes: ReadonlyMap<string, AskRunOutcome>;
};

/** The page's button gives up after 5 s without an answer; "sent" goes before that even if sending is slow. */
export const ASK_SENT_DEADLINE_MS = 3_000;

export const ASK_NOT_SENT_TEXT = "It wasn't sent. Try again, or ask in the chat.";
export const ASK_HIDDEN_TEXT = "Open this page in Instafy to ask Octo.";
export const ASK_UNREADABLE_TEXT = "Instafy could not read this question, so it wasn't sent.";
export const ASK_WAITING_TEXT = "Answer the question waiting in Instafy first.";
export const ASK_CANCELLED_TEXT = "Not sent.";
export const ASK_NO_CLICK_TEXT = "Instafy sends a question only right after you click it on the page.";

/** The one ask waiting for the person's confirm (the intent said `confirm: true`). */
export type PendingAskConfirm = { line: string; send: () => void; cancel: () => void };

export function useSiteAsks({ host, projectId, previewId, siteTitle, frameOnScreen, post, userGesture, limiter = studioAskLimiter }: {
  /** Null where Studio takes no asks: the layout then leaves `caps.ask` out and the site shows none. */
  host: SiteAskHost | null;
  projectId: string;
  previewId: string;
  /** The preview's own title (what Octo named it), never the page's. */
  siteTitle: string;
  frameOnScreen: boolean;
  /** Posts to this pane's frame at the viewer's origin; false when there is no frame. */
  post: (message: unknown) => boolean;
  /**
   * The person just clicked or pressed a key in this pane's frame (frameGesture.ts). An ask is a message from the
   * person who clicks: one a page's script posts on its own is never sent.
   */
  userGesture: () => boolean;
  limiter?: AskLimiter;
}) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const postRef = useRef(post);
  postRef.current = post;
  const onScreenRef = useRef(frameOnScreen);
  onScreenRef.current = frameOnScreen;
  const titleRef = useRef(siteTitle);
  titleRef.current = siteTitle;
  const gestureRef = useRef(userGesture);
  gestureRef.current = userGesture;

  /** Asks sent as a message, until their run ends: id → the caps key. */
  const awaitingRun = useRef(new Map<string, string>());
  const [confirming, setConfirming] = useState<{ ask: SiteAsk; key: string; line: string } | null>(null);
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  const status = useCallback((id: string, state: AskState, reason?: string) => {
    postRef.current(buildAskStatusMessage(id, state, reason));
  }, []);

  const keyFor = useCallback(() => `${hostRef.current?.userId ?? "anonymous"}:${projectId}:${previewId}`, [previewId, projectId]);

  const dispatch = useCallback(async (ask: SiteAsk, key: string, line: string, confirmed = false) => {
    const current = hostRef.current;
    if (!current) { limiter.refund(key, ask.id); status(ask.id, "declined", ASK_HIDDEN_TEXT); return; }
    let answered = false;
    const timer = setTimeout(() => { if (!answered) { answered = true; status(ask.id, "sent"); } }, ASK_SENT_DEADLINE_MS);
    let sent = false;
    try {
      sent = await current.send({ text: line, metadata: buildSiteIntentMetadata(previewId, ask, { confirmed }) });
    } catch {
      sent = false;
    }
    clearTimeout(timer);
    if (sent) {
      if (!answered) status(ask.id, "sent");
      awaitingRun.current.set(ask.id, key);
      return;
    }
    if (answered) { limiter.settle(key, ask.id); status(ask.id, "failed", ASK_NOT_SENT_TEXT); return; }
    limiter.refund(key, ask.id);
    status(ask.id, "declined", ASK_NOT_SENT_TEXT);
  }, [limiter, previewId, status]);

  /** One ask from this pane's frame (the pane checked where it came from). Every page message is a request. */
  const handleAsk = useCallback((ask: SiteAsk) => {
    const current = hostRef.current;
    if (!current) return status(ask.id, "declined", ASK_HIDDEN_TEXT);
    if (current.canAsk !== true) return status(ask.id, "declined", current.canAsk);
    // A page in a hidden pane was not clicked just now: nothing it asks is sent.
    if (!onScreenRef.current) return status(ask.id, "declined", ASK_HIDDEN_TEXT);
    // Nor is an ask nobody just clicked: a page's own script cannot send messages as the person.
    if (!gestureRef.current()) return status(ask.id, "declined", ASK_NO_CLICK_TEXT);
    if (confirmingRef.current) return status(ask.id, "declined", ASK_WAITING_TEXT);
    const key = keyFor();
    const admitted = limiter.admit(key, ask.id);
    if (!admitted.ok) {
      // A repeated id was answered the first time: a page that sends it again asks nothing.
      if (admitted.duplicate) return;
      return status(ask.id, "declined", admitted.reason);
    }
    const line = renderAskMessage(ask, titleRef.current);
    if (ask.confirm) {
      status(ask.id, "confirm");
      const next = { ask, key, line };
      confirmingRef.current = next;
      setConfirming(next);
      return;
    }
    void dispatch(ask, key, line);
  }, [dispatch, keyFor, limiter, status]);

  const handleInvalid = useCallback((id: string) => { status(id, "declined", ASK_UNREADABLE_TEXT); }, [status]);

  const settleConfirm = useCallback((send: boolean) => {
    const waiting = confirmingRef.current;
    if (!waiting) return;
    confirmingRef.current = null;
    setConfirming(null);
    if (!send) { limiter.refund(waiting.key, waiting.ask.id); status(waiting.ask.id, "declined", ASK_CANCELLED_TEXT); return; }
    void dispatch(waiting.ask, waiting.key, waiting.line, true);
  }, [dispatch, limiter, status]);

  // The pane went off screen, or a new document loaded: a confirm nobody is looking at is not left open.
  useEffect(() => { if (!frameOnScreen) settleConfirm(false); }, [frameOnScreen, settleConfirm]);

  // An ask's run started: it holds the slot until it ends. It ended: tell the page, and let the next ask go.
  const outcomes = host?.outcomes;
  useEffect(() => {
    if (!outcomes) return;
    for (const [id, key] of [...awaitingRun.current]) {
      const outcome = outcomes.get(id);
      if (outcome === "running") limiter.running(key, id);
      if (outcome !== "done" && outcome !== "failed") continue;
      awaitingRun.current.delete(id);
      limiter.settle(key, id);
      status(id, outcome, outcome === "failed" ? "Octo could not finish. The chat says why." : undefined);
    }
  }, [limiter, outcomes, status]);

  // Closing the pane ends what it was waiting for, so its slot does not stay taken.
  useEffect(() => () => {
    for (const [id, key] of awaitingRun.current) limiter.settle(key, id);
    awaitingRun.current.clear();
    const waiting = confirmingRef.current;
    if (waiting) limiter.refund(waiting.key, waiting.ask.id);
  }, [limiter]);

  const confirm: PendingAskConfirm | null = confirming
    ? { line: confirming.line, send: () => settleConfirm(true), cancel: () => settleConfirm(false) }
    : null;

  return { caps: host ? host.canAsk : null, handleAsk, handleInvalid, confirm };
}
