// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGettingStartedCard } from "../ChatGettingStartedCard";
import type { GettingStartedManagedAiOffer } from "../gettingStartedAiChoices";
import { START_FROM_SCRATCH_PLACEHOLDER } from "../onboardingPlaybook";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      deriveGithubImportTargetPath: (value: string) => `repos/${value.replaceAll("/", "-")}`,
    },
  },
}));

type GettingStartedCardProps = ComponentProps<typeof ChatGettingStartedCard>;

const EM_DASH = "\u2014";

const managedAiOfferFixture = (overrides: Partial<GettingStartedManagedAiOffer> = {}): GettingStartedManagedAiOffer => ({
  label: "Instafy AI",
  dailyPromptLimit: 20,
  remainingPrompts: 7,
  creditBurnAmount: 1,
  paused: false,
  ...overrides,
});

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
    connectedAiLabel: null,
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
            managedAiOffer: managedAiOfferFixture(),
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
    // One verb for the act, on the card as in the gate, the modal and the panel.
    expect(connectButton?.textContent).toContain("Connect AI");
    expect(container.textContent).not.toContain("Bring my own AI");
    expect(container.textContent).not.toContain("Bring your own AI");
    expect(connectButton?.textContent).toContain("API keys for OpenAI");
    expect(container.textContent).toContain("Start free now, or connect your own AI for the best results.");
    expect(container.textContent).not.toContain(EM_DASH);
    expect(container.querySelector('[data-testid="onboarding-path-coding"]')).toBeNull();
    // The workspace step is gated behind the AI choice: one decision at a time.
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
      kind: "compose",
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
    // Only featured skills whose pack is published get a chip: Notion today.
    // Slack and Discord are still "soon", so they are simply absent here (the
    // Connect sheet names them with a Badge); no coming-soon line while at
    // least one chip can be pressed. Niche tools and GitHub live in the sheet
    // (GitHub already has its own button above), the paste link in the sheet
    // footer.
    expect(chips.map((chip) => chip.dataset.testid)).toEqual(["connect-chip-notion"]);
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord"]')).toBeNull();
    expect(container.querySelector('[data-testid^="connect-chip-"][data-testid$="-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("Soon");
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("coming soon");
    expect(container.querySelector('[data-testid="connect-chip-github"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-freefinance"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-other"]')).toBeNull();
    expect(container.textContent).not.toContain("Paste a skill link");
    const moreTools = connectBlock?.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(moreTools?.textContent).toBe("More tools");
    // The chips come first, the link after them.
    expect(
      chips[0]!.compareDocumentPosition(moreTools!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    expect(container.textContent).not.toContain(EM_DASH);

    // The published chip is enabled, name only, the verb in its accessible
    // name; it reports its connector (the host opens the confirm stage) and
    // no onboarding action, no browse.
    const notionChip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]');
    expect(notionChip?.disabled).toBe(false);
    expect(notionChip?.getAttribute("aria-label")).toBe("Connect Notion");
    expect(notionChip?.querySelector('[data-testid="connect-chip-notion-soon"]')).toBeNull();
    expect(notionChip?.textContent).toBe("Notion");
    await act(async () => {
      notionChip?.click();
    });
    expect(onSelectConnector).toHaveBeenCalledTimes(1);
    expect(onSelectConnector.mock.calls[0][0]).toMatchObject({
      id: "notion",
      kind: "skill",
      availability: "available",
      skillName: "notion",
    });
    expect(onSelectAction).toHaveBeenCalledTimes(2);

    expect(onBrowseConnectors).not.toHaveBeenCalled();

    // "More tools" opens the sheet's browse stage; it reports no connector.
    expect(moreTools?.disabled).toBe(false);
    await act(async () => {
      moreTools?.click();
    });
    expect(onBrowseConnectors).toHaveBeenCalledTimes(1);
    expect(onSelectConnector).toHaveBeenCalledTimes(1);
    expect(onSelectAction).toHaveBeenCalledTimes(2);
  });

  it("shows no chip for a soon skill even when its folder is installed, and marks the published one connected", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({ installedSkillNames: new Set(["slack", "notion"]) })}
        />,
      );
    });

    // An installed folder does not make an unpublished pack selectable: the
    // skill gets no chip and no check.
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-soon"]')).toBeNull();
    // A published pack's installed folder shows the check and stays selectable.
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-notion-soon"]')).toBeNull();
    const notionChip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]');
    expect(notionChip?.disabled).toBe(false);
    expect(notionChip?.getAttribute("aria-label")).toBe("Notion, connected");
    // With a published chip on the card there is no coming-soon line.
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
  });

  it("keeps the GitHub mode free of em-dashes", async () => {
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ mode: "github" })} />);
    });

    expect(container.textContent).not.toContain(EM_DASH);
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
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
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
            managedAiOffer: managedAiOfferFixture(),
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
            managedAiOffer: managedAiOfferFixture(),
            selectedAi: "managed",
            canChangeAiChoice: true,
            onChangeAiChoice,
          })}
        />,
      );
    });

    // The free lane states its allowance at the point of decision, then the
    // switch, joined by a middle dot (never an em-dash).
    const status = container.querySelector<HTMLElement>('[data-testid="onboarding-ai-status"]');
    expect(status?.textContent).toBe("Using free Instafy AI: 20 prompts a day, 1 credit each·Change AI");
    expect(container.textContent).not.toContain("Using your connected AI");
    expect(container.textContent).not.toContain(EM_DASH);
    const changeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-change-ai"]',
    );
    expect(changeButton).toBeInstanceOf(HTMLButtonElement);
    expect(changeButton?.textContent).toBe("Change AI");
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
            managedAiOffer: managedAiOfferFixture(),
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

  it("names the saved connection in use and offers Change AI for it", async () => {
    const onChangeAiChoice = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            selectedAi: "connected",
            connectedAiLabel: "Local Codex login (dev)",
            canChangeAiChoice: true,
            onChangeAiChoice,
          })}
        />,
      );
    });

    const status = container.querySelector<HTMLElement>('[data-testid="onboarding-ai-status"]');
    expect(status?.textContent).toBe("Using Local Codex login (dev)·Change AI");
    expect(container.textContent).not.toContain("Using your connected AI");
    expect(container.textContent).not.toContain(EM_DASH);
    const changeButton = container.querySelector<HTMLButtonElement>('[data-testid="onboarding-change-ai"]');
    expect(changeButton?.textContent).toBe("Change AI");
    await act(async () => {
      changeButton?.click();
    });
    expect(onChangeAiChoice).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic connected line until the label is hydrated", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            selectedAi: "connected",
            connectedAiLabel: null,
            canChangeAiChoice: true,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-ai-status"]')?.textContent).toBe(
      "Using your connected AI·Change AI",
    );
  });

  it("shows no change action while the choice cannot be changed", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            selectedAi: "connected",
            connectedAiLabel: "My OpenAI key",
            canChangeAiChoice: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-ai-status"]')?.textContent).toBe(
      "Using My OpenAI key",
    );
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
    const connectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-connect-own-ai"]',
    );
    expect(connectButton).toBeInstanceOf(HTMLButtonElement);
    expect(connectButton?.textContent).toContain("Connect AI");
    expect(container.querySelector("h3")?.textContent).toBe("Connect AI");
    expect(container.textContent).toContain("Connect the AI account you already use.");
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("keeps the AI step a choice while the free tier is paused", async () => {
    const onConnectOwnAi = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: managedAiOfferFixture({ paused: true }),
            aiViewState: "choice",
            personalAiConnectionState: "missing",
            onConnectOwnAi,
          })}
        />,
      );
    });

    // Heading and line explain the free tier and the cost of the other route;
    // there is one primary button, and it carries the one verb.
    expect(container.querySelector("h3")?.textContent).toBe("Choose your AI");
    expect(container.querySelector('[data-testid="onboarding-ai-choice-line"]')?.textContent).toBe(
      "Free Instafy AI is paused right now. Connect your own AI to start; you pay your provider directly and Instafy adds nothing.",
    );
    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.textContent).not.toContain("Start free");
    expect(container.textContent).not.toContain("free prompts");
    const connectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-connect-own-ai"]',
    );
    expect(connectButton?.textContent).toContain("Connect AI");
    expect(connectButton?.className).toContain("bg-primary");
    expect(connectButton?.parentElement?.className).not.toContain("grid-cols-2");
    expect(container.querySelectorAll('[data-testid="onboarding-ai-choice"] button')).toHaveLength(1);
    expect(container.textContent).not.toContain(EM_DASH);
    expect(container.textContent).not.toContain("please");

    await act(async () => {
      connectButton?.click();
    });
    expect(onConnectOwnAi).toHaveBeenCalledTimes(1);
  });

  it("explains an exhausted allowance with the same verb", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: managedAiOfferFixture({ remainingPrompts: 0 }),
            aiViewState: "choice",
            personalAiConnectionState: "missing",
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-ai-choice-line"]')?.textContent).toBe(
      "Today's free prompts are used. Connect your own AI to keep going, or come back tomorrow.",
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="onboarding-use-managed-ai"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="onboarding-connect-own-ai"]')?.textContent,
    ).toContain("Connect AI");
  });

  it("collapses to one row of the workspace actions while a draft exists", async () => {
    const onSelectAction = vi.fn();
    const onBrowseConnectors = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            collapsed: true,
            selectedAi: "connected",
            connectedAiLabel: "My OpenAI key",
            canChangeAiChoice: true,
            onSelectAction,
            onBrowseConnectors,
          })}
        />,
      );
    });

    const card = container.querySelector<HTMLElement>('[data-testid="onboarding-getting-started"]');
    expect(card?.dataset.collapsed).toBe("true");
    // No heading, no AI line, no chips, no hint: three ghost buttons only.
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-ai-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-workspace-step"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-type-hint"]')).toBeNull();
    const row = container.querySelector<HTMLElement>('[data-testid="onboarding-collapsed-row"]');
    expect(row?.tagName).toBe("UL");
    const buttons = Array.from(row!.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Import a repo",
      "Start from scratch",
      "More tools",
    ]);
    expect(row?.textContent).toBe("Import a repo·Start from scratch·More tools");
    for (const button of buttons) {
      expect(button.className).toContain("pointer-coarse:min-h-11");
      expect(button.querySelector("svg")).toBeNull();
    }
    expect(container.textContent).not.toContain(EM_DASH);

    await act(async () => {
      buttons[0]?.click();
    });
    expect(onSelectAction.mock.calls[0][0]).toMatchObject({ id: "import-github-repo", kind: "github_import" });
    await act(async () => {
      buttons[1]?.click();
    });
    expect(onSelectAction.mock.calls[1][0]).toMatchObject({ id: "start-from-scratch", kind: "compose" });
    await act(async () => {
      buttons[2]?.click();
    });
    expect(onBrowseConnectors).toHaveBeenCalledTimes(1);

    // The full card returns when the draft is cleared.
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            collapsed: false,
            selectedAi: "connected",
            connectedAiLabel: "My OpenAI key",
            canChangeAiChoice: true,
          })}
        />,
      );
    });
    expect(container.querySelector('[data-testid="onboarding-collapsed-row"]')).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("What should your agent work on?");
    expect(container.querySelector('[data-testid="onboarding-ai-status"]')?.textContent).toBe(
      "Using My OpenAI key·Change AI",
    );
  });

  it("drops More tools from the collapsed row for read-only members", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard {...baseProps({ collapsed: true, showConnectTools: false })} />,
      );
    });

    const row = container.querySelector<HTMLElement>('[data-testid="onboarding-collapsed-row"]');
    expect(Array.from(row!.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
      "Import a repo",
      "Start from scratch",
    ]);
  });

  it("keeps the GitHub mode full even when collapsed is requested", async () => {
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ collapsed: true, mode: "github" })} />);
    });

    expect(container.querySelector('[data-testid="onboarding-collapsed-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-github-repo-input"]')).not.toBeNull();
  });

  it("reports Start from scratch as a compose action carrying the placeholder question, never a template", async () => {
    const onSelectAction = vi.fn();
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ onSelectAction })} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="onboarding-action-start-from-scratch"]')
        ?.click();
    });
    const action = onSelectAction.mock.calls[0][0];
    expect(action).toMatchObject({
      id: "start-from-scratch",
      kind: "compose",
      placeholder: START_FROM_SCRATCH_PLACEHOLDER,
    });
    expect(action.prompt).toBeUndefined();
    expect(START_FROM_SCRATCH_PLACEHOLDER).toBe("What do you want to build? One sentence is enough.");
    expect(START_FROM_SCRATCH_PLACEHOLDER).not.toContain("describe it here");
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
