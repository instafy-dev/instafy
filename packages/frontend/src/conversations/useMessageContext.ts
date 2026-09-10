import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMessageContext, MessageContextUnavailableError, type MessageContextPage } from "../services/runtimeController/messageContext";
import { mapControllerMessageToChat } from "./conversationMessageUtils";

export type MessageContextTarget = {
  userId: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  visitKey: string;
};
type WindowState = { key: string; page: MessageContextPage | null; loading: boolean; error: string | null; unavailable: boolean; accessDenied?: boolean };

/** A contiguous window around a target; never splice disjoint recent history into it. */
export function useMessageContext(target: MessageContextTarget | null) {
  const key = target ? JSON.stringify([target.userId, target.projectId, target.conversationId, target.messageId, target.visitKey]) : null;
  const [state, setState] = useState<WindowState | null>(null);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef<{ key: string; controller: AbortController; busy: boolean } | null>(null);
  const latestRef = useRef({ key, target, state });
  latestRef.current = { key, target, state };

  useEffect(() => {
    if (!key) { setState(null); return; }
    const selected = latestRef.current.target;
    if (!selected) return;
    const request = { key, controller: new AbortController(), busy: true };
    requestRef.current = request;
    setState({ key, page: null, loading: true, error: null, unavailable: false });
    void fetchMessageContext({ ...selected, signal: request.controller.signal }).then((page) => {
      if (!request.controller.signal.aborted && latestRef.current.key === key) {
        setState({ key, page, loading: false, error: null, unavailable: false });
      }
    }).catch((error: unknown) => {
      if (!request.controller.signal.aborted && latestRef.current.key === key) {
        setState({ key, page: null, loading: false, error: error instanceof Error ? error.message : "Unable to load this message.", unavailable: error instanceof MessageContextUnavailableError,
          accessDenied: error instanceof MessageContextUnavailableError && error.accessDenied });
      }
    }).finally(() => { request.busy = false; });
    return () => { request.controller.abort(); if (requestRef.current === request) requestRef.current = null; };
  }, [key, revision]);

  const load = useCallback(async (direction: "older" | "newer") => {
    const { key: currentKey, target: selected, state: current } = latestRef.current;
    const request = requestRef.current;
    if (!selected || !currentKey || current?.key !== currentKey || !current.page || current.unavailable ||
      !request || request.key !== currentKey || request.busy || request.controller.signal.aborted) return;
    const page = current.page;
    const cursor = direction === "older" ? page.olderCursor : page.newerCursor;
    if (!cursor || !(direction === "older" ? page.hasOlder : page.hasNewer)) return;
    request.busy = true;
    setState({ ...current, loading: true, error: null });
    try {
      const next = await fetchMessageContext({ ...selected, messageId: cursor,
        before: direction === "older" ? 40 : 0, after: direction === "newer" ? 40 : 0,
        signal: request.controller.signal });
      if (request.controller.signal.aborted || latestRef.current.key !== currentKey) return;
      // Server order is authoritative (timestamps may differ below millisecond precision).
      const joined = direction === "older" ? [...page.messages, ...next.messages] : [...next.messages, ...page.messages];
      const seen = new Set<string>();
      const messages = joined.filter((message) => !seen.has(message.id) && Boolean(seen.add(message.id)));
      setState({ key: currentKey, loading: false, error: null, unavailable: false, page: {
        ...page, messages,
        ...(direction === "older" ? { olderCursor: next.olderCursor, hasOlder: next.hasOlder } : { newerCursor: next.newerCursor, hasNewer: next.hasNewer }),
      } });
    } catch (error) {
      if (request.controller.signal.aborted || latestRef.current.key !== currentKey) return;
      const unavailable = error instanceof MessageContextUnavailableError;
      setState({ ...current, page: unavailable ? null : current.page, loading: false, unavailable,
        accessDenied: error instanceof MessageContextUnavailableError && error.accessDenied,
        error: error instanceof Error ? error.message : "Unable to load messages." });
    } finally { request.busy = false; }
  }, []);

  const current = state?.key === key ? state : null;
  const messages = useMemo(() => [...(current?.page?.messages ?? [])].reverse().map(mapControllerMessageToChat), [current?.page]);
  return {
    messages,
    loading: Boolean(key && (!current || current.loading)),
    error: current?.error ?? null,
    unavailable: current?.unavailable ?? false,
    accessDenied: current?.accessDenied ?? false,
    hasOlder: current?.page?.hasOlder ?? false,
    hasNewer: current?.page?.hasNewer ?? false,
    loadOlder: useCallback(() => load("older"), [load]),
    loadNewer: useCallback(() => load("newer"), [load]),
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
