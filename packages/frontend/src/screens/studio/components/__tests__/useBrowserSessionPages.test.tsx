// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  commandPageMock,
  fetchCapabilitiesMock,
  fetchPagesMock,
  focusPageMock,
} = vi.hoisted(() => ({
  commandPageMock: vi.fn(),
  fetchCapabilitiesMock: vi.fn(),
  fetchPagesMock: vi.fn(),
  focusPageMock: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserSessions: {
      commandPage: commandPageMock,
      fetchCapabilities: fetchCapabilitiesMock,
      fetchPages: fetchPagesMock,
      focusPage: focusPageMock,
      isCapabilitiesIncompatibleError: () => false,
      isUnavailableError: (error: unknown) =>
        Boolean(error && typeof error === "object" && "status" in error),
    },
  },
}));

import { useBrowserSessionPages } from "../useBrowserSessionPages";

type HookResult = ReturnType<typeof useBrowserSessionPages>;

describe("useBrowserSessionPages", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestResult: HookResult | null;
  let hookProjectId: string;
  let hookRuntimeId: string;
  let hookSuspendOnUnavailable: boolean;
  const onUnavailable = vi.fn();

  function Harness() {
    latestResult = useBrowserSessionPages({
      enabled: true,
      browserSessionId: "browser-surface-1",
      projectId: hookProjectId,
      preferRuntimeId: hookRuntimeId,
      includePlaceholder: true,
      suspendOnUnavailable: hookSuspendOnUnavailable,
      onUnavailable,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestResult = null;
    hookProjectId = "project-1";
    hookRuntimeId = "runtime-1";
    hookSuspendOnUnavailable = false;
    onUnavailable.mockReset();
    commandPageMock.mockReset().mockResolvedValue(true);
    focusPageMock.mockReset().mockResolvedValue(true);
    fetchPagesMock.mockReset().mockResolvedValue([
      {
        id: "page-1",
        url: "https://example.com/",
        host: "example.com",
        label: "Example",
        title: "Example",
        isActive: true,
        canGoBack: true,
        canGoForward: false,
      },
    ]);
    fetchCapabilitiesMock.mockReset().mockResolvedValue({
      version: 2,
      viewerKinds: ["rfb"],
      preferredViewer: "rfb",
      viewportOnly: true,
      controls: { navigate: true, history: true, reload: true, focusPage: true },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHook() {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("resolves capabilities and placeholder-aware navigation state", async () => {
    await renderHook();

    expect(fetchPagesMock).toHaveBeenCalledWith({
      projectId: "project-1",
      browserSessionId: "browser-surface-1",
      preferRuntimeId: "runtime-1",
      includePlaceholder: true,
      signal: expect.any(AbortSignal),
    });
    expect(latestResult?.pages).toEqual([
      expect.objectContaining({ id: "page-1", canGoBack: true, canGoForward: false }),
    ]);
    expect(latestResult?.capabilitiesResolved).toBe(true);
    expect(latestResult?.capabilities).toMatchObject({
      preferredViewer: "rfb",
      viewportOnly: true,
    });
  });

  it("tracks a command, reports errors, and refreshes pages immediately", async () => {
    await renderHook();
    fetchPagesMock.mockClear();

    let rejectCommand: ((reason: Error) => void) | null = null;
    commandPageMock.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );

    let commandPromise: Promise<boolean> | undefined;
    await act(async () => {
      commandPromise = latestResult?.navigatePage("page-1", "https://instafy.dev/");
      await Promise.resolve();
    });
    expect(latestResult?.commandPending).toBe("navigate");

    await act(async () => {
      rejectCommand?.(new Error("navigation was rejected"));
      await commandPromise;
    });

    expect(commandPageMock).toHaveBeenCalledWith({
      projectId: "project-1",
      browserSessionId: "browser-surface-1",
      pageId: "page-1",
      action: "navigate",
      url: "https://instafy.dev/",
      preferRuntimeId: "runtime-1",
    });
    expect(latestResult?.commandPending).toBeNull();
    expect(latestResult?.commandError).toBe("navigation was rejected");
    expect(fetchPagesMock).toHaveBeenCalledTimes(1);

    act(() => latestResult?.clearCommandError());
    expect(latestResult?.commandError).toBeNull();
  });

  it("coalesces slow page polls instead of starving their results", async () => {
    vi.useFakeTimers();
    try {
      let resolvePages: ((pages: unknown[]) => void) | null = null;
      fetchPagesMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePages = resolve;
        }),
      );
      await renderHook();
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolvePages?.([
          {
            id: "slow-page",
            url: "https://slow.example/",
            host: "slow.example",
            label: "Slow",
            title: "Slow",
            isActive: true,
            canGoBack: false,
            canGoForward: false,
          },
        ]);
        await Promise.resolve();
      });
      expect(latestResult?.pages[0]?.id).toBe("slow-page");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient capability failures", async () => {
    vi.useFakeTimers();
    try {
      fetchCapabilitiesMock
        .mockRejectedValueOnce(Object.assign(new Error("origin starting"), { status: 503 }))
        .mockResolvedValue({
          version: 2,
          viewerKinds: ["rfb"],
          preferredViewer: "rfb",
          viewportOnly: true,
          controls: { navigate: true, history: true, reload: true, focusPage: true },
        });
      await renderHook();
      expect(latestResult?.capabilitiesResolved).toBe(true);
      expect(latestResult?.capabilities).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchCapabilitiesMock).toHaveBeenCalledTimes(2);
      expect(latestResult?.capabilities?.viewportOnly).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the active page immediately when focusing another tab fails", async () => {
    fetchPagesMock.mockResolvedValue([
      {
        id: "page-1",
        url: "https://example.com/",
        host: "example.com",
        label: "Example",
        title: "Example",
        isActive: true,
        canGoBack: true,
        canGoForward: false,
      },
      {
        id: "page-2",
        url: "https://instafy.dev/",
        host: "instafy.dev",
        label: "Instafy",
        title: "Instafy",
        isActive: false,
        canGoBack: false,
        canGoForward: false,
      },
    ]);
    let rejectFocus: ((reason: Error) => void) | null = null;
    focusPageMock.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectFocus = reject;
      }),
    );
    await renderHook();
    fetchPagesMock.mockClear();

    let focusPromise: Promise<boolean> | undefined;
    await act(async () => {
      focusPromise = latestResult?.focusPage("page-2");
      void focusPromise?.catch(() => undefined);
      await Promise.resolve();
    });
    expect(latestResult?.pages.find((page) => page.isActive)?.id).toBe("page-2");

    await act(async () => {
      rejectFocus?.(new Error("focus was rejected"));
      await expect(focusPromise).rejects.toThrow("focus was rejected");
    });

    expect(fetchPagesMock).toHaveBeenCalledTimes(1);
    expect(latestResult?.pages.find((page) => page.isActive)?.id).toBe("page-1");
  });

  it("ignores a capability response from the previous project scope", async () => {
    let resolveOldCapabilities: ((value: unknown) => void) | null = null;
    fetchCapabilitiesMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldCapabilities = resolve;
        }),
      )
      .mockResolvedValueOnce({
        version: 2,
        viewerKinds: ["rfb"],
        preferredViewer: "rfb",
        viewportOnly: true,
        controls: { navigate: true, history: true, reload: true, focusPage: true },
      });
    await renderHook();

    hookProjectId = "project-2";
    hookRuntimeId = "runtime-2";
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestResult?.capabilities?.viewportOnly).toBe(true);

    await act(async () => {
      resolveOldCapabilities?.({
        version: 2,
        viewerKinds: ["rfb"],
        preferredViewer: "rfb",
        viewportOnly: false,
        controls: { navigate: false, history: false, reload: false, focusPage: false },
      });
      await Promise.resolve();
    });
    expect(latestResult?.capabilities?.viewportOnly).toBe(true);
  });

  it("keeps polling an open session while Instafy's browser on the space's machine starts", async () => {
    vi.useFakeTimers();
    try {
      const notReady = () => Object.assign(new Error("browser pages unavailable (503)"), {
        status: 503,
        code: "browser_host_not_ready",
      });
      fetchPagesMock.mockRejectedValueOnce(notReady()).mockRejectedValueOnce(notReady());
      await renderHook();
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);
      expect(latestResult?.pages).toEqual([]);
      expect(latestResult?.resolved).toBe(false);
      expect(onUnavailable).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchPagesMock).toHaveBeenCalledTimes(2);
      expect(latestResult?.resolved).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(fetchPagesMock).toHaveBeenCalledTimes(3);
      expect(latestResult?.pages[0]?.id).toBe("page-1");
      expect(onUnavailable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Instafy's browser did not start after two minutes of not-ready answers, and clears once a read succeeds", async () => {
    vi.useFakeTimers();
    try {
      const notReady = () => Object.assign(new Error("browser pages unavailable (503)"), {
        status: 503,
        code: "browser_host_not_ready",
      });
      fetchPagesMock.mockReset().mockImplementation(async () => { throw notReady(); });
      const startedAt = Date.now();
      await renderHook();
      expect(latestResult?.hostNotReadySinceMs).toBe(startedAt);
      expect(latestResult?.hostNotReady).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(119_000);
      });
      // Still the same unbroken run of answers.
      expect(latestResult?.hostNotReadySinceMs).toBe(startedAt);
      expect(latestResult?.hostNotReady).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(latestResult?.hostNotReady).toBe(true);
      fetchPagesMock.mockResolvedValue([
        { id: "page-1", url: "https://example.com/", host: "example.com", label: "Example", title: "Example",
          isActive: true, canGoBack: false, canGoForward: false },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(latestResult?.resolved).toBe(true);
      expect(latestResult?.hostNotReady).toBe(false);
      expect(latestResult?.hostNotReadySinceMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up a page read that never answers after ten seconds and asks again", async () => {
    vi.useFakeTimers();
    try {
      fetchPagesMock.mockReset()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue([
          { id: "page-2", url: "https://example.com/", host: "example.com", label: "Example", title: "Example",
            isActive: true, canGoBack: false, canGoForward: false },
        ]);
      await renderHook();
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_500);
      });
      // Polls before the bound share the read in flight.
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect((fetchPagesMock.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true);
      expect(fetchPagesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(latestResult?.pages[0]?.id).toBe("page-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends a hidden session that answers not ready, so an idle browser is never polled", async () => {
    vi.useFakeTimers();
    try {
      hookSuspendOnUnavailable = true;
      fetchPagesMock.mockRejectedValue(Object.assign(new Error("browser pages unavailable (503)"), {
        status: 503,
        code: "browser_host_not_ready",
      }));
      await renderHook();
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(fetchPagesMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes polling when a hidden unavailable session is reopened", async () => {
    hookSuspendOnUnavailable = true;
    fetchPagesMock.mockRejectedValueOnce(
      Object.assign(new Error("runtime unavailable"), { status: 503 }),
    );
    await renderHook();
    expect(latestResult?.pages).toEqual([]);
    expect(fetchPagesMock).toHaveBeenCalledTimes(1);

    hookSuspendOnUnavailable = false;
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchPagesMock).toHaveBeenCalledTimes(2);
    expect(latestResult?.pages[0]?.id).toBe("page-1");
  });
});
