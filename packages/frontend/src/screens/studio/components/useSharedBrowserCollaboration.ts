import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  INITIAL_SHARED_BROWSER_COLLABORATION_CLIENT_STATE,
  createSharedBrowserCollaborationCursorMessage,
  createSharedBrowserCollaborationHeartbeatMessage,
  createSharedBrowserCollaborationJoinMessage,
  normalizeSharedBrowserCollaborationCursor,
  parseSharedBrowserCollaborationServerMessage,
  reduceSharedBrowserCollaborationClientState,
  type SharedBrowserCollaborationClientMessage,
  type SharedBrowserCollaborationCursor,
} from "./sharedBrowserCollaboration";

const COLLABORATION_HEARTBEAT_INTERVAL_MS = 4_000;
const COLLABORATION_CURSOR_INTERVAL_MS = 50;
const COLLABORATION_RECONNECT_MAX_DELAY_MS = 5_000;

function openWebSocket(socket: WebSocket | null): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

export function useSharedBrowserCollaboration({
  active,
  connectionKey,
  pageId,
  sessionId,
  wsUrl,
}: {
  active: boolean;
  connectionKey: string | null;
  pageId: string | null;
  sessionId: string;
  wsUrl: string | null;
}) {
  const [client, dispatch] = useReducer(
    reduceSharedBrowserCollaborationClientState,
    INITIAL_SHARED_BROWSER_COLLABORATION_CLIENT_STATE,
  );
  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);
  const connectionKeyRef = useRef(connectionKey);
  const sessionIdRef = useRef(sessionId);
  const wsUrlRef = useRef(wsUrl);
  const pageIdRef = useRef(pageId);
  const pendingCursorRef = useRef<SharedBrowserCollaborationCursor | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const lastCursorSentAtRef = useRef(0);
  pageIdRef.current = pageId;
  activeRef.current = active;
  connectionKeyRef.current = connectionKey;
  sessionIdRef.current = sessionId;
  wsUrlRef.current = wsUrl;

  const send = useCallback((message: SharedBrowserCollaborationClientMessage): boolean => {
    const socket = socketRef.current;
    if (!openWebSocket(socket)) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    if (!active || !connectionKey || !wsUrl || !sessionId.trim()) {
      socketRef.current = null;
      dispatch({ type: "reset", status: "idle" });
      return;
    }

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let latestCandidate: WebSocket | null = null;
    let replacementEstablished = false;
    const requestedWsUrl = wsUrl;
    const predecessor =
      openWebSocket(socketRef.current) && socketRef.current.url !== requestedWsUrl
        ? socketRef.current
        : null;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }
      reconnectAttempt += 1;
      const delayMs = Math.min(500 * 2 ** Math.min(reconnectAttempt, 4), COLLABORATION_RECONNECT_MAX_DELAY_MS);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      if (!predecessor) {
        dispatch({ type: "reset", status: "connecting" });
      }
      let socket: WebSocket;
      try {
        socket = new WebSocket(requestedWsUrl);
      } catch {
        if (!predecessor) {
          dispatch({ type: "socket-error", message: "Shared Browser collaboration is reconnecting." });
        }
        scheduleReconnect();
        return;
      }
      latestCandidate = socket;
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        reconnectAttempt = 0;
        if (!predecessor) {
          dispatch({ type: "socket-open" });
        }
        socket.send(
          JSON.stringify(
            createSharedBrowserCollaborationJoinMessage(sessionId, pageIdRef.current),
          ),
        );
      });
      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        const message = parseSharedBrowserCollaborationServerMessage(event.data);
        if (!message) {
          // Authoritative state that does not match the bounded wire contract
          // cannot safely preserve a stale "you control" decision. Clear all
          // local authority before reconnecting with a fresh signed socket.
          dispatch({
            type: "socket-error",
            message: "Shared Browser collaboration received invalid state and is reconnecting.",
          });
          socket.close(1002, "invalid collaboration state");
          return;
        }
        if (message.type === "welcome" && predecessor && !replacementEstablished) {
          replacementEstablished = true;
          // The origin has now replaced the old connection for this exact
          // signed participant. Closing it without `leave` preserves the
          // participant and any control/request state.
          predecessor.close(1000, "collaboration token rotated");
        }
        dispatch({ type: "server-message", message });
      });
      socket.addEventListener("error", () => {
        if (!disposed && socketRef.current === socket && (!predecessor || replacementEstablished)) {
          dispatch({ type: "socket-error", message: "Shared Browser collaboration is reconnecting." });
        }
      });
      socket.addEventListener("close", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        if (predecessor && !replacementEstablished && openWebSocket(predecessor)) {
          socketRef.current = predecessor;
        } else {
          socketRef.current = null;
          dispatch({ type: "reset", status: "connecting" });
        }
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const rotatingToken =
        activeRef.current &&
        connectionKeyRef.current === connectionKey &&
        sessionIdRef.current === sessionId &&
        Boolean(wsUrlRef.current) &&
        wsUrlRef.current !== requestedWsUrl;
      if (rotatingToken) {
        if (predecessor && !replacementEstablished && latestCandidate) {
          latestCandidate.close(1000, "collaboration token rotation superseded");
          socketRef.current = predecessor;
        }
        return;
      }
      const currentSocket = socketRef.current;
      const socket =
        predecessor && !replacementEstablished ? predecessor : currentSocket;
      if (openWebSocket(socket)) {
        socket.send(JSON.stringify({ type: "leave" } satisfies SharedBrowserCollaborationClientMessage));
      }
      if (socket) {
        socket.close(1000, "collaboration inactive");
      }
      if (currentSocket && currentSocket !== socket) {
        currentSocket.close(1000, "collaboration inactive");
      }
      socketRef.current = null;
      if (predecessor && predecessor !== socket) {
        predecessor.close(1000, "collaboration inactive");
      }
    };
  }, [active, connectionKey, sessionId, wsUrl]);

  useEffect(() => {
    pendingCursorRef.current = null;
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
    if (!active) {
      return;
    }
    send(createSharedBrowserCollaborationHeartbeatMessage(pageId));
  }, [active, pageId, send]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const intervalId = window.setInterval(() => {
      send(createSharedBrowserCollaborationHeartbeatMessage(pageIdRef.current));
    }, COLLABORATION_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [active, send]);

  useEffect(
    () => () => {
      if (cursorTimerRef.current !== null) {
        window.clearTimeout(cursorTimerRef.current);
      }
    },
    [],
  );

  const publishCursor = useCallback(
    (cursor: SharedBrowserCollaborationCursor) => {
      const normalized = normalizeSharedBrowserCollaborationCursor(cursor);
      if (!normalized || !active || !pageIdRef.current) {
        return;
      }
      pendingCursorRef.current = normalized;

      const flush = () => {
        cursorTimerRef.current = null;
        const pending = pendingCursorRef.current;
        const currentPageId = pageIdRef.current;
        pendingCursorRef.current = null;
        if (!pending || !currentPageId) {
          return;
        }
        if (send(createSharedBrowserCollaborationCursorMessage(currentPageId, pending))) {
          lastCursorSentAtRef.current = Date.now();
        }
      };

      const elapsed = Date.now() - lastCursorSentAtRef.current;
      if (elapsed >= COLLABORATION_CURSOR_INTERVAL_MS && cursorTimerRef.current === null) {
        flush();
        return;
      }
      if (cursorTimerRef.current === null) {
        cursorTimerRef.current = window.setTimeout(
          flush,
          Math.max(0, COLLABORATION_CURSOR_INTERVAL_MS - elapsed),
        );
      }
    },
    [active, send],
  );

  return {
    client,
    publishCursor,
    requestControl: () => send({ type: "requestControl" }),
    takeControl: () => send({ type: "takeControl" }),
    releaseControl: () => send({ type: "releaseControl" }),
    grantControl: (participantId: string) => {
      const normalized = participantId.trim();
      return normalized ? send({ type: "grantControl", participantId: normalized }) : false;
    },
  };
}
