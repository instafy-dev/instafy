// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collaborationSelfOwnsControl } from "../sharedBrowserCollaboration";
import { useSharedBrowserCollaboration } from "../useSharedBrowserCollaboration";

type Listener = (event: Event) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type: string, data?: unknown) {
    if (type === "open") {
      this.readyState = FakeWebSocket.OPEN;
    }
    const event = Object.assign(new Event(type), data === undefined ? {} : { data });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

type CollaborationModel = ReturnType<typeof useSharedBrowserCollaboration>;

describe("useSharedBrowserCollaboration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: CollaborationModel | null;

  function Harness({
    pageId,
    token = "secret",
  }: {
    pageId: string;
    token?: string;
  }) {
    latest = useSharedBrowserCollaboration({
      active: true,
      connectionKey: "project-1:runtime-1:origin-1",
      pageId,
      sessionId: "session-1",
      wsUrl: `wss://runtime.test/browser/collaboration?token=${token}`,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeWebSocket.instances = [];
    latest = null;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("joins with only session/page identity and follows authoritative ownership", async () => {
    await act(async () => root.render(<Harness pageId="page-1" />));
    const socket = FakeWebSocket.instances[0];
    await act(async () => socket.emit("open"));
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "join",
      sessionId: "session-1",
      pageId: "page-1",
    });

    await act(async () => {
      socket.emit("message", JSON.stringify({ type: "welcome", participantId: "self" }));
      socket.emit(
        "message",
        JSON.stringify({
          type: "state",
          revision: 1,
          participants: [
            {
              id: "self",
              displayName: "Taylor",
              color: "#0ea5e9",
              pageId: "page-1",
              cursor: null,
              canControl: true,
            },
          ],
          controlOwner: { kind: "human", participantId: "self" },
          requests: [],
        }),
      );
    });
    expect(collaborationSelfOwnsControl(latest!.client)).toBe(true);

    await act(async () => latest!.publishCursor({ x: 0.25, y: 0.75 }));
    const cursorMessage = socket.sent.map((value) => JSON.parse(value)).find(
      (message) => message.type === "cursor",
    );
    expect(cursorMessage).toEqual({ type: "cursor", pageId: "page-1", x: 0.25, y: 0.75 });
    expect(Object.keys(cursorMessage).sort()).toEqual(["pageId", "type", "x", "y"]);

    await act(async () => root.render(<Harness pageId="page-2" />));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "heartbeat",
      pageId: "page-2",
    });

    await act(async () => {
      socket.emit(
        "message",
        JSON.stringify({
          type: "state",
          revision: 2,
          participants: [],
          controlOwner: null,
          requests: [],
          unexpected: "must fail closed",
        }),
      );
    });
    expect(socket.readyState).toBe(3);
    expect(latest!.client.state).toBeNull();
    expect(collaborationSelfOwnsControl(latest!.client)).toBe(false);
  });

  it("replaces the live participant socket across token rotation without relinquishing control", async () => {
    await act(async () => root.render(<Harness pageId="page-1" token="old" />));
    const firstSocket = FakeWebSocket.instances[0];
    await act(async () => firstSocket.emit("open"));

    await act(async () => root.render(<Harness pageId="page-1" token="fresh" />));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(firstSocket.readyState).toBe(FakeWebSocket.OPEN);
    const replacement = FakeWebSocket.instances[1];
    expect(replacement?.url).toContain("token=fresh");
    await act(async () => replacement.emit("open"));
    expect(replacement.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "join",
      sessionId: "session-1",
      pageId: "page-1",
    });
    await act(async () => {
      replacement.emit(
        "message",
        JSON.stringify({ type: "welcome", participantId: "self" }),
      );
    });
    expect(firstSocket.readyState).toBe(3);
    expect(firstSocket.sent.map((value) => JSON.parse(value))).not.toContainEqual({
      type: "leave",
    });
  });
});
