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
    vi.restoreAllMocks();
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

  it("opens tools above the native page without changing its bounds or authority", async () => {
    const model = createModel();
    const setBounds = vi.fn(async (bounds: InstafyDesktopPersonalBrowserBounds) => ({...model.status!, ...(bounds.occluded ? {previewDataUrl:"data:image/jpeg;base64,AQID"} : {})}));
    window.instafyDesktop = { notify: vi.fn(), personalBrowserSetBounds: setBounds };
    await act(async () => root.render(<PersonalBrowserSurface active model={model} transportSelector={null} />));
    const original = setBounds.mock.calls.at(-1);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    expect(setBounds).toHaveBeenLastCalledWith({ x:10, y:20, width:400, height:300, ownerId:"owner-1", visible:true, occluded:true });
    expect(document.querySelector('[role="dialog"][aria-label="Browser settings"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="personal-browser-overlay-preview"]')?.getAttribute("src")).toBe("data:image/jpeg;base64,AQID");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    expect(setBounds.mock.calls.at(-1)).toEqual(original);
    expect(document.querySelector('[data-testid="personal-browser-overlay-preview"]')).toBeNull();
    expect(model.close).not.toHaveBeenCalled();
    expect(model.setAgentControlEnabled).not.toHaveBeenCalled();
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
          sharingControls={<div data-testid="sharing-controls">Share this tab</div>}
        />,
      );
    });
    expect(setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
      visible: true,
      occluded: false,
      ownerId: "owner-1",
    });
    expect(container.textContent).toContain("This device");
    expect(
      document.querySelector('[data-testid="browser-transport-personal"]')?.textContent,
    ).toBe("This device");
    expect(container.textContent).toContain("Ready");
    const chrome = document.querySelector('[data-testid="personal-browser-chrome"]')!;
    const sharing = document.querySelector('[data-testid="sharing-controls"]')!;
    const viewport = document.querySelector('[data-testid="personal-browser-viewport"]')!;
    expect(chrome.compareDocumentPosition(sharing) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(chrome.contains(sharing)).toBe(true);
    expect(chrome.parentElement?.nextElementSibling).toBe(viewport);
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
    const personal = document.querySelector<HTMLButtonElement>(
      '[data-testid="browser-transport-personal"]',
    );
    const shared = document.querySelector<HTMLButtonElement>(
      '[data-testid="browser-transport-shared"]',
    );
    expect(personal?.disabled).toBe(true);
    expect(personal?.getAttribute("aria-label")).toBe("This device");
    expect(shared?.getAttribute("aria-label")).toBe("Workspace browser");
    expect(
      document.getElementById(personal?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("stay on this device");
    expect(
      document.getElementById(shared?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Project members see the same remote browser");
    await act(async () => shared?.click());
    expect(onModeChange).toHaveBeenCalledWith("shared");
  });

  it("expands compact Personal browsing without closing or pausing its native page", async () => {
    const model = createModel();
    await act(async () => root.render(
      <PersonalBrowserSurface active compactChrome model={model} transportSelector={null} />,
    ));
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="personal-browser-fullscreen-toggle"]');
    expect(toggle?.getAttribute("aria-label")).toBe("Expand browser");
    await act(async () => toggle?.click());
    expect(document.querySelector('[data-testid="personal-browser-expanded"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="personal-browser-viewport"]')).not.toBeNull();
    expect(model.close).not.toHaveBeenCalled();
    expect(model.setAgentControlEnabled).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="personal-browser-fullscreen-toggle"]')?.click());
    expect(document.querySelector('[data-testid="personal-browser-viewport"]')).not.toBeNull();
    expect(model.close).not.toHaveBeenCalled();
  });

  it("offers routine permission before Resume only on a supporting native host", async () => {
    const model = createModel();
    model.status = { ...model.status!, agentControlEnabled: false, approvalMode: "ask", approvalModes: ["ask", "routine"] };
    await act(async () => root.render(
      <PersonalBrowserSurface active model={model} transportSelector={null} />,
    ));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="personal-browser-routine-approval"]');
    expect(checkbox?.checked).toBe(false);
    await act(async () => checkbox?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Resume agent control"]')?.click());
    expect(model.setAgentControlEnabled).toHaveBeenCalledWith(true, "routine");
    const legacyModel = createModel();
    await act(async () => root.render(
      <PersonalBrowserSurface active model={legacyModel} transportSelector={null} />,
    ));
    expect(document.querySelector('[data-testid="personal-browser-routine-approval"]')).toBeNull();
  });

  it("keeps profile ownership accessible when compact controls hide their text", async () => {
    await act(async () => {
      root.render(
        <BrowserTransportSelector
          checked
          compact
          mode="personal"
          onModeChange={vi.fn()}
          personalAvailable
        />,
      );
    });
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label"))
      .toBe("Browser profile");
    const personal = document.querySelector<HTMLButtonElement>('[data-testid="browser-transport-personal"]')!;
    const shared = document.querySelector<HTMLButtonElement>('[data-testid="browser-transport-shared"]')!;
    expect(personal.textContent).toBe("");
    expect(shared.textContent).toBe("");
    expect(personal.getAttribute("aria-label")).toBe("This device");
    expect(personal.getAttribute("aria-pressed")).toBe("true");
    expect(shared.getAttribute("aria-label")).toBe("Workspace browser");
    expect(shared.getAttribute("aria-pressed")).toBe("false");
    const personalDescription = document.getElementById(personal.getAttribute("aria-describedby")!)?.textContent;
    expect(personalDescription).toContain("follow you across projects");
    expect(personalDescription).toContain("not copied to Shared Browser or your other devices");
  });

  it("explains that clearing Personal data affects all projects on this device and respects cancellation", async () => {
    const model = createModel();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => {
      root.render(
        <PersonalBrowserSurface active model={model} transportSelector={<span>Personal</span>} />,
      );
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    const clear = document.querySelector<HTMLButtonElement>('[aria-label="Clear personal browser data"]')!;
    await act(async () => clear.click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("across all your projects on this device"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("does not clear Shared Browser, your Instafy sign-in, or your other browsers"));
    expect(model.clearData).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => clear.click());
    expect(model.clearData).toHaveBeenCalledTimes(1);
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

    const address = document.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    );
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
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
    const address = document.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    )!;
    const go = document.querySelector<HTMLButtonElement>(
      '[data-testid="personal-browser-go"]',
    )!;
    expect(go.classList.contains("pointer-coarse:min-h-11")).toBe(true);
    expect(go.classList.contains("pointer-coarse:min-w-11")).toBe(true);

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

    const address = document.querySelector<HTMLInputElement>(
      '[data-testid="personal-browser-address"]',
    );
    const go = document.querySelector<HTMLButtonElement>(
      '[data-testid="personal-browser-go"]',
    );
    expect(address?.disabled).toBe(true);
    expect(address?.placeholder).toBe("Pause agent control to navigate");
    expect(go?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Pause agent control"]')).toBeTruthy();
    expect(model.navigate).not.toHaveBeenCalled();
  });

  it("offers recovery actions and keeps Pause reachable while native control is still enabled", async () => {
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
    const browserRetry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Retry Personal Browser"),
    );
    expect(browserRetry).toBeTruthy();
    await act(async () => browserRetry?.click());
    expect(retryOpen).toHaveBeenCalledTimes(1);
    const errorPause = document.querySelector<HTMLButtonElement>('[aria-label="Pause agent control"]');
    expect(errorPause).not.toBeNull();
    await act(async () => errorPause?.click());
    expect(errorModel.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(false, undefined);

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
    const agentRetry = document.querySelector<HTMLButtonElement>(
      '[aria-label="Retry agent control"]',
    );
    expect(agentRetry).toBeTruthy();
    expect(document.querySelector('[aria-label="Pause agent control"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="personal-browser-agent-status"]')
        ?.textContent,
    ).toContain("Unavailable");
    expect(
      document.querySelector('[data-testid="personal-browser-feedback"]')
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
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    expect(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Clearing personal browser data"]',
      )?.disabled,
    ).toBe(true);
    expect(document.querySelector('[aria-label="Back to chat"]')).toBeNull();

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
      Array.from(document.querySelectorAll('[role="status"]')).some((element) =>
        element.textContent?.includes("Personal Browser data cleared."),
      ),
    ).toBe(true);
    const dismiss = document.querySelector<HTMLButtonElement>(
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

  it("never latches another native owner's handoff while reclaim is pending", async () => {
    const model = createModel();
    model.ownerId = null;
    model.status = { ...model.status!, agentControlEnabled: false, humanControlReady: true,
      humanInputRequest: { version: 1, handoffId: "previous-conversation", origin: "https://example.com", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] } };
    const onContinue = vi.fn(async () => true);
    const render = async () => act(async () => root.render(
      <PersonalBrowserSurface active model={model} transportSelector={null} humanInputIdentityKey="conversation-b" onContinueAfterHumanInput={onContinue} />,
    ));
    await render();
    expect(container.textContent).not.toContain("Done, continue");
    expect(container.textContent).not.toContain("highlighted field");
    model.ownerId = "replacement-owner";
    model.status = { ...model.status!, ownerId: "replacement-owner", humanInputRequest: undefined };
    await render();
    expect(container.textContent).not.toContain("Done, continue");
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("describes participant control without claiming an agent operation is still stopping", async () => {
    const model = createModel();
    model.status = { ...model.status!, agentControlEnabled: false, humanControlReady: false, tabControlActive: true };
    await act(async () => root.render(<PersonalBrowserSurface active model={model} transportSelector={null} />));
    const status = document.querySelector('[data-testid="personal-browser-agent-status"]');
    expect(status?.getAttribute("title")).toContain("participant controls this tab");
    expect(status?.textContent).toBe("Paused");
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Resume agent control"]')?.disabled).toBe(true);
  });

  it("makes Done the only resume route after user-initiated takeover", async () => {
    const model = createModel();
    model.status = { ...model.status!, humanControlReady: false, approvalModes: ["ask", "routine"], approvalMode: "ask" };
    model.setAgentControlEnabled = vi.fn(async () => ({ ...model.status!, agentControlEnabled: false, humanControlReady: true }));
    const onContinue = vi.fn(async () => true);
    const render = async () => act(async () => root.render(
      <PersonalBrowserSurface active model={model} transportSelector={null} humanInputIdentityKey="conversation-a" onContinueAfterHumanInput={onContinue} />,
    ));
    await render();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-takeover"]')?.click());
    expect(model.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(false);
    model.status = { ...model.status!, agentControlEnabled: false, humanControlReady: true };
    await render();
    expect(document.querySelector('[aria-label="Resume agent control"]')).toBeNull();
    expect(document.querySelector('[aria-label="Retry agent control"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    expect(document.body.textContent).toContain("use Done, continue to resume and send the next turn");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Browser settings"]')!.click());
    expect(container.textContent).not.toContain("Choose before Resume");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')?.click());
    expect(onContinue).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Take a fresh snapshot"), "ask");
    expect(model.setAgentControlEnabled).toHaveBeenCalledTimes(1);
  });

  it("keeps failed handoff retries on Done while leaving Pause reachable after control resumes", async () => {
    const model = createModel();
    model.agentPhase = "unavailable";
    model.agentError = "The previous continuation could not start";
    model.status = { ...model.status!, agentControlEnabled: false, humanControlReady: true,
      humanInputRequest: { version: 1, handoffId: "pending-manual-step", origin: "https://example.com", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] } };
    let finish!: (sent: boolean) => void;
    const onContinue = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const render = async () => act(async () => root.render(
      <PersonalBrowserSurface active model={model} transportSelector={null} humanInputIdentityKey="conversation-a" onContinueAfterHumanInput={onContinue} />,
    ));
    await render();
    expect(document.querySelector('[aria-label="Resume agent control"]')).toBeNull();
    expect(document.querySelector('[aria-label="Retry agent control"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')?.click());
    expect(container.textContent).toContain("browser task was not sent");
    expect(document.querySelector('[aria-label="Resume agent control"]')).toBeNull();
    expect(document.querySelector('[aria-label="Retry agent control"]')).toBeNull();
    expect(model.setAgentControlEnabled).not.toHaveBeenCalled();
    expect(model.retryAgentControl).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')?.click());
    model.status = { ...model.status!, agentControlEnabled: true, humanControlReady: false };
    await render();
    expect(document.querySelector('[aria-label="Retry agent control"]')).toBeNull();
    const pause = document.querySelector<HTMLButtonElement>('[aria-label="Pause agent control"]');
    expect(pause).not.toBeNull();
    await act(async () => pause?.click());
    expect(model.setAgentControlEnabled).toHaveBeenCalledExactlyOnceWith(false, undefined);
    await act(async () => finish(false));
    expect(onContinue).toHaveBeenCalledTimes(2);
  });
});
