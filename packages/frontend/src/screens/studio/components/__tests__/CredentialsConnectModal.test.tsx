// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialsConnectModal,
  type CredentialsConnectModalProps,
} from "../CredentialsConnectModal";

const nativeBackMock = vi.hoisted(() => ({
  enabled: false,
  handler: null as null | (() => void),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android", isNativePlatform: () => false } }));
vi.mock("@capacitor/app", () => ({ App: {
  addListener: async (_event: string, handler: () => void) => {
    nativeBackMock.enabled = true;
    nativeBackMock.handler = handler;
    return { remove: async () => { nativeBackMock.enabled = false; } };
  },
} }));

function mockDesktopWidth(isDesktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isDesktop && query === "(min-width: 640px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

function createProps(
  overrides: Partial<CredentialsConnectModalProps> = {},
): CredentialsConnectModalProps {
  return {
    canManageAiConnections: true,
    canUseDesktopConnect: true,
    desktopCodexAuthJsonStatus: {
      exists: true,
    },
    connectModalOpen: true,
    connectModalStep: "picker",
    connectPending: false,
    deviceAuthBusy: false,
    deviceAuthCompleting: false,
    apiKeyPendingProvider: null,
    showAdvanced: false,
    labelDraft: "",
    openaiApiKeyDraft: "",
    openaiLabelDraft: "",
    deepseekApiKeyDraft: "",
    deepseekLabelDraft: "",
    zaiApiKeyDraft: "",
    zaiLabelDraft: "",
    geminiApiKeyDraft: "",
    deviceAuthError: null,
    deviceAuthProvider: null,
    deviceAuthSession: null,
    fileInputRef: { current: null },
    onClose: vi.fn(),
    onBack: vi.fn(),
    onStepChange: vi.fn(),
    onShowAdvancedChange: vi.fn(),
    onLabelDraftChange: vi.fn(),
    onOpenaiApiKeyDraftChange: vi.fn(),
    onOpenaiLabelDraftChange: vi.fn(),
    onDeepseekApiKeyDraftChange: vi.fn(),
    onDeepseekLabelDraftChange: vi.fn(),
    onZaiApiKeyDraftChange: vi.fn(),
    onZaiLabelDraftChange: vi.fn(),
    onGeminiApiKeyDraftChange: vi.fn(),
    onConnectCodex: vi.fn(),
    canDevSeedCodex: false,
    onDevSeedCodex: vi.fn(),
    onBeginDeviceAuth: vi.fn(),
    onCancelDeviceAuthSession: vi.fn(),
    onTriggerUpload: vi.fn(),
    onUploadFile: vi.fn(),
    onConnectApiKey: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("CredentialsConnectModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockDesktopWidth(true);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    nativeBackMock.enabled = false;
    nativeBackMock.handler = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps the phone key field and selection mounted while its keyboard viewport changes", async () => {
    mockDesktopWidth(false);
    const viewport = Object.assign(new EventTarget(), {
      offsetTop: 0, offsetLeft: 0, width: 390, height: 844, scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    const props = createProps({ connectModalStep: "openai", openaiApiKeyDraft: "test-key-draft" });
    await act(async () => root.render(<CredentialsConnectModal {...props} />));
    const input = document.querySelector<HTMLInputElement>('[data-testid="credentials-openai-api-key-input"]')!;
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!.parentElement!;
    await act(async () => {
      input.focus();
      input.setSelectionRange(2, 5);
      Object.assign(viewport, { height: 280, offsetTop: 20 });
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise(requestAnimationFrame);
    });
    expect(document.querySelector('[data-testid="credentials-openai-api-key-input"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("test-key-draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(modal.style.height).toBe("280px");
    expect(modal.style.top).toBe("20px");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onConnectApiKey).not.toHaveBeenCalled();
  });

  it.each(["button", "native", "escape"])("uses phone %s Back to leave a provider before closing the picker", async (action) => {
    mockDesktopWidth(false);
    const props = createProps({ connectModalStep: "openai" });
    await act(async () => root.render(<CredentialsConnectModal {...props} />));
    const dismiss = async () => act(async () => {
      if (action === "native") nativeBackMock.handler?.();
      else if (action === "button") document.querySelector<HTMLButtonElement>('button[aria-label="Back"], button[aria-label="Close"]')!.click();
      else document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await dismiss();
    expect(props.onBack).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => root.render(<CredentialsConnectModal {...props} connectModalStep="picker" />));
    await dismiss();
    expect(props.onBack).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("blocks every phone dismissal while verifying a key, then allows Back", async () => {
    mockDesktopWidth(false);
    const props = createProps({ connectModalStep: "openai", apiKeyPendingProvider: "openai" });
    await act(async () => root.render(<CredentialsConnectModal {...props} />));
    const back = document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
    expect(back.disabled).toBe(true);
    expect(nativeBackMock.enabled).toBe(true);
    await act(async () => {
      back.click();
      nativeBackMock.handler?.();
      document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(props.onBack).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => root.render(<CredentialsConnectModal {...props} apiKeyPendingProvider={null} />));
    await act(async () => nativeBackMock.handler?.());
    expect(props.onBack).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("presents the private Desktop Codex auth.json path as the preferred local connection", async () => {
    await act(async () => {
      root.render(<CredentialsConnectModal {...createProps({ connectModalStep: "codex" })} />);
    });

    expect(document.body.textContent).toContain("Codex on this computer");
    expect(document.body.textContent).toContain("Desktop found your local Codex login.");
    expect(document.body.textContent).toContain("~/.codex/auth.json");
    expect(document.body.textContent).not.toContain("/home/test");
    expect(document.body.textContent).toContain("Use local Codex login");
    expect(document.body.textContent).not.toContain("Connect via a one-time device login");
  });

  it("falls back to choosing auth.json when Desktop has no default Codex login", async () => {
    const onConnectCodex = vi.fn();
    const onTriggerUpload = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "codex",
            desktopCodexAuthJsonStatus: {
              exists: false,
            },
            onConnectCodex,
            onTriggerUpload,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("No default Codex login found.");
    expect(document.body.textContent).toContain("Desktop only checks ~/.codex/auth.json");
    expect(document.body.textContent).toContain("use browser login instead");
    expect(document.body.textContent).toContain("Choose auth.json");

    const chooseButton = document.querySelector<HTMLElement>(
      '[data-testid="credentials-connect-codex"]',
    );
    await act(async () => chooseButton?.click());
    expect(onTriggerUpload).toHaveBeenCalledTimes(1);
    expect(onConnectCodex).not.toHaveBeenCalled();
  });

  it("keeps the default Desktop importer while auth.json status is unknown", async () => {
    const onConnectCodex = vi.fn();
    const onTriggerUpload = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "codex",
            desktopCodexAuthJsonStatus: null,
            onConnectCodex,
            onTriggerUpload,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Use local Codex login");
    expect(document.body.textContent).toContain(
      "Desktop will import ~/.codex/auth.json when you continue.",
    );

    const connectButton = document.querySelector<HTMLElement>(
      '[data-testid="credentials-connect-codex"]',
    );
    await act(async () => connectButton?.click());
    expect(onConnectCodex).toHaveBeenCalledTimes(1);
    expect(onTriggerUpload).not.toHaveBeenCalled();
  });

  it("offers the guarded browser login as a Desktop fallback", async () => {
    const onBeginDeviceAuth = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "codex",
            onBeginDeviceAuth,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Use browser login instead");
    expect(document.body.textContent).not.toContain("Before you get a code");

    const toggle = document.querySelector<HTMLElement>(
      '[data-testid="credentials-connect-codex-browser-toggle"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-controls")).toBe(
      "credentials-chatgpt-device-prerequisite",
    );
    await act(async () => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Before you get a code");
    expect(document.body.textContent).toContain("Settings → Security");
    expect(document.getElementById("credentials-chatgpt-device-prerequisite")).toBeInstanceOf(
      HTMLElement,
    );
    const continueButton = document.querySelector<HTMLElement>(
      '[data-testid="credentials-connect-codex-browser"]',
    );
    await act(async () => continueButton?.click());
    expect(onBeginDeviceAuth).toHaveBeenCalledWith("codex");
  });

  it("describes ChatGPT device login honestly in the provider picker", async () => {
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("ChatGPT login");
    expect(document.body.textContent).toContain("Use your ChatGPT subscription with a one-time device code.");
    expect(document.body.textContent).not.toContain("Recommended for Codex");
  });

  it("offers OpenAI API keys separately from ChatGPT login", async () => {
    const onStepChange = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            onStepChange,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("ChatGPT login");
    expect(document.body.textContent).toContain("OpenAI API key");
    expect(document.body.textContent).toContain("Connect a key from the OpenAI API platform.");

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="credentials-connect-choice-openai"]')
        ?.click();
    });
    expect(onStepChange).toHaveBeenCalledWith("openai");
  });

  it("shows the ChatGPT security prerequisite before generating a device code", async () => {
    const onBeginDeviceAuth = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            connectModalStep: "codex",
            onBeginDeviceAuth,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Before you get a code");
    expect(document.body.textContent).toContain("Settings → Security");
    expect(document.body.textContent).toContain("workspace admin");
    expect(document.body.textContent).toContain("I’ve enabled it — get a code");

    const button = document.querySelector<HTMLElement>('[data-testid="credentials-connect-codex"]');
    await act(async () => button?.click());
    expect(onBeginDeviceAuth).toHaveBeenCalledWith("codex");
  });

  it("keeps advanced Codex options structured and accessible", async () => {
    const onShowAdvancedChange = vi.fn();
    const onLabelDraftChange = vi.fn();
    const onTriggerUpload = vi.fn();
    const props = createProps({
      canUseDesktopConnect: true,
      connectModalStep: "codex",
      onShowAdvancedChange,
      onLabelDraftChange,
      onTriggerUpload,
    });

    await act(async () => {
      root.render(<CredentialsConnectModal {...props} />);
    });

    const collapsedToggle = document.querySelector<HTMLElement>(
      '[data-testid="credentials-codex-advanced-toggle"]',
    );
    expect(collapsedToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(collapsedToggle?.getAttribute("aria-controls")).toBe(
      "credentials-codex-advanced-options",
    );
    expect(document.getElementById("credentials-codex-advanced-options")).toBeNull();

    await act(async () => collapsedToggle?.click());
    expect(onShowAdvancedChange).toHaveBeenCalledWith(true);

    await act(async () => {
      root.render(<CredentialsConnectModal {...props} showAdvanced />);
    });

    const expandedToggle = document.querySelector<HTMLElement>(
      '[data-testid="credentials-codex-advanced-toggle"]',
    );
    expect(expandedToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("credentials-codex-advanced-options")).toBeInstanceOf(
      HTMLElement,
    );

    const label = document.querySelector<HTMLLabelElement>(
      'label[for="credentials-codex-label"]',
    );
    const labelInput = document.querySelector<HTMLInputElement>(
      '[data-testid="credentials-codex-label-input"]',
    );
    expect(label?.textContent).toContain("Imported connection label (optional)");
    expect(label?.htmlFor).toBe(labelInput?.id);

    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeValueSetter?.call(labelInput, "Work");
      labelInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onLabelDraftChange).toHaveBeenCalledWith("Work");

    const chooseAuthJson = document.querySelector<HTMLElement>(
      '[data-testid="credentials-codex-auth-json-upload"]',
    );
    await act(async () => chooseAuthJson?.click());
    expect(onTriggerUpload).toHaveBeenCalledTimes(1);

    const fileInput = document.querySelector<HTMLInputElement>(
      '[data-testid="credentials-codex-auth-json-input"]',
    );
    expect(fileInput?.accept).toBe("application/json,.json");
  });

  it("guides phone users to Desktop instead of asking them to find auth.json", async () => {
    mockDesktopWidth(false);

    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            connectModalStep: "codex",
            showAdvanced: true,
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Continue on your computer");
    expect(document.body.textContent).toContain(
      "Download Instafy Desktop to connect Codex once, then use it on this phone.",
    );
    expect(document.body.textContent).not.toContain("auth.json");
    expect(document.body.textContent).toContain("Open Desktop setup");
    expect(
      document.querySelector('[data-testid="credentials-codex-desktop-install"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      document.querySelector('[data-testid="credentials-codex-auth-json-upload"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="credentials-codex-label-input"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="credentials-codex-auth-json-input"]'),
    ).toBeNull();
  });

  it("uses Android Back to navigate one wizard level before closing", async () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "codex",
            onBack,
            onClose,
          })}
        />,
      );
    });

    expect(nativeBackMock.enabled).toBe(true);
    act(() => nativeBackMock.handler?.());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "picker",
            onBack,
            onClose,
          })}
        />,
      );
    });
    act(() => nativeBackMock.handler?.());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a readable, expiring code and trusted OpenAI host", async () => {
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            connectModalStep: "codex",
            deviceAuthProvider: "codex",
            deviceAuthSession: {
              sessionId: "session-1",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-EFGH",
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              pollIntervalSeconds: 5,
              status: "pending",
            },
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("ABCD-EFGH");
    expect(document.body.textContent).toContain("Open auth.openai.com");
    expect(document.body.textContent).toContain("code expires in");
    expect(document.body.textContent).toContain("never ask you to paste your ChatGPT password");
  });

  it("labels post-login finalization without offering another device login", async () => {
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            connectModalStep: "codex",
            deviceAuthCompleting: true,
            deviceAuthProvider: "codex",
            deviceAuthSession: {
              sessionId: "session-finalizing",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-EFGH",
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              pollIntervalSeconds: 5,
              status: "pending",
            },
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Login complete — checking the connection…");
    expect(document.body.textContent).not.toContain("Waiting for login");
    expect(document.body.textContent).not.toContain("Try again");
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.disabled).toBe(true);
    const cancelButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Cancel",
    );
    expect(cancelButton?.disabled).toBe(true);
    const onBack = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            canUseDesktopConnect: false,
            connectModalStep: "codex",
            deviceAuthCompleting: true,
            deviceAuthProvider: "codex",
            deviceAuthSession: {
              sessionId: "session-finalizing",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-EFGH",
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              pollIntervalSeconds: 5,
              status: "pending",
            },
            onBack,
            onClose,
          })}
        />,
      );
    });
    act(() => nativeBackMock.handler?.());
    expect(onBack).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the API-key modal open when credential verification fails", async () => {
    const onClose = vi.fn();
    const onConnectApiKey = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "deepseek",
            deepseekApiKeyDraft: "invalid-key",
            onClose,
            onConnectApiKey,
          })}
        />,
      );
    });

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="credentials-deepseek-connect"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onConnectApiKey).toHaveBeenCalledWith("deepseek");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits the OpenAI API-key card through the shared verified-key flow", async () => {
    const onClose = vi.fn();
    const onConnectApiKey = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "openai",
            openaiApiKeyDraft: "valid-key",
            onClose,
            onConnectApiKey,
          })}
        />,
      );
    });

    expect(document.querySelector('[data-testid="credentials-openai-card"]')).toBeInstanceOf(
      HTMLElement,
    );
    expect(document.body.textContent).toContain("Get a key");
    const apiKeyInput = document.querySelector<HTMLInputElement>(
      '[data-testid="credentials-openai-api-key-input"]',
    );
    expect(apiKeyInput).toBeInstanceOf(HTMLInputElement);
    expect(apiKeyInput?.autocomplete).toBe("off");
    expect(apiKeyInput?.getAttribute("data-1p-ignore")).toBe("true");

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="credentials-openai-connect"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onConnectApiKey).toHaveBeenCalledWith("openai");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the API-key modal only after credential verification succeeds", async () => {
    const onClose = vi.fn();
    const onConnectApiKey = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <CredentialsConnectModal
          {...createProps({
            connectModalStep: "deepseek",
            deepseekApiKeyDraft: "valid-key",
            onClose,
            onConnectApiKey,
          })}
        />,
      );
    });

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="credentials-deepseek-connect"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onConnectApiKey).toHaveBeenCalledWith("deepseek");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
