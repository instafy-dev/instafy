import { createContext, useCallback, useContext, useReducer, useRef, useState, type SetStateAction } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { MOBILE_SIDEBAR_STATE_KEY } from "../screens/useMobileSidebarHistory";
import { getStudioVisitKey } from "./studioVisit";

export interface HomeListState {
  teamFilter: string;
  needsExpanded: boolean;
  recentLimit: number;
  activityPages: number;
}
export const DEFAULT_HOME_LIST_STATE: HomeListState = { teamFilter: "all", needsExpanded: false, recentLimit: 24, activityPages: 1 };

type ListKind = "home" | "chats";
type Visit = { key: string; index: number; kind: ListKind | "conversation" | null };
const EMPTY_RECENT_CHATS: readonly string[] = [];
function newOwner(userId: string | null) {
  return { userId, states: new Map<string, Record<string, unknown>>(), visits: new Map<number, Visit>(), origins: new Map<string, Visit>(), previous: null as Visit | null, recentChats: EMPTY_RECENT_CHATS, lastChat: null as string | null };
}
function kindFor(search: string): Visit["kind"] {
  const params = new URLSearchParams(search);
  if (params.get("panel") === "home") return "home";
  if (params.get("workspaceTab") === "history") return "chats";
  if ((!params.has("panel") || params.get("panel") === "chat") && !params.has("workspaceTab") && (params.has("conversationId") || params.has("conversationControllerId"))) return "conversation";
  return null;
}
function indexFor(key: string): number | null {
  const state = window.history.state;
  return (state?.key ?? "default") === key && Number.isSafeInteger(state?.idx) && state.idx >= 0 ? state.idx : null;
}

/** UI state belongs to a Router visit, not a URL or the previously active space.
 * Only coordinates/filters and return identities live here; no fetched content. */
export function useStudioListNavigation(userId: string | null) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const visitKey = getStudioVisitKey(location);
  const owner = useRef(newOwner(userId));
  const [, update] = useReducer((value: number) => value + 1, 0);
  if (owner.current.userId !== userId) owner.current = newOwner(userId);
  const currentOwner = owner.current;
  const index = indexFor(location.key);
  // Overlay entries retain the underlying visit but must not become its origin.
  const overlay = Boolean(location.state && typeof location.state === "object" && MOBILE_SIDEBAR_STATE_KEY in location.state);
  if (userId && index !== null && !overlay) {
    const route = new URLSearchParams(location.search);
    const chatKey = kindFor(location.search) === "conversation" && route.get("projectId") && route.get("conversationControllerId")
      ? JSON.stringify([route.get("projectId"), route.get("conversationControllerId")]) : null;
    if (chatKey && chatKey !== currentOwner.lastChat) {
      currentOwner.recentChats = [chatKey, ...currentOwner.recentChats.filter(key => key !== chatKey)].slice(0, 24);
    }
    currentOwner.lastChat = chatKey;
    const previous = currentOwner.previous;
    if (previous?.key !== visitKey || previous.index !== index) {
      if (navigationType === "PUSH") {
        for (const [position, visit] of currentOwner.visits) if (position >= index) {
          currentOwner.visits.delete(position);
          currentOwner.origins.delete(visit.key);
          currentOwner.states.delete(visit.key);
        }
      }
      const next: Visit = { key: visitKey, index, kind: kindFor(location.search) };
      if (navigationType === "PUSH" && previous && previous.index < index
        && (previous.kind === "home" || previous.kind === "chats") && next.kind === "conversation") {
        currentOwner.origins.set(visitKey, previous);
      }
      currentOwner.visits.set(index, next);
      currentOwner.previous = next;
      while (currentOwner.visits.size > 100) {
        const oldest = currentOwner.visits.keys().next().value!;
        const visit = currentOwner.visits.get(oldest)!;
        currentOwner.states.delete(visit.key);
        currentOwner.origins.delete(visit.key);
        currentOwner.visits.delete(oldest);
      }
    }
  }
  const getState = useCallback(<T,>(name: string, fallback: T): T =>
    (currentOwner.states.get(visitKey)?.[name] as T | undefined) ?? fallback, [currentOwner, visitKey]);
  const setState = useCallback(<T,>(name: string, value: SetStateAction<T>, fallback: T) => {
    if (!userId || owner.current !== currentOwner) return;
    const states = currentOwner.states.get(visitKey) ?? {};
    const old = (states[name] as T | undefined) ?? fallback;
    const next = typeof value === "function" ? (value as (old: T) => T)(old) : value;
    if (Object.is(old, next)) return;
    currentOwner.states.set(visitKey, { ...states, [name]: next });
    update();
  }, [currentOwner, userId, visitKey]);
  const saved = currentOwner.origins.get(visitKey);
  const origin = userId && !overlay && index !== null && saved && saved.index < index
    && currentOwner.visits.get(saved.index)?.key === saved.key ? saved : null;
  const pending = useRef<string | null>(null);
  if (pending.current !== location.key) pending.current = null;
  const returnToList = useCallback(() => {
    if (!origin || owner.current !== currentOwner || indexFor(location.key) !== index || pending.current === location.key) return;
    pending.current = location.key;
    void navigate(origin.index - index!);
  }, [currentOwner, index, location.key, navigate, origin]);
  return { getState, setState, returnToList, recentChatKeys: currentOwner.recentChats, scrollIdentity: userId ? JSON.stringify([userId, visitKey]) : null, returnLabel: origin ? origin.kind === "home" ? "Back to Home" : "Back to chats" : null };
}

const StudioListContext = createContext<ReturnType<typeof useStudioListNavigation> | null>(null);
export const StudioListNavigationProvider = StudioListContext.Provider;

/** Standalone surfaces still work without a Studio owner (including component previews). */
export function useStudioListState<T>(name: string, initial: T, perVisit = true): [T, (value: SetStateAction<T>) => void] {
  const owner = useContext(StudioListContext);
  const context = perVisit ? owner : null;
  const [local, setLocal] = useState(initial);
  const value = context ? context.getState(name, initial) : local;
  const setValue = useCallback((next: SetStateAction<T>) => {
    if (context) context.setState(name, next, initial);
    else setLocal(next);
  }, [context, initial, name]);
  return [value, setValue];
}

export function useStudioListScrollIdentity(section: string): string | null {
  const context = useContext(StudioListContext);
  return context?.scrollIdentity ? JSON.stringify([context.scrollIdentity, section]) : null;
}

/** Session-only IDs; Home resolves names from freshly authorized activity. */
export function useStudioRecentChatKeys(): readonly string[] {
  return useContext(StudioListContext)?.recentChatKeys ?? EMPTY_RECENT_CHATS;
}
