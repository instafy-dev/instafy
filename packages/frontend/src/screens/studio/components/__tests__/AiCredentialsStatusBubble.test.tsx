// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCredentialsStatusBubble } from "../AiCredentialsStatusBubble";

const mocks = vi.hoisted(() => ({
  beginDeviceAuth: vi.fn(),
  cancelDeviceAuth: vi.fn(),
  deviceAuthCompleting: false,
  deviceAuthCompletionWarning: null as string | null,
  deviceAuthOnCompleted: null as null | ((input: {
    provider: "codex" | "gemini" | "github";
    sessionId: string;
    credentialId?: string | null;
  }) => unknown),
  deviceAuthSession: null as null | {
    sessionId: string;
    verificationUrl: string;
    userCode: string;
    expiresAt: string;
    pollIntervalSeconds: number;
    status: "pending" | "completed" | "failed" | "cancelled";
    error?: string | null;
  },
  hydrateDeviceAuth: vi.fn(),
  listCredentials: vi.fn(),
  nativeBackEnabled: false,
  nativeBackHandler: null as null | (() => void),
  resetDeviceAuth: vi.fn(),
  setDefaultCredential: vi.fn(),
  testCredential: vi.fn(),
}));

vi.mock("../../../../native/useNativeBackButtonAction", () => ({
  useNativeBackButtonAction: (enabled: boolean, onBack: () => void) => {
    mocks.nativeBackEnabled = enabled;
    mocks.nativeBackHandler = onBack;
  },
}));

vi.mock("../device-auth/useDeviceAuthFlow", () => ({
  useDeviceAuthFlow: (options?: { onCompleted?: typeof mocks.deviceAuthOnCompleted }) => {
    mocks.deviceAuthOnCompleted = options?.onCompleted ?? null;
    return {
      session: mocks.deviceAuthSession,
      error: null,
      busy: false,
      completing: mocks.deviceAuthCompleting,
      completionWarning: mocks.deviceAuthCompletionWarning,
      begin: mocks.beginDeviceAuth,
      cancel: mocks.cancelDeviceAuth,
      reset: mocks.resetDeviceAuth,
      hydrate: mocks.hydrateDeviceAuth,
    };
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    credentials: {
      list: mocks.listCredentials,
      setDefault: mocks.setDefaultCredential,
      test: mocks.testCredential,
    },
  },
}));

describe("AiCredentialsStatusBubble", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.deviceAuthCompleting = false;
    mocks.deviceAuthCompletionWarning = null;
    mocks.deviceAuthOnCompleted = null;
    mocks.deviceAuthSession = null;
    mocks.nativeBackEnabled = false;
    mocks.nativeBackHandler = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete window.instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it("renders the transient checking gate as a compact status bubble", async () => {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="checking"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="credentials-status-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.className).toContain("min-h-9");
    expect(indicator?.className).toContain("max-w-full");
    expect(indicator?.className).toContain("sm:max-w-[26rem]");
    expect(indicator?.className).toContain("px-3");
    expect(indicator?.className).toContain("py-2");
    expect(indicator?.querySelector(".animate-spin")).toBeInstanceOf(HTMLElement);
    expect(indicator?.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(indicator?.querySelector("[data-sweep-text]")?.textContent).toBe("Checking AI connection…");
    expect(indicator?.querySelector("button")).toBeNull();
  });

  it("renders controller-unavailable gate as a compact retry bubble", async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="unavailable"
          detail="Retry after the local stack is ready. Your AI credentials may still be fine."
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onRetry={onRetry}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="credentials-status-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.className).toContain("max-w-[min(85%,30rem)]");
    expect(indicator?.className).not.toContain("bg-[radial-gradient");
    expect(indicator?.textContent).toContain("I can't verify the AI connection right now.");
    expect(indicator?.textContent).toContain("Retry after the local stack is ready.");
    const retryButton = indicator?.querySelector("button");
    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    expect(retryButton?.className).not.toContain("w-full");
    await act(async () => {
      retryButton?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  const managedAiFixture = (overrides?: Partial<{ remainingPrompts: number | null }>) => ({
    enabled: true,
    available: true,
    label: "Instafy AI",
    creditBurnAmount: 1,
    dailyPromptLimit: 20,
    dailyPromptsUsed: 0,
    remainingPrompts: 20,
    ...overrides,
  });

  it("offers a one-click managed AI CTA in the connect wizard", async () => {
    const onUseManagedAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          connectedCredentials={[]}
          managedAi={managedAiFixture()}
          onUseManagedAi={onUseManagedAi}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const managedButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Use free Instafy AI"),
    );
    expect(managedButton).toBeInstanceOf(HTMLButtonElement);
    expect(managedButton?.textContent).toContain("Use free Instafy AI (20/day)");
    expect(managedButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      managedButton?.click();
    });
    expect(onUseManagedAi).toHaveBeenCalledTimes(1);
  });

  it("disables the managed AI CTA when the daily quota is exhausted", async () => {
    const onUseManagedAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          connectedCredentials={[]}
          managedAi={managedAiFixture({ remainingPrompts: 0 })}
          onUseManagedAi={onUseManagedAi}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const managedButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Use free Instafy AI"),
    );
    expect(managedButton).toBeInstanceOf(HTMLButtonElement);
    expect(managedButton?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      managedButton?.click();
    });
    expect(onUseManagedAi).not.toHaveBeenCalled();
  });

  it("hides the managed AI CTA once a provider credential is connected", async () => {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="needs_default"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          connectedCredentials={[
            {
              id: "cred-1",
              provider: "openai",
              label: "My OpenAI",
              createdAt: new Date(0).toISOString(),
            } as never,
          ]}
          managedAi={managedAiFixture()}
          onUseManagedAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const managedButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Use free Instafy AI"),
    );
    expect(managedButton).toBeUndefined();
    expect(container.textContent).toContain("Choose which AI connection to use.");
    expect(container.textContent).not.toContain("Add another AI connection?");
  });

  it("offers a p2p escape in the blocking gate and wires it to the disable path", async () => {
    const onChatWithoutAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          onChatWithoutAi={onChatWithoutAi}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const escape = container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-chat-without-ai"]');
    expect(escape).toBeInstanceOf(HTMLButtonElement);
    expect(escape?.textContent).toContain("Turn the assistant off");
    await act(async () => {
      escape?.click();
    });
    expect(onChatWithoutAi).toHaveBeenCalledTimes(1);
  });

  it("does not show the p2p escape in the proactive connect wizard", async () => {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onChatWithoutAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });
    expect(container.querySelector('[data-testid="ai-gate-chat-without-ai"]')).toBeNull();
  });

  it("shows the ChatGPT Security prerequisite before requesting a device code", async () => {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
    };

    await clickButton("OpenAI");
    await clickButton("ChatGPT login");
    await clickButton("Browser login (device code)");

    expect(mocks.beginDeviceAuth).not.toHaveBeenCalled();
    const prerequisite = container.querySelector('[data-testid="chat-ai-device-code-prerequisite"]');
    expect(prerequisite).toBeInstanceOf(HTMLElement);
    expect(prerequisite?.textContent).toContain("Before you get a code");
    expect(prerequisite?.textContent).toContain("Settings → Security");
    expect(prerequisite?.textContent).toContain("workspace admin");
    expect(prerequisite?.querySelector('[data-testid="chat-ai-device-code-help"]')).toBeInstanceOf(
      HTMLButtonElement,
    );

    await clickButton("I’ve enabled it — get a code");
    expect(mocks.beginDeviceAuth).toHaveBeenCalledWith({ provider: "codex" });
  });

  it("labels a completed login while the saved connection is being checked", async () => {
    const onClose = vi.fn();
    mocks.deviceAuthCompleting = true;
    mocks.deviceAuthSession = {
      sessionId: "session-finalizing",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
      status: "pending",
    };

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onClose={onClose}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => button?.click());
    };
    await clickButton("OpenAI");
    await clickButton("ChatGPT login");

    expect(container.textContent).toContain("Login complete — checking the connection…");
    expect(container.textContent).not.toContain("Waiting for you to finish login");
    expect(container.textContent).not.toContain("Try again");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Close AI connect"]')?.disabled).toBe(true);
    const cancelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Cancel login"),
    );
    expect(cancelButton?.disabled).toBe(true);
    expect(mocks.nativeBackEnabled).toBe(true);
    act(() => mocks.nativeBackHandler?.());
    expect(mocks.cancelDeviceAuth).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    mocks.deviceAuthCompleting = false;
    mocks.deviceAuthCompletionWarning =
      "ChatGPT is connected, but the test request couldn't be verified.";
    mocks.deviceAuthSession = {
      ...mocks.deviceAuthSession!,
      status: "completed",
    };
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onClose={onClose}
        />,
      );
    });
    expect(container.textContent).toContain("ChatGPT is connected");
    expect(container.textContent).not.toContain("Try again");
  });

  it("cancels a pending device login before Android Back leaves the wizard", async () => {
    const onClose = vi.fn();
    mocks.deviceAuthSession = {
      sessionId: "session-native-back",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
      status: "pending",
    };

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onClose={onClose}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => button?.click());
    };
    await clickButton("OpenAI");
    await clickButton("ChatGPT login");

    expect(mocks.nativeBackEnabled).toBe(true);
    await act(async () => mocks.nativeBackHandler?.());
    expect(mocks.cancelDeviceAuth).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the chat-without-AI escape disabled during device-login finalization", async () => {
    const onChatWithoutAi = vi.fn();
    mocks.deviceAuthCompleting = true;

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onChatWithoutAi={onChatWithoutAi}
        />,
      );
    });

    const escape = container.querySelector<HTMLButtonElement>(
      '[data-testid="ai-gate-chat-without-ai"]',
    );
    expect(escape?.disabled).toBe(true);
    await act(async () => escape?.click());
    expect(onChatWithoutAi).not.toHaveBeenCalled();
  });

  it("consumes Android Back in a finalizing device-login gate", async () => {
    mocks.deviceAuthCompleting = true;
    mocks.deviceAuthSession = {
      sessionId: "session-gate-finalizing",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 5,
      status: "pending",
    };

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => button?.click());
    };
    await clickButton("OpenAI");
    await clickButton("ChatGPT login");

    expect(mocks.nativeBackEnabled).toBe(true);
    act(() => mocks.nativeBackHandler?.());
    expect(mocks.cancelDeviceAuth).not.toHaveBeenCalled();
  });

  it("keeps a saved ChatGPT connection successful without replacing the default when its test cannot be verified", async () => {
    const onRetry = vi.fn();
    mocks.setDefaultCredential.mockResolvedValue({ success: true });
    mocks.testCredential.mockResolvedValue({ success: true, ok: false, output: "rate limited" });

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onRetry={onRetry}
        />,
      );
    });

    expect(mocks.deviceAuthOnCompleted).toBeTypeOf("function");
    const result = await mocks.deviceAuthOnCompleted?.({
      provider: "codex",
      sessionId: "session-warning",
      credentialId: "credential-warning",
    });

    expect(result).toMatchObject({
      success: true,
      warning: expect.stringContaining("ChatGPT is connected"),
    });
    expect(mocks.testCredential).toHaveBeenCalledWith("credential-warning");
    expect(mocks.setDefaultCredential).not.toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the local Codex login action in the chat onboarding flow on Desktop", async () => {
    window.instafyDesktop = {
      codexAuthJsonStatus: vi.fn().mockResolvedValue({
        exists: true,
      }),
      connectDefaultCodexAuthJson: vi.fn(),
    } as Partial<typeof window.instafyDesktop> as typeof window.instafyDesktop;

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          isBusy={false}
          canUseDesktopConnect
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const openAiChoice = container.querySelector("button");
    const indicator = container.querySelector('[data-testid="credentials-status-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.className).not.toContain("mx-auto");
    expect(indicator?.className).toContain("max-w-[min(100%,42rem)]");
    expect(indicator?.className).toContain("w-full");
    expect(openAiChoice?.textContent).toContain("OpenAI");

    await act(async () => {
      openAiChoice?.click();
    });

    const loginChoice = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("ChatGPT login"),
    );
    expect(loginChoice).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      loginChoice?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Use local Codex login");
    expect(container.textContent).toContain("Found ~/.codex/auth.json.");
    expect(container.textContent).not.toContain("/home/example");
    expect(container.textContent).toContain("Browser login (device code)");
  });

  it("keeps the default Desktop importer while auth.json status is unknown", async () => {
    const onStashDraft = vi.fn();
    const onConnectDesktop = vi.fn();
    const onUploadAuthJson = vi.fn();
    window.instafyDesktop = {
      connectDefaultCodexAuthJson: vi.fn(),
    } as Partial<typeof window.instafyDesktop> as typeof window.instafyDesktop;

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          isBusy={false}
          canUseDesktopConnect
          onStashDraft={onStashDraft}
          onConnectDesktop={onConnectDesktop}
          onUploadAuthJson={onUploadAuthJson}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => button?.click());
    };

    await clickButton("OpenAI");
    await clickButton("ChatGPT login");
    expect(container.textContent).toContain("Use local Codex login");
    expect(container.textContent).toContain("Desktop will use this computer's local Codex login.");

    await clickButton("Use local Codex login");
    expect(onStashDraft).toHaveBeenCalledTimes(1);
    expect(onConnectDesktop).toHaveBeenCalledTimes(1);
    expect(onUploadAuthJson).not.toHaveBeenCalled();
  });
});
