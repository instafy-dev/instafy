import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const STORAGE_PREFIX = "instafy:organization-rail-order:v1:";

function readOrder(key: string | null): string[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  } catch {
    return [];
  }
}

function appendOrganizationKeys<T extends { key: string }>(order: readonly string[], organizations: readonly T[]): string[] {
  return [...new Set([...order, ...organizations.map((organization) => organization.key)])];
}

/** Local account preference only: organization identity and access remain server-owned. */
export function useOrganizationRailOrder<T extends { key: string }>(
  userId: string | null | undefined,
  organizations: readonly T[],
): { orderedOrganizations: T[]; moveOrganization: (activeKey: string, overKey: string) => void } {
  const key = userId?.trim() ? `${STORAGE_PREFIX}${encodeURIComponent(userId.trim())}` : null;
  const [snapshot, setSnapshot] = useState(() => ({ key, order: readOrder(key) }));
  // Read the incoming account immediately, before subscription effects run.
  const order = useMemo(() => snapshot.key === key ? snapshot.order : readOrder(key), [key, snapshot]);
  const current = useRef({ key, order, organizations });

  useLayoutEffect(() => {
    current.current = { key, order, organizations };
  }, [key, order, organizations]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => {
      if (current.current.key !== key) return;
      const nextOrder = readOrder(key);
      current.current = { ...current.current, order: nextOrder };
      setSnapshot({ key, order: nextOrder });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      refresh();
    };
    window.addEventListener("storage", onStorage);
    refresh();
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const orderedOrganizations = useMemo(() => {
    const available = new Map<string, T>();
    for (const organization of organizations) {
      if (!available.has(organization.key)) available.set(organization.key, organization);
    }
    return appendOrganizationKeys(order, organizations).flatMap((id) => {
      const organization = available.get(id);
      return organization ? [organization] : [];
    });
  }, [order, organizations]);

  const moveOrganization = useCallback((activeKey: string, overKey: string) => {
    const live = current.current;
    if (!key || live.key !== key || activeKey === overKey) return;
    const available = new Set(live.organizations.map((organization) => organization.key));
    if (!available.has(activeKey) || !available.has(overKey)) return;
    const fullOrder = appendOrganizationKeys(live.order, live.organizations);
    const visibleOrder = fullOrder.filter((id) => available.has(id));
    const from = visibleOrder.indexOf(activeKey);
    const to = visibleOrder.indexOf(overKey);
    visibleOrder.splice(from, 1);
    visibleOrder.splice(to, 0, activeKey);
    // Partial/refreshing lists must not forget absent organizations. Reorder only
    // the visible slots, retaining every absent ID at its saved position.
    let visibleIndex = 0;
    const nextOrder = fullOrder.map((id) => available.has(id) ? visibleOrder[visibleIndex++] : id);
    current.current = { ...live, order: nextOrder };
    setSnapshot({ key, order: nextOrder });
    // Save only explicit moves: loading or switching accounts never writes a list.
    try {
      window.localStorage.setItem(key, JSON.stringify(nextOrder));
    } catch {
      // Storage is optional; the current rail still reflects the requested move.
    }
  }, [key]);

  return { orderedOrganizations, moveOrganization };
}
