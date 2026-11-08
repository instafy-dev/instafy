// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatBrowserView } from "../useChatBrowserView";

describe("opening the chat's browser tab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: ReturnType<typeof useChatBrowserView>;
  let props: Parameters<typeof useChatBrowserView>[0];

  function Harness() {
    current = useChatBrowserView(props);
    return null;
  }
  async function render(overrides: Partial<typeof props> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      scopeKey: "user/project/chat/runtime", onScreen: true, free: true, chatId: "chat",
      tabId: null, tabActive: false, canOpenTab: true, chatTurnUnderWay: false,
      anyTurnUnderWay: false, resolveTab: vi.fn().mockRejectedValue(new Error("Browser is starting")),
      focusTab: vi.fn().mockResolvedValue(true),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps a failed initial attempt recoverable without retrying on every update", async () => {
    await render();
    expect(current?.error).toBe("Browser is starting");
    expect(props.resolveTab).toHaveBeenCalledTimes(1);
    await render({ anyTurnUnderWay: true });
    await render({ anyTurnUnderWay: false });
    expect(props.resolveTab).toHaveBeenCalledTimes(1);
    vi.mocked(props.resolveTab).mockResolvedValue({ id: "own-tab" });
    await act(async () => current?.onRetry());
    expect(props.resolveTab).toHaveBeenCalledTimes(2);
    expect(current).toBeNull();
    await render({ tabId: "own-tab" });
    expect(props.focusTab).toHaveBeenCalledExactlyOnceWith("own-tab");
  });

  it("shows pending feedback and does not issue duplicate retries", async () => {
    let finish!: () => void;
    props.resolveTab = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    expect(current?.pending).toBe(true);
    await act(async () => current?.onRetry());
    expect(props.resolveTab).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(current).toBeNull();
  });

  it("cannot retry while another participant owns the browser", async () => {
    await render();
    const retry = current!.onRetry;
    await render({ free: false });
    expect(current).toBeNull();
    await act(async () => retry());
    expect(props.resolveTab).toHaveBeenCalledTimes(1);
    await render({ free: true });
    expect(current?.error).toBe("Browser is starting");
    await act(async () => current?.onRetry());
    expect(props.resolveTab).toHaveBeenCalledTimes(2);
  });

  it.each(["hide", "scope"])("ignores a late failure after %s and clears prior feedback", async (change) => {
    let fail!: (reason: Error) => void;
    props.resolveTab = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    await render();
    expect(current?.pending).toBe(true);
    const rejectOld = fail;
    await render(change === "hide" ? { onScreen: false } : {
      scopeKey: "user/project/chat/runtime-2", resolveTab: vi.fn().mockResolvedValue({ id: "new-tab" }),
    });
    await act(async () => rejectOld(new Error("Old browser failed")));
    expect(current).toBeNull();
  });

  it("retries once when hidden and reopened, without carrying the old error", async () => {
    await render();
    expect(current?.error).toBeTruthy();
    await render({ onScreen: false });
    expect(current).toBeNull();
    vi.mocked(props.resolveTab).mockResolvedValue({ id: "own-tab" });
    await render({ onScreen: true });
    expect(props.resolveTab).toHaveBeenCalledTimes(2);
    expect(current).toBeNull();
  });
});
