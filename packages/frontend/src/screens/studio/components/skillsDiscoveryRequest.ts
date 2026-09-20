import { useEffect } from "react";

// A one-slot hand-off from the Connect sheet's "Search all skills" to the
// Skills panel's Discover tab. The panel is usually not mounted when the
// request is made (openPanelTab mounts it), so the query waits here until the
// panel consumes it on mount; a panel that is already mounted hears the
// request at once. One pending query, cleared on read; never persisted.

let pending: string | null = null;
const listeners = new Set<() => void>();

export function requestSkillsDiscovery(query: string): void {
  pending = query;
  for (const listener of listeners) {
    listener();
  }
}

export function consumeSkillsDiscoveryRequest(): string | null {
  const query = pending;
  pending = null;
  return query;
}

export function subscribeSkillsDiscoveryRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runs `onRequest` with a query pending at mount and with every later request. */
export function useSkillsDiscoveryRequest(onRequest: (query: string) => void): void {
  useEffect(() => {
    const apply = () => {
      const query = consumeSkillsDiscoveryRequest();
      if (query !== null) {
        onRequest(query);
      }
    };
    apply();
    return subscribeSkillsDiscoveryRequest(apply);
  }, [onRequest]);
}
