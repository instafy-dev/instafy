// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeConnectToolsRequest,
  requestConnectTools,
  useConnectToolsRequest,
  type ConnectToolsScope,
} from "../connectToolRequest";

const scope: ConnectToolsScope = { projectId: "space-one", conversationId: "chat-one" };

function Consumer({ scope: current, onRequest }: { scope: ConnectToolsScope; onRequest: () => void }) {
  useConnectToolsRequest(current, onRequest);
  return null;
}

describe("connectToolRequest", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    consumeConnectToolsRequest(scope);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    consumeConnectToolsRequest(scope);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens once after the target chat mounts, including StrictMode remounts", async () => {
    const onRequest = vi.fn();
    requestConnectTools(scope);
    await act(async () => {
      root.render(<StrictMode><Consumer scope={scope} onRequest={onRequest} /></StrictMode>);
    });
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(consumeConnectToolsRequest(scope)).toBe(false);
  });

  it("delivers live requests without replaying them when a callback changes", async () => {
    const onRequest = vi.fn();
    await act(async () => root.render(<Consumer scope={scope} onRequest={onRequest} />));
    expect(onRequest).not.toHaveBeenCalled();
    await act(async () => requestConnectTools(scope));
    expect(onRequest).toHaveBeenCalledTimes(1);
    const replacement = vi.fn();
    await act(async () => root.render(<Consumer scope={scope} onRequest={replacement} />));
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: "space-two", conversationId: "chat-one" },
    { projectId: "space-one", conversationId: "chat-two" },
    { projectId: null, conversationId: null },
  ])("drops a pending request when another context mounts: %j", async (otherScope) => {
    const onRequest = vi.fn();
    requestConnectTools(scope);
    await act(async () => root.render(<Consumer scope={otherScope} onRequest={onRequest} />));
    await act(async () => root.render(<Consumer scope={scope} onRequest={onRequest} />));
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("does not retain a mismatched live request for a later navigation", async () => {
    const onRequest = vi.fn();
    await act(async () => root.render(<Consumer scope={scope} onRequest={onRequest} />));
    const other = { ...scope, conversationId: "chat-two" };
    await act(async () => requestConnectTools(other));
    await act(async () => root.render(<Consumer scope={other} onRequest={onRequest} />));
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("replaces queued requests and supports an empty chat within a space", () => {
    const emptyChat = { ...scope, conversationId: null };
    requestConnectTools(scope);
    requestConnectTools(emptyChat);
    expect(consumeConnectToolsRequest(emptyChat)).toBe(true);
    expect(consumeConnectToolsRequest(scope)).toBe(false);
    requestConnectTools({ projectId: null, conversationId: null });
    expect(consumeConnectToolsRequest({ projectId: null, conversationId: null })).toBe(false);
  });

  it("removes the old subscriber on unmount so a new request waits for the next chat mount", async () => {
    const oldRequest = vi.fn();
    await act(async () => root.render(<Consumer scope={scope} onRequest={oldRequest} />));
    await act(async () => root.unmount());
    root = createRoot(container);
    requestConnectTools(scope);
    expect(oldRequest).not.toHaveBeenCalled();
    const nextRequest = vi.fn();
    await act(async () => root.render(<Consumer scope={scope} onRequest={nextRequest} />));
    expect(nextRequest).toHaveBeenCalledTimes(1);
  });
});
