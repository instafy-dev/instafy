import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  getProjectRecencyStorageKey,
  PROJECT_RECENCY_CHANGE_EVENT,
  readProjectRecency,
  type ProjectRecencyMap,
} from "./projectRecency";

const emptySnapshot = () => "{}";

export function useProjectRecency(userEmail?: string | null): ProjectRecencyMap {
  const account = userEmail?.trim().toLowerCase() || null;
  const key = getProjectRecencyStorageKey(account);
  const subscribe = useCallback((onChange: () => void) => {
    if (!key || typeof window === "undefined") return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) onChange();
    };
    const onLocalChange = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === key) onChange();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_RECENCY_CHANGE_EVENT, onLocalChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_RECENCY_CHANGE_EVENT, onLocalChange);
    };
  }, [key]);
  // A primitive snapshot is stable between writes and changes synchronously
  // with the account, so no render can expose the previous account's history.
  const getSnapshot = useCallback(() => JSON.stringify(readProjectRecency(account)), [account]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, emptySnapshot);
  return useMemo(() => JSON.parse(snapshot) as ProjectRecencyMap, [snapshot]);
}
