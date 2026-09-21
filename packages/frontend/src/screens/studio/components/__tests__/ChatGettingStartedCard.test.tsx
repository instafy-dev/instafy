// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGettingStartedCard } from "../ChatGettingStartedCard";
import { CARD_TOOL_CONNECTORS } from "../connectors";
import type { GettingStartedManagedAiOffer } from "../gettingStartedAiChoices";

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

  it("names the Codex login the desktop found, ahead of the sign-in and key routes", async () => {
    // The modal behind Connect AI already offers "Use local Codex login" on
    // the desktop app; the card's line said nothing about it, so a person
    // with Codex on this computer read a sign-in they did not need.
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            managedAiOffer: null,
            aiViewState: "choice",
            personalAiConnectionState: "missing",
            desktopCodexLoginFound: true,
          })}
        />,
      );
    });

    const connectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-connect-own-ai"]',
    );
    expect(connectButton?.textContent).toContain("Connect AI");
    expect(connectButton?.textContent).toContain(
      "Use the Codex login on this computer, sign in with ChatGPT, or use a key from another AI provider.",
    );
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
    // Four unexplained product names plus "API keys" is not first-run copy.
    expect(connectButton?.textContent).toContain(
      "Sign in with ChatGPT, or use a key from another AI provider.",
    );
    expect(container.textContent).not.toContain("DeepSeek");
    // The forward reference names what the next step actually offers.
    expect(container.textContent).toContain(
      "Start free now, or connect an AI account you already pay for. Next: pick a tool, or just type.",
    );
    expect(container.textContent).not.toContain("Next: pick what to work on.");
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

  it("offers one row of live tools once the AI choice is settled", async () => {
    const onSelectMode = vi.fn();
    const onSelectConnector = vi.fn();
    const onBrowseConnectors = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({ onSelectMode, onSelectConnector, onBrowseConnectors })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="onboarding-use-managed-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-connect-own-ai"]')).toBeNull();
    expect(container.textContent).toContain("Start with a tool you already use");
    // The two action cards and their vocabulary are gone with them.
    expect(container.querySelector('[data-testid="onboarding-action-import-github-repo"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-action-start-from-scratch"]')).toBeNull();
    expect(container.textContent).not.toContain("Start from scratch");
    expect(container.textContent).not.toContain("What should your agent work on?");
    expect(container.textContent).not.toContain("Connect a tool");
    // The card shares the bubble scale: the card tier, not a private width.
    expect(
      container.querySelector('[data-testid="onboarding-getting-started"]')?.className,
    ).toContain("!max-w-[min(100%,38rem)]");

    // One heading, one row, one line: no second heading, no caption above the
    // chips, no hairline inside the step.
    expect(
      Array.from(container.querySelectorAll("h3")).map((heading) => heading.textContent),
    ).toEqual(["Start with a tool you already use"]);
    expect(container.querySelector('[data-testid="onboarding-connect-strip"]')).toBeNull();
    expect(container.querySelector("#onboarding-connect-label")).toBeNull();
    const strip = container.querySelector<HTMLElement>('[data-testid="connect-chip-strip"]');
    expect(strip).not.toBeNull();
    // The heading itself names the list for screen readers.
    expect(strip?.getAttribute("aria-labelledby")).toBe("onboarding-workspace-heading");
    expect(container.querySelector("#onboarding-workspace-heading")?.textContent).toBe(
      "Start with a tool you already use",
    );

    const chips = Array.from(
      strip!.querySelectorAll<HTMLButtonElement>('[data-testid^="connect-chip-"]'),
    ).filter(
      (element) =>
        element instanceof HTMLButtonElement && !element.dataset.testid?.endsWith("-connected"),
    );
    // Every featured tool that can be picked today, a named product first so
    // the first offer in an empty chat is not "Import a repo". Slack and
    // Discord are still "soon", so they are simply absent (the Connect sheet
    // names them with a Badge), and the paste link lives in the sheet.
    expect(chips.map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-notion",
      "connect-chip-github",
      "connect-chip-freefinance",
    ]);
    expect(chips.map((chip) => chip.dataset.testid)).toEqual(
      CARD_TOOL_CONNECTORS.map((entry) => `connect-chip-${entry.id}`),
    );
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
    }
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord"]')).toBeNull();
    expect(container.textContent).not.toContain("Soon");
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("coming soon");
    expect(container.querySelector('[data-testid="connect-chip-freefinance"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-other"]')).toBeNull();
    expect(container.textContent).not.toContain("Paste a skill link");
    const moreTools = strip?.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(moreTools?.textContent).toBe("More tools");
    // The chips come first, the link after them.
    expect(
      chips[0]!.compareDocumentPosition(moreTools!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The row sits directly under the heading, and the hint closes the card.
    const heading = container.querySelector<HTMLElement>("#onboarding-workspace-heading");
    expect(
      heading!.compareDocumentPosition(strip!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const hint = container.querySelector<HTMLElement>('[data-testid="onboarding-type-hint"]');
    expect(hint?.textContent).toBe("Or just type what you want below.");
    expect(strip!.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // No em-dash anywhere on the card.
    expect(container.textContent).not.toContain(EM_DASH);

    // The skill chip reports its connector (the host opens the confirm stage)
    // and nothing else.
    const notionChip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]');
    expect(notionChip?.getAttribute("aria-label")).toBe("Connect Notion");
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
    expect(onSelectMode).not.toHaveBeenCalled();
    expect(onBrowseConnectors).not.toHaveBeenCalled();

    // The GitHub chip opens the card's own import mode. It must never go
    // through the host's connector routing, which would call beginGithubImport
    // and set the flag that overrides every later show gate.
    const githubChip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-github"]');
    expect(githubChip?.getAttribute("aria-label")).toBe("Import from GitHub");
    await act(async () => {
      githubChip?.click();
    });
    expect(onSelectMode).toHaveBeenCalledTimes(1);
    expect(onSelectMode).toHaveBeenCalledWith("github");
    expect(onSelectConnector).toHaveBeenCalledTimes(1);

    // "More tools" opens the sheet's browse stage; it reports no connector.
    expect(moreTools?.disabled).toBe(false);
    await act(async () => {
      moreTools?.click();
    });
    expect(onBrowseConnectors).toHaveBeenCalledTimes(1);
    expect(onSelectConnector).toHaveBeenCalledTimes(1);
    expect(onSelectMode).toHaveBeenCalledTimes(1);
  });

  it("shows no chip for a soon skill even when its folder is installed, and marks the published one connected", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({ installedSkillNames: new Set(["slack", "notion", "github"]) })}
        />,
      );
    });

    // An installed folder does not make an unpublished pack selectable: the
    // skill gets no chip and no check.
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    // A published pack's installed folder shows the check and stays selectable.
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).not.toBeNull();
    const notionChip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]');
    expect(notionChip?.disabled).toBe(false);
    expect(notionChip?.getAttribute("aria-label")).toBe("Notion, connected");
    // GitHub installs nothing, so it never carries the glyph, whatever is in
    // .agents/skills.
    expect(container.querySelector('[data-testid="connect-chip-github-connected"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="connect-chip-github"]')?.getAttribute("aria-label"),
    ).toBe("Import from GitHub");
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
    expect(container.querySelector('[data-testid="connect-chip-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-type-hint"]')).toBeNull();
  });

  it("leaves a read-only member the repo import, the hint and nothing that sends", async () => {
    const onSelectMode = vi.fn();
    const onSelectConnector = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({ showConnectTools: false, onSelectMode, onSelectConnector })}
        />,
      );
    });

    // Read-only removes everything whose press ends in a line being sent into
    // the conversation: the skill chips and the browse sheet. The repo import
    // sends nothing, so a viewer keeps it, exactly as they do today.
    const chips = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid^="connect-chip-"]'),
    );
    expect(chips.map((chip) => chip.dataset.testid)).toEqual(["connect-chip-github"]);
    expect(container.querySelector('[data-testid="connect-chip-notion"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-more-tools"]')).toBeNull();
    expect(container.textContent).not.toContain("More tools");
    // No note explaining the absence: it would have to be written before
    // capabilities resolve, when it would be saying something untrue.
    expect(container.querySelector('[data-testid="onboarding-readonly-note"]')).toBeNull();
    expect(container.textContent).not.toContain("write access");
    // The hint is ungated: the member with the least to press is the one who
    // most needs the sentence telling them to type.
    expect(container.querySelector('[data-testid="onboarding-type-hint"]')?.textContent).toBe(
      "Or just type what you want below.",
    );
    expect(container.textContent).toContain("Start with a tool you already use");

    await act(async () => {
      chips[0]?.click();
    });
    expect(onSelectMode).toHaveBeenCalledWith("github");
    expect(onSelectConnector).not.toHaveBeenCalled();
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

  it("collapses to one row of the same tools while a draft exists", async () => {
    const onSelectMode = vi.fn();
    const onSelectConnector = vi.fn();
    const onBrowseConnectors = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard
          {...baseProps({
            collapsed: true,
            selectedAi: "connected",
            connectedAiLabel: "My OpenAI key",
            canChangeAiChoice: true,
            onSelectMode,
            onSelectConnector,
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
    // The same tools as the full row, in the same order, in text form. The
    // repo import keeps its verb, which is the one place a bare "GitHub"
    // would lose it; names carry the rest.
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Notion",
      "Import a repo",
      "More tools",
    ]);
    expect(row?.textContent).toBe("Notion·Import a repo·More tools");
    expect(buttons.map((button) => button.dataset.testid)).toEqual([
      "onboarding-collapsed-notion",
      "onboarding-collapsed-import-github-repo",
      "onboarding-collapsed-more-tools",
    ]);
    for (const button of buttons) {
      expect(button.className).toContain("pointer-coarse:min-h-11");
      expect(button.querySelector("svg")).toBeNull();
    }
    expect(container.textContent).not.toContain("Start from scratch");
    expect(container.textContent).not.toContain(EM_DASH);

    await act(async () => {
      buttons[0]?.click();
    });
    expect(onSelectConnector.mock.calls[0][0]).toMatchObject({ id: "notion", kind: "skill" });
    await act(async () => {
      buttons[1]?.click();
    });
    expect(onSelectMode).toHaveBeenCalledWith("github");
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
    expect(container.querySelector("h3")?.textContent).toBe("Start with a tool you already use");
    expect(container.querySelector('[data-testid="onboarding-ai-status"]')?.textContent).toBe(
      "Using My OpenAI key·Change AI",
    );
  });

  it("leaves the read-only collapsed row the repo import alone", async () => {
    await act(async () => {
      root.render(
        <ChatGettingStartedCard {...baseProps({ collapsed: true, showConnectTools: false })} />,
      );
    });

    const row = container.querySelector<HTMLElement>('[data-testid="onboarding-collapsed-row"]');
    expect(Array.from(row!.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
      "Import a repo",
    ]);
    expect(row?.textContent).toBe("Import a repo");
  });

  it("keeps the GitHub mode full even when collapsed is requested", async () => {
    await act(async () => {
      root.render(<ChatGettingStartedCard {...baseProps({ collapsed: true, mode: "github" })} />);
    });

    expect(container.querySelector('[data-testid="onboarding-collapsed-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-github-repo-input"]')).not.toBeNull();
  });

  it("sends nothing and prefills nothing from any control on the card", async () => {
    const onSelectConnector = vi.fn();
    const onSelectMode = vi.fn();
    const onBrowseConnectors = vi.fn();
    await act(async () => {
      root.render(
        <ChatGettingStartedCard {...baseProps({ onSelectConnector, onSelectMode, onBrowseConnectors })} />,
      );
    });

    // The blank path is the composer itself, not a control here: the card
    // points at it in one line and nothing on the card writes into it.
    for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>("button"))) {
      await act(async () => {
        button.click();
      });
    }
    expect(composer.value).toBe("");
    expect(document.activeElement).not.toBe(composer);
    // Every press is a report to the host, and the host opens a surface.
    expect(onSelectConnector.mock.calls.length + onSelectMode.mock.calls.length +
      onBrowseConnectors.mock.calls.length).toBeGreaterThan(0);
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
