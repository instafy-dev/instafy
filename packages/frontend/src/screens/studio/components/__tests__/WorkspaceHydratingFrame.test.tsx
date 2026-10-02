// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_HYDRATING_STATUS_DELAY_MS, WorkspaceHydratingFrame } from "../WorkspaceHydratingFrame";

describe("WorkspaceHydratingFrame", () => {
  let container: HTMLDivElement;
  let root: Root;
  const frame = () => container.querySelector('[data-testid="workspace-tabs-hydrating"]');
  const render = (loadingChats: boolean) => act(async () => root.render(<WorkspaceHydratingFrame loadingChats={loadingChats} />));
  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stays quiet through a fast switch, then says it is loading the space's chats", async () => {
    await render(true);
    expect(frame()?.getAttribute("aria-busy")).toBe("true");
    expect(frame()?.textContent).toBe("");

    await advance(WORKSPACE_HYDRATING_STATUS_DELAY_MS - 1);
    expect(frame()?.textContent).toBe("");

    await advance(1);
    expect(frame()?.querySelector('[role="status"]')?.textContent).toBe("Loading chats…");
    // The status is announced, not held back inside a busy region.
    expect(frame()?.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the frame quiet for a route that is not waiting on chats", async () => {
    await render(false);
    await advance(5_000);
    expect(frame()?.getAttribute("aria-busy")).toBe("true");
    expect(frame()?.textContent).toBe("");
    expect(frame()?.querySelector('[role="status"]')).toBeNull();
  });

  it("waits out the delay again when the frame goes back to loading chats", async () => {
    await render(true);
    await advance(WORKSPACE_HYDRATING_STATUS_DELAY_MS);
    expect(frame()?.textContent).toBe("Loading chats…");

    await render(false);
    expect(frame()?.textContent).toBe("");
    await render(true);
    expect(frame()?.textContent).toBe("");
    expect(frame()?.getAttribute("aria-busy")).toBe("true");
    await advance(WORKSPACE_HYDRATING_STATUS_DELAY_MS);
    expect(frame()?.textContent).toBe("Loading chats…");
    expect(frame()?.getAttribute("aria-busy")).toBe("false");
  });
});
