import { useEffect } from "react";

export type ConnectToolsScope = {
  projectId: string | null;
  conversationId: string | null;
};

// Skills can open the same tool chooser as the composer before ChatPanel has
// mounted. Keep one request for that exact space and chat, never persisted.
// A different context discards it rather than opening a chooser on a later visit.
let pending: ConnectToolsScope | null = null;
const listeners = new Set<() => void>();

export function requestConnectTools(scope: ConnectToolsScope): void {
  pending = scope.projectId ? { ...scope } : null;
  for (const listener of listeners) {
    listener();
  }
}

/** Consume once, discarding a request if navigation has changed its context. */
export function consumeConnectToolsRequest(scope: ConnectToolsScope): boolean {
  const request = pending;
  pending = null;
  return request !== null
    && request.projectId === scope.projectId
    && request.conversationId === scope.conversationId;
}

export function useConnectToolsRequest(scope: ConnectToolsScope, onRequest: () => void): void {
  const { projectId, conversationId } = scope;
  useEffect(() => {
    const apply = () => {
      if (consumeConnectToolsRequest({ projectId, conversationId })) {
        onRequest();
      }
    };
    listeners.add(apply);
    apply();
    return () => {
      listeners.delete(apply);
    };
  }, [projectId, conversationId, onRequest]);
}
