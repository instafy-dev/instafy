import { useCallback, useEffect, useRef, useState } from "react";

export type BrowserHumanInputRequest = {
  version: 1;
  handoffId: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
  fields: Array<{ label: string }>;
};

export const BROWSER_HUMAN_INPUT_CONTINUE_PROMPT =
  "I have finished the manual browser step. Continue the previous browser task on this same page. Take a fresh snapshot before acting; do not reuse old target indices or request, reveal, or repeat any values I entered.";

export type BrowserHumanInputOptions = {
  /** Include user, project, conversation, transport, runtime/page (or native owner). */
  identityKey: string;
  /** Caller must validate exact user/runtime/page/origin before passing a request. */
  request: BrowserHumanInputRequest | null;
  canTakeOver: boolean;
  /** Live origin ownership / native revoked capability, never canceled-run status. */
  humanControlConfirmed: boolean;
  canContinue?: boolean;
  /** Callbacks must preserve the captured exact target across their own awaits. */
  onTakeOver: () => Promise<boolean | void>;
  onContinue: (message: string) => Promise<boolean>;
};

export function useBrowserHumanInput(options: BrowserHumanInputOptions) {
  const { identityKey, request, canTakeOver, humanControlConfirmed, canContinue = true, onTakeOver, onContinue } = options;
  const [startedIdentity, setStartedIdentity] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"takeover" | "continue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const identityRef = useRef(identityKey);
  const busyRef = useRef(false);
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
  }, [identityKey]);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    if (!request) return;
    setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, request.expiresAtMs - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [request]);
  const liveRequest = request && request.expiresAtMs > now && request.handoffId !== dismissedId ? request : null;
  // Keep only the manual-step UI across a user-driven login/navigation. The
  // origin-bound field guidance may disappear, but Done still starts a fresh
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
    } catch (cause) {
      if (generation.current === epoch) setError(cause instanceof Error ? cause.message : "Unable to take control.");
    } finally {
      if (generation.current === epoch) { busyRef.current = false; setBusy(null); }
    }
  }, [canTakeOver, identityKey, onTakeOver]);

  const continueTask = useCallback(async () => {
    if (!active || !humanControlConfirmed || !canContinue || busyRef.current) return;
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
  }, [active, canContinue, humanControlConfirmed, onContinue, request?.handoffId]);

  return { active, request: liveRequest, busy, error, takeOver, continueTask };
}
