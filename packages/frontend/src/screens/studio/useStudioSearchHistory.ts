import { useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readStudioSearchOriginToken } from "../../navigation/studioNavigation";
import { MOBILE_SIDEBAR_STATE_KEY, readMobileSidebarEntry } from "../useMobileSidebarHistory";
import type { StudioSearchSnapshot } from "./components/useStudioSearch";

interface SearchCheckpoint {
  scopeKey: string;
  snapshot: StudioSearchSnapshot;
  token: string;
  index: number | null;
}

function currentIndex(locationKey: string): number | null {
  const state = window.history.state;
  return (state?.key ?? "default") === locationKey && Number.isSafeInteger(state?.idx) && state.idx >= 0 ? state.idx : null;
}

function hasSidebarState(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && MOBILE_SIDEBAR_STATE_KEY in state);
}

/** Keep search UI checkpoints with browser visits, never message contents or credentials. */
export function useStudioSearchHistory(viewerUserId: string | null, visitKey: string, scopeKey: string, sidebarScopeKey: string | null = null) {
  const location = useLocation();
  const navigate = useNavigate();
  const owner = useRef({ viewerUserId, snapshots: new Map<string, SearchCheckpoint>() });
  const sequence = useRef(0);
  if (owner.current.viewerUserId !== viewerUserId) {
    owner.current = { viewerUserId, snapshots: new Map() };
  }
  const currentOwner = owner.current;
  const index = currentIndex(location.key);
  const overlay = readMobileSidebarEntry(location.state, sidebarScopeKey, index);
  const live = useRef({ location, owner: currentOwner, index });
  live.current = { location, owner: currentOwner, index };
  const pendingReturn = useRef<string | null>(null);
  if (pendingReturn.current !== location.key) pendingReturn.current = null;
  // A replaced entry at an already-known index no longer owns its old checkpoint.
  // Canonical URL replacements retain the stable visit key; drawer visits share
  // their base visit but must never replace its index with an overlay index.
  if (index !== null && !hasSidebarState(location.state)) {
    for (const [key, saved] of currentOwner.snapshots) {
      if (saved.index === index && key !== visitKey) currentOwner.snapshots.delete(key);
    }
  }
  const restoredSession = useMemo(() => {
    if (!viewerUserId) return null;
    const saved = owner.current.snapshots.get(visitKey);
    return saved?.scopeKey === scopeKey ? { ...saved.snapshot, restoreKey: `${visitKey}:${++sequence.current}` } : null;
  }, [scopeKey, viewerUserId, visitKey]);
  const remember = useCallback((snapshot: StudioSearchSnapshot) => {
    if (!viewerUserId || owner.current !== currentOwner) return;
    const snapshots = owner.current.snapshots;
    const liveIndex = currentIndex(location.key);
    const originIndex = liveIndex === null ? null : overlay?.baseIndex ?? (hasSidebarState(location.state) ? null : liveIndex);
    snapshots.delete(visitKey);
    snapshots.set(visitKey, { scopeKey, snapshot, token: crypto.randomUUID(), index: originIndex });
    if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value!);
  }, [currentOwner, location.key, location.state, overlay?.baseIndex, scopeKey, viewerUserId, visitKey]);
  const getOriginToken = useCallback(() => {
    if (!viewerUserId || owner.current !== currentOwner || currentIndex(location.key) === null) return null;
    const saved = currentOwner.snapshots.get(visitKey);
    return saved?.index !== null && saved?.scopeKey === scopeKey ? saved.token : null;
  }, [currentOwner, location.key, scopeKey, viewerUserId, visitKey]);
  const marker = readStudioSearchOriginToken(location.state);
  const source = marker ? [...currentOwner.snapshots.values()].find(saved => saved.token === marker) : null;
  const originToken = viewerUserId && source?.index !== null && source?.index !== undefined && index !== null
    && (!hasSidebarState(location.state) || overlay !== null)
    && (overlay?.baseIndex ?? index) > source.index ? marker : null;
  const returnToResults = useCallback(() => {
    if (!originToken || owner.current !== currentOwner || live.current.owner !== currentOwner) return;
    const current = live.current;
    const liveIndex = currentIndex(current.location.key);
    if (liveIndex === null || liveIndex !== current.index || pendingReturn.current === current.location.key
      || readStudioSearchOriginToken(current.location.state) !== originToken
      || readStudioSearchOriginToken(window.history.state?.usr) !== originToken || hasSidebarState(current.location.state)) return;
    const saved = [...currentOwner.snapshots.values()].find(checkpoint => checkpoint.token === originToken);
    if (saved?.index === null || saved?.index === undefined || saved.index >= liveIndex) return;
    pendingReturn.current = current.location.key;
    void navigate(saved.index - liveIndex);
  }, [currentOwner, navigate, originToken]);
  const dismiss = useCallback(() => {
    if (owner.current === currentOwner) currentOwner.snapshots.delete(visitKey);
  }, [currentOwner, visitKey]);
  return { restoredSession, remember, dismiss, getOriginToken, originToken, returnToResults };
}
