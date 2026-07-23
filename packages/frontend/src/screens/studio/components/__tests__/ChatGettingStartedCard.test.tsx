// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGettingStartedCard } from "../ChatGettingStartedCard";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      deriveGithubImportTargetPath: (value: string) => `repos/${value.replaceAll("/", "-")}`,
    },
  },
}));

type GettingStartedCardProps = ComponentProps<typeof ChatGettingStartedCard>;

function baseProps(overrides: Partial<GettingStartedCardProps> = {}): GettingStartedCardProps {
  return {
    mode: "root" as const,
    onSelectMode: vi.fn(),
    onSelectAction: vi.fn(),
    managedAiOffer: null,
    selectedAi: null,
    aiViewState: "workspace",
    canChangeAiChoice: false,
    personalAiConnectionState: null,
    onStartWithManagedAi: vi.fn(),
    onConnectOwnAi: vi.fn(),
    onChangeAiChoice: vi.fn(),
    githubRepoDraft: "",
    githubRefDraft: "",
    githubImportBusy: false,
    githubImportElapsedSeconds: 0,
    githubImportError: null,
    githubDeviceAuthSession: null,
    githubDeviceAuthError: null,
    onGithubRepoDraftChange: vi.fn(),
    onGithubRefDraftChange: vi.fn(),
    onBeginGithubDeviceAuth: vi.fn(),
    onCancelGithubDeviceAuth: vi.fn(),
    onImportGithub: vi.fn(),
    ...overrides,
  };
}

describe("ChatGettingStartedCard", () => {
  let container: HTMLDivElement;
  let composer: HTMLTextAreaElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    composer = document.createElement("textarea");
    composer.id = "studio-chat-input";
    document.body.appendChild(composer);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    composer.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it("offers included and personal AI paths with the live allowance", async () => {
    const onStartWithManagedAi = vi.fn();
    const onConnectOwnAi = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: {
              label: "Instafy AI",
              dailyPromptLimit: 20,
              remainingPrompts: 7,
            },
            aiViewState: "choice",
            personalAiConnectionState: "missing",
            onStartWithManagedAi,
            onConnectOwnAi,
          })}
        />,
      );
    });

    const managedButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-use-managed-ai"]',
    );
    const connectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-connect-own-ai"]',
    );
    expect(managedButton?.textContent).toContain("Start free with Instafy AI");
    expect(managedButton?.textContent).toContain("7 of 20 free prompts left today");
    expect(container.textContent).not.toContain("~20 prompts");
    expect(connectButton?.textContent).toContain("Bring my own AI");
    expect(connectButton?.textContent).toContain("API keys for OpenAI");
    expect(container.querySelector('[data-testid="onboarding-path-coding"]')).toBeNull();
    // The workspace step is gated behind the AI choice — one decision at a time.
    expect(container.querySelector('[data-testid="onboarding-workspace-step"]')).toBeNull();

    await act(async () => {
      managedButton?.click();
    });
    expect(onStartWithManagedAi).toHaveBeenCalledTimes(1);
    expect(onConnectOwnAi).not.toHaveBeenCalled();

    await act(async () => {
      connectButton?.click();
    });
    expect(onConnectOwnAi).toHaveBeenCalledTimes(1);
  });

  it("asks what the agent should work on once the AI choice is settled", async () => {
    const onSelectAction = vi.fn();
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ onSelectAction })} />);
    });

    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeNull();
    expect(container.textContent).toContain("What should your agent work on?");
    expect(container.textContent).toContain("hosted workspace");

    const importButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-action-import-github-repo"]',
    );
    const scratchButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-action-start-from-scratch"]',
    );
    expect(importButton?.textContent).toContain("Import a GitHub repo");
    expect(scratchButton?.textContent).toContain("Start from scratch");

    await act(async () => {
      scratchButton?.click();
    });
    expect(onSelectAction).toHaveBeenCalledTimes(1);
    expect(onSelectAction.mock.calls[0][0]).toMatchObject({
      id: "start-from-scratch",
      kind: "prompt",
    });

    await act(async () => {
      importButton?.click();
    });
    expect(onSelectAction).toHaveBeenCalledTimes(2);
    expect(onSelectAction.mock.calls[1][0]).toMatchObject({
      id: "import-github-repo",
      kind: "github_import",
    });
  });

  it("keeps workspace actions hidden while the AI state is resolving", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            aiViewState: "resolving",
            managedAiOffer: {
              label: "Instafy AI",
              dailyPromptLimit: 20,
              remainingPrompts: 7,
            },
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-ai-resolving"]')).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(container.textContent).toContain("Checking your AI setup");
    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-workspace-step"]')).toBeNull();
  });

  it("focuses the workspace step instead of the composer after personal AI settles", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            aiViewState: "choice",
            personalAiConnectionState: "missing",
          })}
        />,
      );
    });
    composer.focus();
    expect(document.activeElement).toBe(composer);

    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            aiViewState: "workspace",
            selectedAi: "connected",
          })}
        />,
      );
    });

    const workspaceStep = container.querySelector<HTMLElement>(
      '[data-testid="onboarding-workspace-step"]',
    );
    expect(document.activeElement).toBe(workspaceStep);
    expect(document.activeElement).not.toBe(composer);
  });

  it("names a positively selected managed lane and restores focus when it is changed", async () => {
    const onChangeAiChoice = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: {
              label: "Instafy AI",
              dailyPromptLimit: 20,
              remainingPrompts: 7,
            },
            selectedAi: "managed",
            canChangeAiChoice: true,
            onChangeAiChoice,
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Using free Instafy AI");
    expect(container.textContent).not.toContain("Using your connected AI");
    const changeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-change-ai"]',
    );
    expect(changeButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      changeButton?.focus();
    });

    await act(async () => {
      changeButton?.click();
    });
    expect(onChangeAiChoice).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: {
              label: "Instafy AI",
              dailyPromptLimit: 20,
              remainingPrompts: 7,
            },
            aiViewState: "choice",
            personalAiConnectionState: "missing",
            onChangeAiChoice,
          })}
        />,
      );
    });

    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="onboarding-ai-choice"]'),
    );
  });

  it("restores focus to the workspace decision after GitHub Back", async () => {
    const onSelectMode = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            mode: "github",
            onSelectMode,
          })}
        />,
      );
    });

    const backButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-back-button"]',
    );
    await act(async () => {
      backButton?.focus();
    });
    await act(async () => {
      backButton?.click();
    });
    expect(onSelectMode).toHaveBeenCalledWith("root");

    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            mode: "root",
            onSelectMode,
          })}
        />,
      );
    });

    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="onboarding-workspace-step"]'),
    );
  });

  it("shows positive connected evidence without offering a no-op change action", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            selectedAi: "connected",
            canChangeAiChoice: false,
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Using your connected AI");
    expect(container.querySelector('[data-testid="onboarding-change-ai"]')).toBeNull();
  });

  it("keeps personal AI connection available when no included lane exists", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            aiViewState: "choice",
            personalAiConnectionState: "missing",
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(container.textContent).toContain("Connect the AI account you already use.");
  });

  it("guides an existing connection to choose its default", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            aiViewState: "choice",
            personalAiConnectionState: "needs_default",
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-choose-connected-ai"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(container.textContent).toContain("Select which saved connection Instafy should use.");
  });
});
