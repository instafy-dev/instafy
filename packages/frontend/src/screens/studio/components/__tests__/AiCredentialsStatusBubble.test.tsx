// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCredentialsStatusBubble } from "../AiCredentialsStatusBubble";
import { defaultAiConnectWizardState, writeAiConnectWizardState } from "../aiConnectWizardStorage";

const mocks = vi.hoisted(() => ({
  beginDeviceAuth: vi.fn(),
  cancelDeviceAuth: vi.fn(),
  deviceAuthCompleting: false,
  deviceAuthCompletionWarning: null as string | null,
  deviceAuthError: null as string | null,
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
      error: mocks.deviceAuthError,
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

// The bubble draws no provider list any more (the Add AI connection modal
// owns it), so the inline login steps are only reachable through a persisted
// wizard: seed one at the OpenAI method step the way a reload would.
const WIZARD_KEY = "test:ai-connect-wizard";
function seedOpenAiAuthStep() {
  writeAiConnectWizardState(WIZARD_KEY, {
    ...defaultAiConnectWizardState(),
    open: true,
    provider: "openai",
    step: "openai-auth",
    updatedAt: Date.now(),
  });
}

describe("AiCredentialsStatusBubble", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.deviceAuthCompleting = false;
    mocks.deviceAuthCompletionWarning = null;
    mocks.deviceAuthError = null;
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
      button.textContent?.includes("Use Instafy AI"),
    );
    expect(managedButton).toBeInstanceOf(HTMLButtonElement);
    expect(managedButton?.textContent).toBe("Use Instafy AI (20 a day)");
    // Instafy AI is paid for with credits: the gate, like the card, never calls it free.
    expect(container.textContent).not.toMatch(/\bfree\b/i);
    expect(managedButton?.hasAttribute("disabled")).toBe(false);
    // No provider list in the chat: the modal owns it.
    expect(container.textContent).not.toContain("Choose provider");
    expect(container.textContent).not.toContain("Subscription or API key");
    expect(container.querySelector('[data-testid="ai-gate-connect-ai"]')).toBeInstanceOf(HTMLButtonElement);

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
      button.textContent?.includes("Use Instafy AI"),
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
      button.textContent?.includes("Use Instafy AI"),
    );
    expect(managedButton).toBeUndefined();
    expect(container.textContent).toContain("Choose which AI connection to use.");
    expect(container.textContent).not.toContain("Add another AI connection?");
  });

  it("reduces the blocking gate to one sentence and one button that opens the modal", async () => {
    const onConnectAi = vi.fn();
    const onStashDraft = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          onConnectAi={onConnectAi}
          onStashDraft={onStashDraft}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const indicator = container.querySelector<HTMLElement>('[data-testid="credentials-status-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.textContent).toContain("Connect AI to send this. Your message is kept.");
    // Message-weight: the card tier, no decision gradient, no tracked label.
    expect(indicator?.className).toContain("!max-w-[min(100%,38rem)]");
    expect(indicator?.className).not.toContain("bg-[radial-gradient");
    expect(container.textContent).not.toContain("Choose provider");
    expect(container.querySelector(".tracking-\\[0\\.18em\\]")).toBeNull();
    // No provider grid: no OpenAI, DeepSeek, z.ai or Gemini tile, no icon frames.
    for (const provider of ["OpenAI", "DeepSeek", "z.ai", "Gemini"]) {
      expect(container.textContent).not.toContain(provider);
    }
    expect(container.querySelector(".h-9.w-9.rounded-full")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toContain("\u2014");
    expect(container.textContent).not.toContain("please");

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Connect AI"]);
    const connect = container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-connect-ai"]');
    expect(connect?.className).toContain("bg-primary");
    expect(connect?.className).toContain("pointer-coarse:min-h-11");
    // Alone in the space: no "turn the assistant off" caption.
    expect(container.querySelector('[data-testid="ai-gate-chat-without-ai"]')).toBeNull();
    expect(container.textContent).not.toContain("teammates");

    await act(async () => {
      connect?.click();
    });
    expect(onConnectAi).toHaveBeenCalledTimes(1);
    // The host stashes the draft; the bubble only reports the press.
    expect(onStashDraft).not.toHaveBeenCalled();
  });

  it("adds Instafy AI as a secondary action in the gate only while it is available", async () => {
    const onUseManagedAi = vi.fn();
    const render = async (managedAi: ReturnType<typeof managedAiFixture> | null) => {
      await act(async () => {
        root.render(
          <AiCredentialsStatusBubble
            state="missing"
            intent="gate"
            isBusy={false}
            canUseDesktopConnect={false}
            managedAi={managedAi}
            onUseManagedAi={onUseManagedAi}
            onConnectAi={() => undefined}
            onStashDraft={() => undefined}
            onConnectDesktop={() => undefined}
            onUploadAuthJson={() => undefined}
            onSaveApiKey={async () => ({ success: true })}
          />,
        );
      });
    };

    await render(managedAiFixture());
    const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Connect AI",
      "Use Instafy AI (20 a day)",
    ]);
    const managed = container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-use-managed-ai"]');
    expect(managed?.className).not.toContain("bg-primary");
    await act(async () => {
      managed?.click();
    });
    expect(onUseManagedAi).toHaveBeenCalledTimes(1);

    // Paused tier: the secondary action is gone, the sentence stays.
    await render({ ...managedAiFixture(), available: false });
    expect(buttons().map((button) => button.textContent)).toEqual(["Connect AI"]);
    expect(container.textContent).toContain("Connect AI to send this. Your message is kept.");

    // Exhausted for today: offered but disabled.
    await render(managedAiFixture({ remainingPrompts: 0 }));
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-use-managed-ai"]')?.disabled,
    ).toBe(true);

    await render(null);
    expect(buttons().map((button) => button.textContent)).toEqual(["Connect AI"]);
  });

  it("says when hosted AI is back once today's messages are used up", async () => {
    const onConnectAi = vi.fn();
    const onUseManagedAi = vi.fn();
    const render = async (managedAi: Parameters<typeof AiCredentialsStatusBubble>[0]["managedAi"]) => {
      await act(async () => {
        root.render(
          <AiCredentialsStatusBubble
            state="missing"
            intent="gate"
            isBusy={false}
            canUseDesktopConnect={false}
            managedAi={managedAi}
            onUseManagedAi={onUseManagedAi}
            onConnectAi={onConnectAi}
            onStashDraft={() => undefined}
            onConnectDesktop={() => undefined}
            onUploadAuthJson={() => undefined}
            onSaveApiKey={async () => ({ success: true })}
          />,
        );
      });
    };
    const buttons = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).map((button) => button.textContent);
    const usedUpLine = () => container.querySelector('[data-testid="ai-gate-managed-ai-used-up"]');
    const nextAvailableAt = new Date(Date.now() + 90 * 60_000).toISOString();
    // What the controller sends once the allowance is used up: still enabled,
    // no longer available, nothing left.
    const usedUp = {
      ...managedAiFixture({ remainingPrompts: 0 }),
      available: false,
      dailyPromptsUsed: 20,
      nextAvailableAt,
    };

    await render(usedUp);
    const indicator = container.querySelector<HTMLElement>('[data-testid="credentials-status-indicator"]');
    expect(indicator?.textContent).toContain(
      "You've used today's Instafy AI messages. Your message is kept.",
    );
    expect(indicator?.textContent).not.toContain("Connect AI to send this.");
    const time = new Date(nextAvailableAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(usedUpLine()?.textContent).toMatch(/^More are available (tomorrow )?at /);
    expect(usedUpLine()?.textContent).toContain(`at ${time}.`);
    expect(usedUpLine()?.textContent).toContain("Connect your own AI to send it now.");
    expect(container.textContent).not.toContain("\u2014");
    // One way forward: the person's own AI. No dead free-tier button.
    expect(buttons()).toEqual(["Connect your own AI"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-connect-ai"]')?.click();
    });
    expect(onConnectAi).toHaveBeenCalledTimes(1);
    expect(onUseManagedAi).not.toHaveBeenCalled();

    // An older controller sends no time.
    await render({ ...usedUp, nextAvailableAt: undefined });
    expect(usedUpLine()?.textContent).toBe(
      "More are available later. Connect your own AI to send it now.",
    );

    // Hosted AI is off on this controller: nothing was used up.
    await render({ ...usedUp, enabled: false });
    expect(container.textContent).toContain("Connect AI to send this. Your message is kept.");
    expect(usedUpLine()).toBeNull();
    expect(buttons()).toEqual(["Connect AI"]);

    // Paused with prompts left is not a used-up allowance either.
    await render({ ...managedAiFixture({ remainingPrompts: 7 }), available: false });
    expect(container.textContent).toContain("Connect AI to send this. Your message is kept.");
    expect(usedUpLine()).toBeNull();
  });

  it("offers the teammates caption below the actions only when the space has teammates", async () => {
    const onChatWithoutAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          hasTeammates
          onChatWithoutAi={onChatWithoutAi}
          onConnectAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const escape = container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-chat-without-ai"]');
    expect(escape).toBeInstanceOf(HTMLButtonElement);
    expect(escape?.textContent).toBe("Just chatting with teammates? Turn the assistant off.");
    // A quiet caption after the primary action, not a link above it.
    const connect = container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-connect-ai"]')!;
    expect(connect.compareDocumentPosition(escape!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(escape?.className).toContain("text-xs");
    expect(escape?.className).not.toContain("w-full");
    await act(async () => {
      escape?.click();
    });
    expect(onChatWithoutAi).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect={false}
          hasTeammates={false}
          onChatWithoutAi={onChatWithoutAi}
          onConnectAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });
    expect(container.querySelector('[data-testid="ai-gate-chat-without-ai"]')).toBeNull();
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

  it("hands the proactive connect prompt to the modal instead of listing providers", async () => {
    const onConnectAi = vi.fn();
    const onClose = vi.fn();
    const onChatWithoutAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          isBusy={false}
          canUseDesktopConnect={false}
          connectedCredentials={[]}
          managedAi={managedAiFixture()}
          hasTeammates
          onConnectAi={onConnectAi}
          onChatWithoutAi={onChatWithoutAi}
          onUseManagedAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
          onClose={onClose}
        />,
      );
    });

    expect(container.textContent).toContain("Start with Instafy AI or connect your own.");
    for (const provider of ["OpenAI", "DeepSeek", "z.ai", "Gemini", "Subscription or API key"]) {
      expect(container.textContent).not.toContain(provider);
    }
    const buttons = Array.from(container.querySelectorAll("button")).map(
      (button) => button.getAttribute("aria-label") ?? button.textContent,
    );
    expect(buttons).toEqual(["Close AI connect", "Connect AI", "Use Instafy AI (20 a day)"]);
    // The p2p escape belongs to the blocking gate only.
    expect(container.querySelector('[data-testid="ai-gate-chat-without-ai"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ai-gate-connect-ai"]')?.click();
    });
    expect(onConnectAi).toHaveBeenCalledTimes(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close AI connect"]')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers Connect AI for another connection and names the one in use", async () => {
    const onConnectAi = vi.fn();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
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
          defaultCredentialId="cred-1"
          managedAi={managedAiFixture()}
          onUseManagedAi={() => undefined}
          onConnectAi={onConnectAi}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    expect(container.textContent).toContain("Add another AI connection?");
    expect(container.textContent).toContain("Currently using: My OpenAI");
    expect(container.textContent).not.toContain("Use Instafy AI");
    expect(container.querySelector('[data-testid="ai-gate-connect-ai"]')).toBeInstanceOf(HTMLButtonElement);
  });

  it("keeps a restored login step inline and returns to the hand-off on Back", async () => {
    seedOpenAiAuthStep();
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          storageKey={WIZARD_KEY}
          isBusy={false}
          canUseDesktopConnect={false}
          onConnectAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    expect(container.textContent).toContain("ChatGPT login");
    expect(container.querySelector('[data-testid="ai-gate-connect-ai"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
    });
    expect(container.textContent).not.toContain("ChatGPT login");
    expect(container.querySelector('[data-testid="ai-gate-connect-ai"]')).toBeInstanceOf(HTMLButtonElement);
  });

  it("shows the ChatGPT Security prerequisite before requesting a device code", async () => {
    seedOpenAiAuthStep();
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

    await clickButton("I’ve enabled it \u2014 get a code");
    expect(mocks.beginDeviceAuth).toHaveBeenCalledWith({ provider: "codex" });
  });

  it("offers no code when ChatGPT device-code login is off", async () => {
    seedOpenAiAuthStep();
    const onStashDraft = vi.fn();
    const onConnectDesktop = vi.fn();
    window.instafyDesktop = {
      codexAuthJsonStatus: vi.fn().mockResolvedValue({ exists: true }),
      connectDefaultCodexAuthJson: vi.fn(),
    } as Partial<typeof window.instafyDesktop> as typeof window.instafyDesktop;
    // The controller's answer to OpenAI's 403 while polling.
    const refusal =
      "ChatGPT device-code login is not enabled. Enable it in ChatGPT Settings → Security, or ask your workspace admin to allow it in workspace permissions, then generate a new code.";
    mocks.deviceAuthError = refusal;
    mocks.deviceAuthSession = {
      sessionId: "session-refused",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      pollIntervalSeconds: 5,
      status: "failed",
      error: refusal,
    };

    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="connect"
          storageKey={WIZARD_KEY}
          isBusy={false}
          canUseDesktopConnect
          onStashDraft={onStashDraft}
          onConnectDesktop={onConnectDesktop}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });
    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
    };
    await clickButton("ChatGPT login (Plus/Team)");

    const notice = container.querySelector('[data-testid="chat-ai-device-code-disabled"]');
    expect(notice).toBeInstanceOf(HTMLElement);
    expect(notice?.querySelector('[role="alert"]')?.textContent).toContain(
      "turn on device-code authorization",
    );
    expect(notice?.textContent).toContain("Settings, then Security");
    // The refused session's code, its copy button and the login page are gone,
    // and the raw refusal is not repeated above the card.
    expect(container.textContent).not.toContain("ABCD-EFGH");
    for (const label of ["Copy code", "Open login", "Copy link", "Cancel login"]) {
      expect(container.textContent).not.toContain(label);
    }
    expect(container.textContent).not.toContain("generate a new code");
    expect(container.textContent).not.toContain("\u2014");

    // The local Codex login stays on offer beside it.
    await clickButton("Use local Codex login");
    expect(onConnectDesktop).toHaveBeenCalledTimes(1);

    mocks.resetDeviceAuth.mockClear();
    await clickButton("Back");
    expect(mocks.resetDeviceAuth).toHaveBeenCalledTimes(1);
    expect(mocks.beginDeviceAuth).not.toHaveBeenCalled();

    await clickButton("Try again");
    expect(mocks.beginDeviceAuth).toHaveBeenCalledWith({ provider: "codex" });
  });

  it("labels a completed login while the saved connection is being checked", async () => {
    seedOpenAiAuthStep();
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
          storageKey={WIZARD_KEY}
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
    await clickButton("ChatGPT login");

    expect(container.textContent).toContain("Login complete. Checking the connection…");
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
          storageKey={WIZARD_KEY}
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
    seedOpenAiAuthStep();
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
          storageKey={WIZARD_KEY}
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
          hasTeammates
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

  it("hosts no inline login steps in the gate, so Android Back is left alone", async () => {
    await act(async () => {
      root.render(
        <AiCredentialsStatusBubble
          state="missing"
          intent="gate"
          isBusy={false}
          canUseDesktopConnect
          onConnectAi={() => undefined}
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    expect(container.textContent).not.toContain("ChatGPT login");
    expect(container.textContent).not.toContain("Use local Codex login");
    expect(container.querySelector('button[aria-label="Back"]')).toBeNull();
    expect(mocks.nativeBackEnabled).toBe(false);
    expect(mocks.hydrateDeviceAuth).not.toHaveBeenCalled();
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
    seedOpenAiAuthStep();
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
          intent="connect"
          storageKey={WIZARD_KEY}
          isBusy={false}
          canUseDesktopConnect
          onStashDraft={() => undefined}
          onConnectDesktop={() => undefined}
          onUploadAuthJson={() => undefined}
          onSaveApiKey={async () => ({ success: true })}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="credentials-status-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.className).not.toContain("mx-auto");
    expect(indicator?.className).toContain("max-w-[min(100%,42rem)]");
    expect(indicator?.className).toContain("w-full");

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
    seedOpenAiAuthStep();
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
          intent="connect"
          storageKey={WIZARD_KEY}
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

    await clickButton("ChatGPT login");
    expect(container.textContent).toContain("Use local Codex login");
    expect(container.textContent).toContain("Desktop will use this computer's local Codex login.");

    await clickButton("Use local Codex login");
    expect(onStashDraft).toHaveBeenCalledTimes(1);
    expect(onConnectDesktop).toHaveBeenCalledTimes(1);
    expect(onUploadAuthJson).not.toHaveBeenCalled();
  });
});
