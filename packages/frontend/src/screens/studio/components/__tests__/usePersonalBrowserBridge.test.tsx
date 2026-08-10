// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controllerMocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  resolveRequestContext: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    core: { resolveRequestContext: controllerMocks.resolveRequestContext },
    runtimes: { fetchStatus: controllerMocks.fetchStatus },
  },
}));

vi.mock("../../../../services/runtimeController/core", () => ({
  controllerBaseUrl: "https://controller.example.test",
}));

import { usePersonalBrowserBridge } from "../usePersonalBrowserBridge";

type HookResult = ReturnType<typeof usePersonalBrowserBridge>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function personalBrowserStatus(
  overrides: Partial<InstafyDesktopPersonalBrowserStatus> = {},
): InstafyDesktopPersonalBrowserStatus {
  return {
    supported: true,
    enabled: true,
    state: "closed",
    visible: false,
    url: "about:blank",
    canGoBack: false,
    canGoForward: false,
    agentControlEnabled: false,
    ...overrides,
  };
}

function controllerRequestContext(
  accessToken: string | null = "controller-token",
  credentialSource: "ambient" | "fixed" | null = accessToken ? "ambient" : null,
) {
  return {
    baseUrl: "https://controller.example.test",
    accessToken,
    credentialSource,
    generation: 1,
  };
}

function Harness({
  active = true,
  profileUserId = "user-1",
  projectId = "project-1",
  resultRef,
}: {
  active?: boolean;
  profileUserId?: string | null;
  projectId?: string | null;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = usePersonalBrowserBridge({ active, profileUserId, projectId });
  return null;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

describe("usePersonalBrowserBridge lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let statusListener: ((status: InstafyDesktopPersonalBrowserStatus) => void) | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
    statusListener = null;
    controllerMocks.fetchStatus.mockReset();
    controllerMocks.resolveRequestContext.mockReset();
    controllerMocks.resolveRequestContext.mockResolvedValue(controllerRequestContext());
  });

  afterEach(async () => {
    if (mounted) {
      await act(async () => root.unmount());
    }
    container.remove();
    delete window.instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.restoreAllMocks();
  });

  it("releases a ready owner on unmount and reclaims the same browser state on remount", async () => {
    let current = personalBrowserStatus();
    const owners: string[] = [];
    const close = vi.fn(async () => personalBrowserStatus());
    const release = vi.fn(async ({ ownerId }: { ownerId: string }) => {
      if (current.ownerId === ownerId) {
        current = personalBrowserStatus({
          state: "ready",
          projectId: "project-1",
          url: "https://example.test/kept",
        });
      }
      return current;
    });
    const open = vi.fn(async (options: { ownerId: string }) => {
      owners.push(options.ownerId);
      current = personalBrowserStatus({
        state: "ready",
        ownerId: options.ownerId,
        projectId: "project-1",
        url: "https://example.test/kept",
      });
      return current;
    });
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: close,
      personalBrowserOpen: open,
      personalBrowserRelease: release,
      personalBrowserSetBounds: vi.fn(async () => current),
      personalBrowserStatus: vi.fn(async () => current),
    };
    const firstResultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={firstResultRef} />);
    });
    await waitUntil(() => firstResultRef.current?.status?.state === "ready");
    const firstOwnerId = owners[0];
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerUrl: "https://controller.example.test",
        controllerAccessToken: "controller-token",
        profileUserId: "user-1",
      }),
    );

    await act(async () => root.unmount());
    mounted = false;
    await waitUntil(() => release.mock.calls.length === 1);
    expect(release).toHaveBeenCalledWith({ ownerId: firstOwnerId });
    expect(close).not.toHaveBeenCalled();

    root = createRoot(container);
    mounted = true;
    const replacementResultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness resultRef={replacementResultRef} />);
    });
    await waitUntil(() => open.mock.calls.length === 2);
    expect(owners[1]).not.toBe(firstOwnerId);
    expect(replacementResultRef.current?.status?.url).toBe("https://example.test/kept");
    expect(close).not.toHaveBeenCalled();
  });

  it("does not open Personal Browser for a fixed controller binding", async () => {
    const closed = personalBrowserStatus();
    const open = vi.fn(async () => closed);
    controllerMocks.resolveRequestContext.mockResolvedValue(
      controllerRequestContext("fixed-override-token", "fixed"),
    );
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      personalBrowserOpen: open,
      personalBrowserSetBounds: vi.fn(async () => closed),
      personalBrowserStatus: vi.fn(async () => closed),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => resultRef.current?.status?.state === "error");

    expect(open).not.toHaveBeenCalled();
    expect(resultRef.current?.status?.error).toContain("overridden controller session");
  });

  it("keeps the same owner and page while the Browser subtab is temporarily inactive", async () => {
    let current = personalBrowserStatus();
    const open = vi.fn(async ({ ownerId }: { ownerId: string }) => {
      current = personalBrowserStatus({
        state: "ready",
        ownerId,
        projectId: "project-1",
        url: "https://example.test/preserved",
        agentControlEnabled: false,
      });
      return current;
    });
    const release = vi.fn(async () => current);
    const close = vi.fn(async () => personalBrowserStatus());
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: close,
      personalBrowserOpen: open,
      personalBrowserRelease: release,
      personalBrowserSetBounds: vi.fn(async () => current),
      personalBrowserStatus: vi.fn(async () => current),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => root.render(<Harness active resultRef={resultRef} />));
    await waitUntil(() => resultRef.current?.status?.state === "ready");
    const ownerId = resultRef.current?.ownerId;

    await act(async () => root.render(<Harness active={false} resultRef={resultRef} />));
    await act(async () => root.render(<Harness active resultRef={resultRef} />));

    expect(open).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(resultRef.current?.ownerId).toBe(ownerId);
    expect(resultRef.current?.status?.url).toBe("https://example.test/preserved");
  });

  it("cannot close a newer owner when an unmounted open resolves late", async () => {
    const opening = deferred<InstafyDesktopPersonalBrowserStatus>();
    const closed = personalBrowserStatus();
    let currentOwnerId: string | null = null;
    let firstOwnerId: string | null = null;
    const close = vi.fn(async ({ ownerId }: { ownerId: string }) => {
      if (currentOwnerId === ownerId) {
        currentOwnerId = null;
        return closed;
      }
      return personalBrowserStatus({
        state: "ready",
        ownerId: currentOwnerId ?? undefined,
        projectId: "project-1",
      });
    });
    const release = vi.fn(async ({ ownerId }: { ownerId: string }) => {
      if (currentOwnerId === ownerId) {
        currentOwnerId = null;
        return closed;
      }
      return personalBrowserStatus({
        state: "ready",
        ownerId: currentOwnerId ?? undefined,
        projectId: "project-1",
      });
    });
    const open = vi.fn(
      async ({ ownerId }: { ownerId: string }) => {
        currentOwnerId = ownerId;
        if (!firstOwnerId) {
          firstOwnerId = ownerId;
          return opening.promise;
        }
        return personalBrowserStatus({
          state: "ready",
          ownerId,
          projectId: "project-1",
        });
      },
    );
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: close,
      personalBrowserOpen: open,
      personalBrowserRelease: release,
      personalBrowserSetBounds: vi.fn(async () => closed),
      personalBrowserStatus: vi.fn(async () => closed),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => open.mock.calls.length === 1);

    await act(async () => root.unmount());
    mounted = false;
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    root = createRoot(container);
    mounted = true;
    const replacementResultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness resultRef={replacementResultRef} />);
    });
    await waitUntil(() => open.mock.calls.length === 2);
    const replacementOwnerId = open.mock.calls[1]?.[0].ownerId;
    expect(replacementOwnerId).toBeTruthy();
    expect(replacementOwnerId).not.toBe(firstOwnerId);
    expect(currentOwnerId).toBe(replacementOwnerId);

    opening.resolve(
      personalBrowserStatus({
        state: "ready",
        ownerId: firstOwnerId ?? undefined,
        projectId: "project-1",
      }),
    );
    await act(async () => {
      await opening.promise;
      await Promise.resolve();
    });
    expect(release.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(release.mock.calls.at(-1)?.[0]).toEqual({ ownerId: firstOwnerId });
    expect(close).not.toHaveBeenCalled();
    expect(currentOwnerId).toBe(replacementOwnerId);
    expect(replacementResultRef.current?.status?.ownerId).toBe(replacementOwnerId);
  });

  it("waits for explicit recovery after an open error and reports rejected addresses", async () => {
    const closed = personalBrowserStatus();
    let ownerId = "";
    const ready = () =>
      personalBrowserStatus({
        state: "ready",
        ownerId,
        projectId: "project-1",
      });
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("browser process exited"))
      .mockImplementation(async (options: { ownerId: string }) => {
        ownerId = options.ownerId;
        return ready();
      });
    const navigate = vi.fn(async () => ready());
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: vi.fn(async () => closed),
      personalBrowserNavigate: navigate,
      personalBrowserOpen: open,
      personalBrowserSetBounds: vi.fn(async () => ready()),
      personalBrowserStatus: vi.fn(async () => closed),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => resultRef.current?.status?.state === "error");
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.recovering).toBe(false);

    await act(async () => resultRef.current?.retryOpen());
    await waitUntil(() => open.mock.calls.length === 2);
    await waitUntil(() => resultRef.current?.status?.state === "ready");
    expect(resultRef.current?.status?.ownerId).toBe(ownerId);

    await act(async () => {
      await resultRef.current?.navigate("javascript:alert(1)");
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(resultRef.current?.navigationError).toContain("blocks privileged address types");
    await act(async () => resultRef.current?.clearNavigationError());
    expect(resultRef.current?.navigationError).toBeNull();
  });

  it("tracks clear-data progress and preserves a usable browser on failure", async () => {
    const clearing = deferred<InstafyDesktopPersonalBrowserStatus>();
    const closed = personalBrowserStatus();
    let ownerId = "";
    const ready = () =>
      personalBrowserStatus({
        state: "ready",
        ownerId,
        projectId: "project-1",
      });
    const clearData = vi.fn(() => clearing.promise);
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClearData: clearData,
      personalBrowserClose: vi.fn(async () => closed),
      personalBrowserOpen: vi.fn(async (options) => {
        ownerId = options.ownerId;
        return ready();
      }),
      personalBrowserSetBounds: vi.fn(async () => ready()),
      personalBrowserStatus: vi.fn(async () => closed),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => resultRef.current?.status?.state === "ready");

    let clearPromise: ReturnType<HookResult["clearData"]> | undefined;
    await act(async () => {
      clearPromise = resultRef.current?.clearData();
      await Promise.resolve();
    });
    expect(resultRef.current?.clearDataState).toBe("clearing");
    expect(clearData).toHaveBeenCalledWith({ ownerId });

    clearing.resolve(ready());
    await act(async () => {
      await clearPromise;
    });
    expect(resultRef.current?.clearDataState).toBe("succeeded");
    expect(resultRef.current?.clearDataError).toBeNull();
    expect(resultRef.current?.status?.state).toBe("ready");

    clearData.mockRejectedValueOnce(new Error("storage service unavailable"));
    await act(async () => {
      await resultRef.current?.clearData();
    });
    expect(resultRef.current?.clearDataState).toBe("failed");
    expect(resultRef.current?.clearDataError).toBe("storage service unavailable");
    expect(resultRef.current?.status?.state).toBe("ready");
  });

  it("invalidates a runtime start when agent control is paused and retries after resume", async () => {
    const firstContext = deferred<ReturnType<typeof controllerRequestContext>>();
    const closed = personalBrowserStatus();
    let ownerId = "";
    const ready = () =>
      personalBrowserStatus({
        state: "ready",
        agentControlEnabled: true,
        ownerId,
        projectId: "project-1",
      });
    const readyWithRuntime = () =>
      personalBrowserStatus({
        ...ready(),
        runtimeId: "runtime-2",
      });
    const startRuntime = vi.fn(async () => ({ pid: 42, runtimeId: "runtime-2" }));
    const status = vi
      .fn<() => Promise<InstafyDesktopPersonalBrowserStatus>>()
      .mockResolvedValueOnce(closed)
      .mockImplementation(async () => readyWithRuntime());
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: vi.fn(async () => closed),
      personalBrowserOpen: vi.fn(async (options) => {
        ownerId = options.ownerId;
        return ready();
      }),
      personalBrowserSetBounds: vi.fn(async () => ready()),
      personalBrowserStatus: status,
      startDesktopRuntime: startRuntime,
      stopDesktopRuntime: vi.fn(async () => undefined),
    };
    controllerMocks.resolveRequestContext
      .mockResolvedValueOnce(controllerRequestContext())
      .mockReturnValueOnce(firstContext.promise)
      .mockResolvedValue(controllerRequestContext());
    controllerMocks.fetchStatus.mockResolvedValue({
      preferredRuntimeId: null,
      runtimes: [
        {
          runtimeId: "runtime-2",
          status: "ready",
          provider: "desktop",
          idleTtlSeconds: 600,
          isLocal: true,
          isPreferred: false,
          health: "online",
        },
      ],
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => controllerMocks.resolveRequestContext.mock.calls.length === 2);

    await act(async () => {
      statusListener?.(
        personalBrowserStatus({
          state: "ready",
          agentControlEnabled: false,
          ownerId,
          projectId: "project-1",
        }),
      );
    });
    firstContext.resolve(controllerRequestContext("stale-token"));
    await act(async () => {
      await firstContext.promise;
      await Promise.resolve();
    });
    expect(startRuntime).not.toHaveBeenCalled();
    expect(resultRef.current?.agentPhase).toBe("idle");

    await act(async () => {
      statusListener?.(ready());
    });
    await waitUntil(() => startRuntime.mock.calls.length === 1);
    await waitUntil(() => resultRef.current?.agentPhase === "ready");
    expect(resultRef.current?.runtimeOverride?.runtimeId).toBe("runtime-2");
    expect(startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        personalBrowserOwnerId: ownerId,
        controllerCredentialMode: "ambient",
      }),
    );
  });

  it("closes the retired owner when identity changes while the browser is inactive", async () => {
    const closed = personalBrowserStatus();
    let ownerId = "";
    const close = vi.fn(async ({ ownerId: closingOwnerId }: { ownerId: string }) => {
      expect(closingOwnerId).toBe(ownerId);
      return closed;
    });
    const open = vi.fn(async (options) => {
      ownerId = options.ownerId;
      return personalBrowserStatus({
        state: "ready",
        ownerId,
        projectId: "project-1",
      });
    });
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: close,
      personalBrowserOpen: open,
      personalBrowserSetBounds: vi.fn(async () => closed),
      personalBrowserStatus: vi.fn(async () => closed),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => resultRef.current?.status?.state === "ready");
    expect(ownerId).toBeTruthy();

    await act(async () => {
      root.render(
        <Harness
          active={false}
          profileUserId="user-2"
          projectId="project-2"
          resultRef={resultRef}
        />,
      );
    });

    await waitUntil(() => close.mock.calls.length === 1);
    expect(close).toHaveBeenCalledWith({ ownerId });
    expect(open).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.runtimeOverride).toBeNull();
  });

  it("keeps the ready browser and Resume state when agent-control enablement fails", async () => {
    const closed = personalBrowserStatus();
    let ownerId = "";
    const paused = () =>
      personalBrowserStatus({
        state: "ready",
        agentControlEnabled: false,
        ownerId,
        projectId: "project-1",
      });
    const setAgentControl = vi.fn(async () => {
      throw new Error("runtime restart failed");
    });
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      onPersonalBrowserStatus: vi.fn((listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      personalBrowserClose: vi.fn(async () => closed),
      personalBrowserOpen: vi.fn(async (options) => {
        ownerId = options.ownerId;
        return paused();
      }),
      personalBrowserSetAgentControlEnabled: setAgentControl,
      personalBrowserSetBounds: vi.fn(async () => paused()),
      personalBrowserStatus: vi
        .fn<() => Promise<InstafyDesktopPersonalBrowserStatus>>()
        .mockResolvedValueOnce(closed)
        .mockImplementation(async () => paused()),
      stopDesktopRuntime: vi.fn(async () => undefined),
    };
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    await waitUntil(() => resultRef.current?.status?.state === "ready");

    await act(async () => {
      await resultRef.current?.setAgentControlEnabled(true);
    });

    expect(setAgentControl).toHaveBeenCalledWith({ enabled: true, ownerId });
    expect(resultRef.current?.status?.state).toBe("ready");
    expect(resultRef.current?.status?.agentControlEnabled).toBe(false);
    expect(resultRef.current?.agentError).toBe("runtime restart failed");
    expect(resultRef.current?.agentPhase).toBe("unavailable");
    expect(resultRef.current?.runtimeOverride).toBeNull();
  });
});
