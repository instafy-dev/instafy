import { useCallback, useMemo, useRef } from "react";
import type { StudioSearchSnapshot } from "./components/useStudioSearch";

/** Keep search UI checkpoints with browser visits, never message contents or credentials. */
export function useStudioSearchHistory(viewerUserId: string | null, visitKey: string, scopeKey: string) {
  const owner = useRef({ viewerUserId, snapshots: new Map<string, { scopeKey: string; snapshot: StudioSearchSnapshot }>() });
  const sequence = useRef(0);
  if (owner.current.viewerUserId !== viewerUserId) {
    owner.current = { viewerUserId, snapshots: new Map() };
  }
  const restoredSession = useMemo(() => {
    if (!viewerUserId) return null;
    const saved = owner.current.snapshots.get(visitKey);
    return saved?.scopeKey === scopeKey ? { ...saved.snapshot, restoreKey: `${visitKey}:${++sequence.current}` } : null;
  }, [scopeKey, viewerUserId, visitKey]);
  const remember = useCallback((snapshot: StudioSearchSnapshot) => {
    if (!viewerUserId || owner.current.viewerUserId !== viewerUserId) return;
    const snapshots = owner.current.snapshots;
    snapshots.delete(visitKey);
    snapshots.set(visitKey, { scopeKey, snapshot });
    if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value!);
  }, [scopeKey, viewerUserId, visitKey]);
  const dismiss = useCallback(() => { owner.current.snapshots.delete(visitKey); }, [visitKey]);
  return { restoredSession, remember, dismiss };
}
