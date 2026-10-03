import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { MOBILE_SIDEBAR_STATE_KEY } from "../screens/useMobileSidebarHistory";
import { getStudioVisitKey } from "./studioVisit";

interface Visit { key: string; index: number; home: boolean }
interface HomeVisit { index: number; origin: Visit | null }

function routerIndex(key: string): number | null {
  const state = window.history.state;
  return (state?.key ?? "default") === key && Number.isSafeInteger(state?.idx) && state.idx >= 0 ? state.idx : null;
}

/** Home is an overview detour. Return to its original Router visit so that
 * settings, artifacts and scroll state restore together, without a second stack.
 * Targets live only in this signed-in session; direct Home launches have none. */
export function useHomeReturn(userId: string | null, home: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const index = routerIndex(location.key);
  const visitKey = getStudioVisitKey(location);
  const overlay = Boolean(location.state && typeof location.state === "object" && MOBILE_SIDEBAR_STATE_KEY in location.state);
  const owner = useRef({ userId, previous: null as Visit | null, homes: new Map<string, HomeVisit>() });
  if (owner.current.userId !== userId) owner.current = { userId, previous: null, homes: new Map() };
  const session = owner.current;
  const [target, setTarget] = useState<{ session: typeof session; origin: Visit | null } | null>(null);
  const pending = useRef<string | null>(null);
  const live = useRef({ key: location.key, index, home, overlay });
  live.current = { key: location.key, index, home, overlay };

  useLayoutEffect(() => {
    if (!userId || index === null || overlay) return;
    if (pending.current !== location.key) pending.current = null;
    const previous = session.previous;
    if (previous?.key === visitKey && previous.home === home) return;
    if (navigationType === "PUSH") {
      for (const [key, saved] of session.homes) {
        if (saved.index >= index) session.homes.delete(key);
      }
    }
    // A replacement cannot leave a return target pointing at a different page.
    for (const saved of session.homes.values()) {
      if (saved.origin?.index === index && saved.origin.key !== visitKey) saved.origin = null;
    }
    let origin = session.homes.get(visitKey)?.origin ?? null;
    if (home && !session.homes.has(visitKey) && navigationType !== "POP" && previous) {
      origin = previous.home ? session.homes.get(previous.key)?.origin ?? null
        : previous.index < index ? previous : null;
    }
    if (home) session.homes.set(visitKey, { index, origin });
    session.previous = { key: visitKey, index, home };
    setTarget({ session, origin: home ? origin : null });
  }, [home, index, location.key, navigationType, overlay, session, userId, visitKey]);

  const origin = target?.session === session ? target.origin : null;
  const canReturn = Boolean(userId && home && origin && index !== null && origin.index < index);
  const returnToPrevious = useCallback(() => {
    const current = live.current;
    if (!origin || owner.current !== session || !current.home || current.overlay || current.index === null
      || routerIndex(current.key) !== current.index || origin.index >= current.index || pending.current === current.key) return;
    pending.current = current.key;
    void navigate(origin.index - current.index);
  }, [navigate, origin, session]);
  return { canReturn, returnToPrevious };
}
