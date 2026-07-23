// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserTransportSelector,
  PersonalBrowserSurface,
} from "../PersonalBrowserSurface";
import type { usePersonalBrowserBridge } from "../usePersonalBrowserBridge";

type PersonalBrowserModel = ReturnType<typeof usePersonalBrowserBridge>;

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function createModel(): PersonalBrowserModel {
  return {
    agentError: null,
    agentPhase: "ready",
    available: true,
    checked: true,
    clearDataError: null,
    clearDataState: "idle",
    clearNavigationError: vi.fn(),
    clearData: vi.fn(async () => null),
    close: vi.fn(async () => null),
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    navigate: vi.fn(async () => null),
    navigationError: null,
    ownerId: "owner-1",
    reload: vi.fn(async () => null),
    recovering: false,
    retryAgentControl: vi.fn(async () => null),
    retryOpen: vi.fn(),
    runtimeOverride: {
      runtimeId: "desktop-personal-project-1",
      runtimeDisplayName: "Personal Browser on this device",
      preferRuntime: false,
    },
    setAgentControlEnabled: vi.fn(async () => null),
    status: {
      supported: true,
      enabled: true,
      state: "ready",
      visible: true,
      url: "https://example.com/",
      canGoBack: true,
      canGoForward: false,
      agentControlEnabled: true,
      ownerId: "owner-1",
      projectId: "project-1",
      runtimeId: "desktop-personal-project-1",
    },
  };
}

describe("PersonalBrowserSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame;
  let originalCancelAnimationFrame: typeof cancelAnimationFrame;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalResizeObserver = globalThis.ResizeObserver;
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    globalThis.ResizeObserver = class MockResizeObserver implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 410,
      bottom: 320,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.instafyDesktop;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reports valid viewport bounds and explicitly hides the native view", async () => {
    const setBounds = vi.fn(
      async (bounds: InstafyDesktopPersonalBrowserBounds) => {
        void bounds;
        return createModel().status!;
      },
    );
    window.instafyDesktop = {
      notify: vi.fn(async () => undefined),
      personalBrowserSetBounds: setBounds,
    };
    const model = createModel();
    const transportSelector = (
      <BrowserTransportSelector
        checked
        mode="personal"
        onModeChange={vi.fn()}
        personalAvailable
      />
    );

    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={transportSelector}
        />,
      );
    });
    expect(setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
      visible: true,
      ownerId: "owner-1",
    });
    expect(container.textContent).not.toContain("Personal on this device");
    expect(
      container.querySelector('[data-testid="browser-transport-personal"]')?.textContent,
    ).toBe("Personal");
    expect(container.textContent).toContain("Ready");
    expect(
      container
        .querySelector('[data-testid="personal-browser-agent-status"]')
        ?.getAttribute("aria-label"),
    ).toContain("Personal Browser and agent control are ready");

    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active={false}
          model={model}
          transportSelector={transportSelector}
        />,
      );
    });
    const hiddenBounds = setBounds.mock.calls.at(-1)?.[0];
    expect(hiddenBounds?.visible).toBe(false);
    expect(hiddenBounds?.width).toBeGreaterThanOrEqual(1);
    expect(hiddenBounds?.height).toBeGreaterThanOrEqual(1);
  });

  it("keeps Personal disabled when the desktop bridge is unavailable", async () => {
    const onModeChange = vi.fn();
    await act(async () => {
      root.render(
        <BrowserTransportSelector
          checked
          mode="shared"
          onModeChange={onModeChange}
          personalAvailable={false}
        />,
      );
    });
    const personal = container.querySelector<HTMLButtonElement>(
      '[data-testid="browser-transport-personal"]',
    );
    const shared = container.querySelector<HTMLButtonElement>(
      '[data-testid="browser-transport-shared"]',
    );
    expect(personal?.disabled).toBe(true);
    expect(personal?.getAttribute("aria-label")).toBe("Personal on this device");
    expect(shared?.getAttribute("aria-label")).toBe("Shared with your team");
    expect(
      document.getElementById(personal?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("stay on this device");
    expect(
      document.getElementById(shared?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Project members can see and reuse logins");
    await act(async () => shared?.click());
    expect(onModeChange).toHaveBeenCalledWith("shared");
  });

  it("associates invalid-address feedback with the address field", async () => {
    const model = createModel();
    model.navigationError =
      "Enter an http:// or https:// address. Personal Browser blocks privileged address types.";

    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span data-testid="transport">Personal</span>}
        />,
      );
    });

    const address = container.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    );
    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(address?.getAttribute("aria-invalid")).toBe("true");
    expect(address?.getAttribute("aria-describedby")).toBe(
      "personal-browser-address-error",
    );
    expect(alert?.id).toBe("personal-browser-address-error");
    expect(alert?.textContent).toContain("blocks privileged address types");
  });

  it("navigates from the in-field Go button", async () => {
    const model = createModel();
    model.status = { ...model.status!, agentControlEnabled: false };
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    const address = container.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    )!;
    const go = container.querySelector<HTMLButtonElement>(
      '[data-testid="personal-browser-go"]',
    )!;

    await act(async () => {
      address.focus();
      setInputValue(address, "https://instafy.dev/docs");
      go.focus();
    });
    await act(async () => go.click());

    expect(model.navigate).toHaveBeenCalledWith("https://instafy.dev/docs");
    expect(document.activeElement).not.toBe(address);
  });

  it("locks human navigation controls while agent control owns the native view", async () => {
    const model = createModel();
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span>Personal</span>}
        />,
      );
    });

    const address = container.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    );
    const go = container.querySelector<HTMLButtonElement>(
      '[data-testid="personal-browser-go"]',
    );
    expect(address?.disabled).toBe(true);
    expect(address?.placeholder).toBe("Pause agent control to navigate");
    expect(go?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Pause agent control"]')).toBeTruthy();
    expect(model.navigate).not.toHaveBeenCalled();
  });

  it("offers explicit browser and agent recovery actions instead of Pause", async () => {
    const retryOpen = vi.fn();
    const errorModel = createModel();
    errorModel.retryOpen = retryOpen;
    errorModel.status = {
      ...errorModel.status!,
      state: "error",
      visible: false,
      error: "Browser process exited",
    };

    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={errorModel}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    const browserRetry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Retry Personal Browser"),
    );
    expect(browserRetry).toBeTruthy();
    await act(async () => browserRetry?.click());
    expect(retryOpen).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Pause agent control"]')).toBeNull();

    const retryAgentControl = vi.fn(async () => null);
    const agentErrorModel = createModel();
    agentErrorModel.agentPhase = "unavailable";
    agentErrorModel.agentError = "Desktop agent stopped";
    agentErrorModel.status = {
      ...agentErrorModel.status!,
      agentControlEnabled: false,
      runtimeId: undefined,
    };
    agentErrorModel.retryAgentControl = retryAgentControl;
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={agentErrorModel}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    const agentRetry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry agent control"]',
    );
    expect(agentRetry).toBeTruthy();
    expect(container.querySelector('[aria-label="Pause agent control"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="personal-browser-agent-status"]')
        ?.textContent,
    ).toContain("Unavailable");
    expect(
      container.querySelector('[data-testid="personal-browser-feedback"]')
        ?.textContent,
    ).toContain("Desktop agent stopped");
    await act(async () => agentRetry?.click());
    expect(retryAgentControl).toHaveBeenCalledTimes(1);
  });

  it("announces clear-data progress and completion without duplicating the Chat tab", async () => {
    const model = createModel();
    model.clearDataState = "clearing";

    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span data-testid="transport">Personal</span>}
        />,
      );
    });
    expect(container.textContent).toContain("Clearing Personal Browser data…");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Clearing personal browser data"]',
      )?.disabled,
    ).toBe(true);
    expect(container.querySelector('[aria-label="Back to chat"]')).toBeNull();

    model.clearDataState = "succeeded";
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    expect(
      Array.from(container.querySelectorAll('[role="status"]')).some((element) =>
        element.textContent?.includes("Personal Browser data cleared."),
      ),
    ).toBe(true);
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss browser message"]',
    );
    expect(dismiss).toBeTruthy();
    await act(async () => dismiss?.click());
    expect(container.textContent).not.toContain("Personal Browser data cleared.");

    model.clearDataState = "clearing";
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    model.clearDataState = "succeeded";
    await act(async () => {
      root.render(
        <PersonalBrowserSurface
          active
          model={model}
          transportSelector={<span>Personal</span>}
        />,
      );
    });
    expect(container.textContent).toContain("Personal Browser data cleared.");
  });
});
