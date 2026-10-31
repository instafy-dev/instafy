import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";
import {
  CONTROL_ACTION_ANSWER_MS,
  CONTROL_ACTION_NO_ANSWER,
  CONTROL_ACTION_OFFLINE,
} from "./SharedBrowserCollaborationControls";

export type BrowserHumanInputRequest = {
  version: 1;
  handoffId: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
  fields: Array<{ label: string }>;
};

// True whether or not the person did anything while they had control: Let
// AI continue also follows a take-over where they only watched.
export const BROWSER_HUMAN_INPUT_CONTINUE_PROMPT =
  "Continue the previous browser task on this same page. I may have used the browser while I had control. Take a fresh snapshot before acting; do not reuse old target indices or request, reveal, or repeat any values I may have entered.";

/**
 * The button's own words. The chat shows them for the turn the button starts,
 * in the person's name: they pressed it and wrote nothing, so the prompt above
 * goes to Octo only.
 */
export const LET_OCTO_CONTINUE = "Let Octo continue";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A prompt that a press of Let Octo continue sent: what it dispatched (its
 * stored `dispatchContent`, also under the stored prompt's metadata after a
 * reload) is the continuation prompt, whatever the chat shows for it. Try
 * again on its turn presses it again; it never sends the words shown.
 */
export function isLetOctoContinuePrompt(message: Pick<ChatMessage, "role" | "metadata">): boolean {
  if (message.role !== "user" || !isRecord(message.metadata)) return false;
  const metadata = message.metadata;
  return [metadata, metadata["promptMetadata"], metadata["prompt_metadata"]].some((record) =>
    isRecord(record) &&
    typeof record["dispatchContent"] === "string" &&
    record["dispatchContent"].trim() === BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
}

export type BrowserHumanInputOptions = {
  /** Include user, project, conversation, transport, runtime/page (or native owner). */
  identityKey: string;
  /** Caller must validate exact user/runtime/page/origin before passing a request. */
  request: BrowserHumanInputRequest | null;
  canTakeOver: boolean;
  /** Live origin ownership / native revoked capability, never canceled-run status. */
  humanControlConfirmed: boolean;
  canContinue?: boolean;
  /**
   * Take control's call, while nobody holds the browser and this person may
   * take it. Let Octo continue then takes control first and goes on once the
   * browser confirms it (`humanControlConfirmed`). False means nothing was
   * sent.
   */
  takeControl?: (() => boolean | void) | null;
  /** A click on a native surface requests the same confirmation as the DOM surface. */
  takeoverRequestId?: string;
  /** Callbacks must preserve the captured exact target across their own awaits. */
  onTakeOver: () => Promise<boolean | void>;
  onContinue: (message: string) => Promise<boolean>;
};

export function useBrowserHumanInput(options: BrowserHumanInputOptions) {
  const {
    identityKey, request, canTakeOver, humanControlConfirmed, canContinue = true, takeControl = null, onTakeOver, onContinue,
  } = options;
  const [startedIdentity, setStartedIdentity] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"takeover" | "continue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [takeoverIdentity, setTakeoverIdentity] = useState<string | null>(null);
  // Let Octo continue took control of a browser nobody held; it goes on once
  // the browser confirms that control for this identity.
  const [continueOnControl, setContinueOnControl] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const identityRef = useRef(identityKey);
  const busyRef = useRef(false);
  const seenTakeoverRequest = useRef<string | null>(null);
  // Invalidate stale asynchronous completions during render, before effects.
  if (identityRef.current !== identityKey) {
    identityRef.current = identityKey;
    generation.current += 1;
    busyRef.current = false;
  }
  useEffect(() => {
    setStartedIdentity(null);
    setDismissedId(null);
    setBusy(null);
    setError(null);
    setTakeoverIdentity(null);
    setContinueOnControl(null);
  }, [identityKey]);
  useEffect(() => {
    const key = options.takeoverRequestId ? `${identityKey}:${options.takeoverRequestId}` : null;
    if (!key || seenTakeoverRequest.current === key) return;
    seenTakeoverRequest.current = key;
    if (canTakeOver) setTakeoverIdentity(identityKey);
  }, [options.takeoverRequestId, identityKey, canTakeOver]);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    if (!request) return;
    setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, request.expiresAtMs - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [request]);
  const liveRequest = request && request.expiresAtMs > now && request.handoffId !== dismissedId ? request : null;
  // Keep only the manual-step UI across a user-driven login/navigation. The
  // origin-bound field guidance may disappear, but continuation still starts a fresh
  // exact-page turn once authoritative human ownership is confirmed.
  useEffect(() => {
    if (liveRequest) setStartedIdentity(identityKey);
  }, [identityKey, liveRequest]);
  const active = Boolean(liveRequest) || startedIdentity === identityKey;

  const takeOver = useCallback(async () => {
    if (!canTakeOver || busyRef.current) return;
    const epoch = generation.current;
    busyRef.current = true;
    setStartedIdentity(identityKey);
    setBusy("takeover");
    setError(null);
    try {
      if (await onTakeOver() === false) throw new Error("Agent control could not be stopped. Try again.");
      if (generation.current === epoch) setTakeoverIdentity(null);
    } catch (cause) {
      if (generation.current === epoch) setError(cause instanceof Error ? cause.message : "Unable to take control.");
    } finally {
      if (generation.current === epoch) { busyRef.current = false; setBusy(null); }
    }
  }, [canTakeOver, identityKey, onTakeOver]);

  const sendContinuation = useCallback(async () => {
    const epoch = generation.current;
    busyRef.current = true;
    setBusy("continue");
    setError(null);
    try {
      const sent = await onContinue(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
      if (generation.current !== epoch) return;
      if (!sent) throw new Error("The browser task was not sent. Your manual input remains on the page; try again when ready.");
      setDismissedId(request?.handoffId ?? null);
      setStartedIdentity(null);
    } catch (cause) {
      if (generation.current === epoch) setError(cause instanceof Error ? cause.message : "Unable to continue.");
    } finally {
      if (generation.current === epoch) { busyRef.current = false; setBusy(null); }
    }
  }, [onContinue, request?.handoffId]);

  const continueTask = useCallback(async () => {
    if (!active || !canContinue || busyRef.current) return;
    if (humanControlConfirmed) return sendContinuation();
    if (!takeControl) return;
    // Nobody holds the browser: take it, as Take control does, then go on.
    busyRef.current = true;
    setBusy("continue");
    setError(null);
    if (takeControl() === false) {
      busyRef.current = false;
      setBusy(null);
      setError(CONTROL_ACTION_OFFLINE);
      return;
    }
    setContinueOnControl(identityKey);
  }, [active, canContinue, humanControlConfirmed, identityKey, sendContinuation, takeControl]);
  const continueTaskRef = useRef(continueTask);
  continueTaskRef.current = continueTask;
  const controlFree = Boolean(takeControl);
  useEffect(() => {
    if (continueOnControl === null || continueOnControl !== identityKey) return;
    if (humanControlConfirmed || !controlFree) {
      setContinueOnControl(null);
      busyRef.current = false;
      setBusy(null);
      // Control came: go on. Someone else took it first (or the browser went
      // away): nothing to wait for, and the toolbar says who holds it now.
      if (humanControlConfirmed) void continueTaskRef.current();
      return;
    }
    const timer = window.setTimeout(() => {
      setContinueOnControl(null);
      busyRef.current = false;
      setBusy(null);
      setError(CONTROL_ACTION_NO_ANSWER);
    }, CONTROL_ACTION_ANSWER_MS);
    return () => window.clearTimeout(timer);
  }, [continueOnControl, controlFree, humanControlConfirmed, identityKey]);

  const requestTakeOver = () => { if (canTakeOver && !busyRef.current) setTakeoverIdentity(identityKey); };
  const dismissTakeOver = () => { if (!busyRef.current) setTakeoverIdentity(null); };
  return { active, request: liveRequest, busy, error, takeOver, continueTask,
    takeoverRequested: takeoverIdentity === identityKey, requestTakeOver, dismissTakeOver };
}
