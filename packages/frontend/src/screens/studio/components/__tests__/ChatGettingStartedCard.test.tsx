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
    onSelectConnector: vi.fn(),
    onBrowseConnectors: vi.fn(),
    installedSkillNames: new Set<string>(),
    showConnectTools: true,
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
    const onSelectConnector = vi.fn();
    const onBrowseConnectors = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({ onSelectAction, onSelectConnector, onBrowseConnectors })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeNull();
    expect(container.textContent).toContain("What should your agent work on?");
    expect(container.textContent).not.toContain("hosted git repo");
    expect(container.textContent).not.toContain("desktop app");
    // The card shares the bubble scale: the card tier, not a private width.
    expect(
      container.querySelector('[data-testid="onboarding-getting-started"]')?.className,
    ).toContain("!max-w-[min(100%,38rem)]");

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

    // "Connect a tool" is a quiet block under a hairline after the workspace
    // grid: a muted caption and the chip strip, no second heading.
    const connectBlock = container.querySelector<HTMLElement>(
      '[data-testid="onboarding-connect-strip"]',
    );
    expect(connectBlock).not.toBeNull();
    expect(connectBlock?.textContent).toContain("Connect a tool");
    expect(container.textContent).not.toContain("Connect your tools");
    expect(
      Array.from(container.querySelectorAll("h3")).map((heading) => heading.textContent),
    ).toEqual(["What should your agent work on?"]);
    const strip = connectBlock?.querySelector('[data-testid="connect-chip-strip"]');
    expect(strip).not.toBeNull();
    // The visible caption names the list for screen readers.
    expect(strip?.getAttribute("aria-labelledby")).toBe("onboarding-connect-label");
    expect(connectBlock?.querySelector("#onboarding-connect-label")?.textContent).toBe(
      "Connect a tool",
    );
    const chips = Array.from(
      connectBlock!.querySelectorAll<HTMLButtonElement>('[data-testid^="connect-chip-"]'),
    ).filter(
      (element) =>
        element instanceof HTMLButtonElement && !element.dataset.testid?.endsWith("-connected"),
    );
    // Chips are exactly the featured skills; niche tools and GitHub live in
    // the sheet (GitHub already has its own button above), the paste link in
    // the sheet footer.
    expect(chips.map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-slack",
      "connect-chip-notion",
      "connect-chip-discord",
    ]);
    expect(container.querySelector('[data-testid="connect-chip-github"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-freefinance"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-other"]')).toBeNull();
    expect(container.textContent).not.toContain("Paste a skill link");
    const moreTools = connectBlock?.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(moreTools?.textContent).toBe("More tools");
    const workspaceGrid = importButton?.parentElement;
    expect(workspaceGrid).not.toBeNull();
    expect(
      workspaceGrid!.compareDocumentPosition(connectBlock!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The closing hint is the card's last line, after the strip.
    const hint = container.querySelector<HTMLElement>('[data-testid="onboarding-type-hint"]');
    expect(hint?.textContent).toBe("Or just type below.");
    expect(
      connectBlock!.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // No em-dash anywhere on the card.
    expect(container.textContent).not.toContain("—");

    // Every shipped chip is a soon skill (pack not published): disabled, with
    // the Soon Badge after the name and "coming soon" in its accessible name.
    for (const chip of chips) {
      expect(chip.disabled).toBe(true);
      expect(chip.getAttribute("aria-label")).toMatch(/, coming soon$/);
      expect(chip.querySelector(`[data-testid="${chip.dataset.testid}-soon"]`)?.textContent).toBe("Soon");
    }
    expect(container.querySelector('[data-testid="connect-chip-slack"]')?.textContent).toBe("SlackSoon");

    // A soon chip press reports nothing: no connector, no onboarding action.
    await act(async () => {
      chips[0]?.click();
    });
    expect(onSelectConnector).not.toHaveBeenCalled();
    expect(onSelectAction).toHaveBeenCalledTimes(2);

    expect(onBrowseConnectors).not.toHaveBeenCalled();

    // "More tools" opens the sheet's browse stage; it reports no connector.
    expect(moreTools?.disabled).toBe(false);
    await act(async () => {
      moreTools?.click();
    });
    expect(onBrowseConnectors).toHaveBeenCalledTimes(1);
    expect(onSelectConnector).not.toHaveBeenCalled();
    expect(onSelectAction).toHaveBeenCalledTimes(2);
  });

  it("keeps a soon chip soon when its skill folder is installed", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard {...baseProps({ installedSkillNames: new Set(["slack"]) })} />,
      );
    });

    // An installed folder does not make an unpublished pack selectable.
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-soon"]')?.textContent).toBe("Soon");
    expect(
      container.querySelector('[data-testid="connect-chip-slack"]')?.getAttribute("aria-label"),
    ).toBe("Slack, coming soon");
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).toBeNull();
  });

  it("keeps the GitHub mode free of em-dashes", async () => {
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ mode: "github" })} />);
    });

    expect(container.textContent).not.toContain("—");
    expect(
      container
        .querySelector<HTMLInputElement>('[data-testid="onboarding-github-ref-input"]')
        ?.getAttribute("placeholder"),
    ).toBe("ref (optional): main, a tag, or a commit SHA");
    expect(container.querySelector('[data-testid="onboarding-connect-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-type-hint"]')).toBeNull();
  });

  it("hides the chip strip and hint for read-only members while keeping the workspace tiles", async () => {
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ showConnectTools: false })} />);
    });

    expect(container.querySelector('[data-testid="onboarding-connect-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid^="connect-chip-"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-more-tools"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-type-hint"]')).toBeNull();
    expect(container.textContent).not.toContain("Connect a tool");
    expect(container.textContent).not.toContain("Or just type below.");
    expect(
      container.querySelector('[data-testid="onboarding-action-import-github-repo"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="onboarding-action-start-from-scratch"]'),
    ).not.toBeNull();
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
