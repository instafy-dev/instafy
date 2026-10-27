// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCredentialsStatusBubble } from "../AiCredentialsStatusBubble";
import { defaultAiConnectWizardState, writeAiConnectWizardState } from "../aiConnectWizardStorage";

// The controller's answer when OpenAI refuses to hand out a code at all.
const REFUSAL =
  "ChatGPT device-code login is not enabled. Enable it in ChatGPT Settings → Security, or ask your workspace admin to allow it in workspace permissions, then generate a new code.";

const mocks = vi.hoisted(() => ({
  nativeBackHandler: null as null | (() => void),
  startDeviceAuth: vi.fn(),
}));

vi.mock("../../../../native/useNativeBackButtonAction", () => ({
  useNativeBackButtonAction: (_enabled: boolean, onBack: () => void) => {
    mocks.nativeBackHandler = onBack;
  },
}));

// The real device-auth flow runs, so the refusal is the flow's own error
// rather than a fixed mock value that no reset can clear.
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    credentials: {
      list: vi.fn(),
      setDefault: vi.fn(),
      test: vi.fn(),
      startDeviceAuth: mocks.startDeviceAuth,
      cancelDeviceAuth: vi.fn(),
      getDeviceAuthStatus: vi.fn(),
    },
  },
}));

const WIZARD_KEY = "test:device-code-refused-wizard";

describe("AiCredentialsStatusBubble after a refused code request", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    mocks.nativeBackHandler = null;
    mocks.startDeviceAuth.mockResolvedValue({ success: false, error: REFUSAL });
    writeAiConnectWizardState(WIZARD_KEY, {
      ...defaultAiConnectWizardState(),
      open: true,
      provider: "openai",
      step: "openai-auth",
      updatedAt: Date.now(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  const notice = () => container.querySelector('[data-testid="chat-ai-device-code-disabled"]');
  const buttonLabelled = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  const press = async (target: Element | null | undefined) => {
    expect(target).toBeInstanceOf(HTMLElement);
    await act(async () => {
      (target as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  async function reachRefusal() {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          storageKey={WIZARD_KEY}
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });
    await press(buttonLabelled("ChatGPT login (Plus/Team)"));
    await press(buttonLabelled("Browser login (device code)"));
    const prerequisite = container.querySelector('[data-testid="chat-ai-device-code-prerequisite"]');
    await press(Array.from(prerequisite?.querySelectorAll("button") ?? []).at(-1));
    expect(mocks.startDeviceAuth).toHaveBeenCalledWith("codex");
    expect(notice()).toBeInstanceOf(HTMLElement);
  }

  function expectLoginMethods() {
    expect(notice()).toBeNull();
    expect(container.textContent).toContain("Pick a login method:");
    expect(buttonLabelled("Browser login (device code)")).toBeInstanceOf(HTMLButtonElement);
  }

  it("leaves the notice on the first header Back press", async () => {
    await reachRefusal();

    await press(container.querySelector('button[aria-label="Back"]'));

    expectLoginMethods();
  });

  it("leaves the notice on the first Android back press", async () => {
    await reachRefusal();
    expect(mocks.nativeBackHandler).toBeTypeOf("function");

    await act(async () => {
      mocks.nativeBackHandler?.();
      await Promise.resolve();
    });

    expectLoginMethods();
  });
});
