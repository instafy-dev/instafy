// @vitest-environment jsdom

import { forwardRef, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposerSurface } from "../ChatComposerSurface";
import { CHAT_COMPOSER_COLUMN_CLASS_NAME } from "../ChatColumn";

vi.mock("../ChatBrowserDock", () => ({
  ChatBrowserDock: () => null,
}));

vi.mock("../ChatSendQueueSurface", () => ({
  ChatSendQueueSurface: () => null,
}));

vi.mock("../ComposerActionMenu", () => ({
  ComposerActionMenu: () => <div data-testid="mock-composer-action-menu" />,
}));

vi.mock("../ComposerInviteModal", () => ({
  ComposerInviteModal: () => null,
}));

vi.mock("../OctoAgentChip", () => ({
  OctoAgentChip: () => <div data-testid="mock-octo-chip" />,
}));

vi.mock("../ConversationRoster", () => ({
  ConversationRoster: () => <div data-testid="mock-conversation-roster" />,
}));

vi.mock("../VoiceConversationActionStrip", () => ({
  VoiceConversationActionStrip: () => <div data-testid="mock-voice-action-strip" />,
}));

vi.mock("../../../extensions/ProviderTriggerNotice", () => ({
  ProviderTriggerNotice: () => <div data-testid="mock-provider-trigger-notice" />,
}));

vi.mock("../chat-input/ChatInput", () => ({
  ChatInput: forwardRef(function MockChatInput(_props: Record<string, unknown>, _ref) {
    void _ref;
    return (
      <div
        data-compact={String(_props.compact === true)}
        data-read-only={String(_props.readOnly === true)}
        data-testid="chat-input"
      >
        Ask for something…
      </div>
    );
  }),
}));

function createProps(
  overrides: Partial<ComponentProps<typeof ChatComposerSurface>> = {},
): ComponentProps<typeof ChatComposerSurface> {
  return {
    browserDockProps: {} as never,
    composerOverlayRef: { current: null },
    composerAutoHidden: false,
    compactBrowserViewport: false,
    onSubmit: (event) => event.preventDefault(),
    queueSurfaceProps: {
      editingQueuedItem: null,
      totalQueuedCount: 0,
    } as never,
    activeGoal: null,
    activeGoalHealth: null,
    onPauseGoal: () => undefined,
    onResumeGoal: () => undefined,
    onClearGoal: () => undefined,
    onHelpUnblockGoal: () => undefined,
    goalDetailsCollapseToken: 0,
    nativeKeyboardOpen: false,
    onboardingInputLocked: false,
    onDragOver: () => undefined,
    onDrop: () => undefined,
    chatInputRef: { current: null },
    chatInputProps: {
      value: "",
      editorState: null,
      placeholder: "Ask for something…",
      agentHandles: [],
      onChange: () => undefined,
      onKeyDown: () => undefined,
    } as never,
    imageInputRef: { current: null },
    onImageInputChange: () => undefined,
    imageAttachments: [],
    onOpenImage: () => undefined,
    onRemoveImageAttachment: () => undefined,
    showVoiceStatus: false,
    voiceStatusMessage: "",
    providerTriggerNoticeProps: null,
    showComposerHomeButton: false,
    onOpenHome: () => undefined,
    homeAttentionCount: 0,
    homeAttentionBadge: "",
    octoAgentChipProps: {} as never,
    composerActionMenuProps: {} as never,
    onOpenImagePicker: () => undefined,
    sendingAttachment: false,
    showMobileGhostSuggestionAcceptButton: false,
    onAcceptGhostSuggestion: () => undefined,
    showVoicePrimaryAction: true,
    voiceConversationActionStripProps: {} as never,
    sendButtonDisabled: false,
    sendButtonVariant: "primary",
    onSendButtonPointerDown: () => undefined,
    onSendButtonPointerUp: () => undefined,
    onSendButtonPointerCancel: () => undefined,
    onSendButtonPressStart: () => undefined,
    onSendButtonPressEnd: () => undefined,
    onSendButtonPress: () => undefined,
    composerOutlinedActionClass: "outline",
    composerPrimaryActionClass: "primary",
    composerActionIconClass: "icon",
    composerActionButtonClass: "action",
    inviteModalProps: {} as never,
    ...overrides,
  };
}

function createBlockedGoalProps(): Partial<ComponentProps<typeof ChatComposerSurface>> {
  return {
    activeGoal: {
      id: "goal-1",
      objective: "count to 3",
      status: "blocked",
      doneWhen: null,
      stopWhen: null,
      progressSummary: "Run failed before the goal completed.",
      parentGoalId: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:01.000Z",
      createdBy: "user-1",
      updatedBy: "user-1",
    },
    activeGoalHealth: {
      turnCount: 1,
      maxTurns: 100,
      label: "Blocked",
      detail: "Run failed before the goal completed.",
      tone: "blocked",
      progressRatio: 0.01,
      stagnation: {
        level: "none",
        reason: "none",
        summary: null,
      },
    },
  };
}

describe("ChatComposerSurface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("condenses the idle composer in Browser mode and expands it when a draft appears", async () => {
    const renderSurface = (value: string) =>
      root.render(
        <ChatComposerSurface
          {...createProps({
            browserModeActive: true,
            chatInputProps: {
              ...createProps().chatInputProps,
              value,
            },
          })}
        />,
      );

    await act(async () => renderSurface(""));
    expect(container.querySelector('[data-browser-composer-condensed="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute("data-compact")).toBe(
      "true",
    );
    const inputNode = container.querySelector('[data-testid="chat-input"]');

    await act(async () => renderSurface("Tell Octo what to do on this page"));
    expect(container.querySelector('[data-browser-composer-condensed="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute("data-compact")).toBe(
      "false",
    );
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(inputNode);
  });

  it("keeps the idle composer controls visible when voice capture is unavailable", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            showVoicePrimaryAction: true,
            showVoiceStatus: false,
          })}
        />,
      );
    });

    expect(container.textContent).not.toContain("Capture not ready");
    expect(container.textContent).not.toContain("Voice capture is not ready yet on this client.");
    expect(container.querySelector('[data-testid="mock-voice-action-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-voice-active-strip"]')).toBeNull();
  });

  it("shows and enforces the read-only composer state", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            mutationDisabled: true,
            accessNotice: "Read-only access — ask an admin for edit access.",
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="project-read-only-notice"]')?.textContent).toContain(
      "Read-only access",
    );
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute("data-read-only")).toBe(
      "true",
    );
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-send-button"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-image-upload-button"]')?.disabled).toBe(true);
  });

  it("renders the access check as a quiet pending notice, not the read-only warning", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            accessChecking: true,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const checking = container.querySelector('[data-testid="project-access-checking-notice"]');
    expect(checking?.textContent).toContain("Checking your access");
    expect(container.querySelector('[data-testid="project-read-only-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute("data-read-only")).toBe(
      "true",
    );
  });

  it("replaces the idle controls with an integrated active voice strip", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            showVoiceStatus: true,
            voiceStatusMessage: "Listening. Speak now and release to stop.",
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-hands-free-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-voice-active-strip-status"]')?.textContent).toContain(
      "Listening. Speak now and release to stop.",
    );
    expect(container.querySelector('[data-testid="chat-voice-active-strip"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Continuous");
    expect(container.textContent).not.toContain("Tap");
    expect(container.textContent).not.toContain("Hold");
  });

  it("keeps voice capture inline on mobile instead of opening a separate voice mode", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            compactBrowserViewport: true,
            showVoicePrimaryAction: true,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-open-voice-mode-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="mock-voice-action-strip"]')).not.toBeNull();
  });

  it("caps the desktop composer width using the shared composer column class", async () => {
    await act(async () => {
      root.render(<ChatComposerSurface {...createProps()} />);
    });

    const form = container.querySelector("form");
    expect(form?.className).toContain(CHAT_COMPOSER_COLUMN_CLASS_NAME);
  });

  it("insets the active goal card from scroll edges", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            ...createBlockedGoalProps(),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-active-goal"]')?.className).toContain("mx-1");

    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            compactBrowserViewport: true,
            ...createBlockedGoalProps(),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-active-goal"]')?.className).toContain("mx-2");
  });

  it("shows active conversation goals without sending them as chat text", async () => {
    const onPauseGoal = vi.fn();
    const onClearGoal = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onPauseGoal,
            onClearGoal,
            activeGoal: {
              id: "goal-1",
              objective: "Finish the Demo hardware prep slice",
              status: "active",
              doneWhen: null,
              stopWhen: null,
              progressSummary: null,
              parentGoalId: null,
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:00.000Z",
              createdBy: "user-1",
              updatedBy: "user-1",
            },
            activeGoalHealth: {
              turnCount: 2,
              maxTurns: 100,
              label: "Turn 2/100",
              detail: null,
              tone: "active",
              progressRatio: 0.02,
              stagnation: {
                level: "none",
                reason: "none",
                summary: null,
              },
            },
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-active-goal"]')?.textContent).toContain(
      "Finish the Demo hardware prep slice",
    );
    expect(container.querySelector('[data-testid="chat-active-goal"]')?.textContent).toContain(
      "Turn 2/100",
    );
    const pauseButton = container.querySelector<HTMLButtonElement>('[aria-label="Pause goal"]');
    const clearButton = container.querySelector<HTMLButtonElement>('[aria-label="Clear goal"]');

    expect(pauseButton).not.toBeNull();
    expect(clearButton).not.toBeNull();

    await act(async () => {
      pauseButton?.click();
      clearButton?.click();
    });
    expect(onPauseGoal).toHaveBeenCalledTimes(1);
    expect(onClearGoal).toHaveBeenCalledTimes(1);
  });

  it("shows a resume control for paused conversation goals", async () => {
    const onResumeGoal = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onResumeGoal,
            activeGoal: {
              id: "goal-1",
              objective: "Finish the Demo hardware prep slice",
              status: "paused",
              doneWhen: null,
              stopWhen: null,
              progressSummary: null,
              parentGoalId: null,
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:00.000Z",
              createdBy: "user-1",
              updatedBy: "user-1",
            },
          })}
        />,
      );
    });

    const resumeButton = container.querySelector<HTMLButtonElement>('[aria-label="Resume goal"]');
    expect(resumeButton).not.toBeNull();
    await act(async () => {
      resumeButton?.click();
    });
    expect(onResumeGoal).toHaveBeenCalledTimes(1);
  });

  it("keeps blocked goals visible with the blocker summary", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface {...createProps(createBlockedGoalProps())} />,
      );
    });

    expect(container.querySelector('[data-testid="chat-active-goal"]')?.textContent).toContain(
      "Blocked",
    );
    expect(container.querySelector('[data-testid="chat-active-goal"]')?.textContent).toContain(
      "Run failed before the goal completed.",
    );
  });

  it("expands blocked goal details from the goal text", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface {...createProps(createBlockedGoalProps())} />,
      );
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')).toBeNull();

    const goalTextButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-active-goal-summary"]',
    );
    expect(goalTextButton).not.toBeNull();

    await act(async () => {
      goalTextButton?.click();
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')?.textContent).toContain(
      "Run failed before the goal completed.",
    );
    expect(goalTextButton?.getAttribute("aria-expanded")).toBe("true");
  });

  it("expands blocked goal details from the blocked status chip", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface {...createProps(createBlockedGoalProps())} />,
      );
    });

    const statusButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show goal details: Blocked"]',
    );
    expect(statusButton).not.toBeNull();
    expect(statusButton?.querySelector("svg")).not.toBeNull();

    await act(async () => {
      statusButton?.click();
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')?.textContent).toContain(
      "Run failed before the goal completed.",
    );
    expect(statusButton?.getAttribute("aria-expanded")).toBe("true");
  });

  it("expands blocked goal details from the chevron control", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface {...createProps(createBlockedGoalProps())} />,
      );
    });

    const detailsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show goal details"]',
    );
    expect(detailsButton).not.toBeNull();

    await act(async () => {
      detailsButton?.click();
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')?.textContent).toContain(
      "Run failed before the goal completed.",
    );
    expect(detailsButton?.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers blocked goal help from expanded details", async () => {
    const onHelpUnblockGoal = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            ...createBlockedGoalProps(),
            onHelpUnblockGoal,
          })}
        />,
      );
    });

    const statusButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show goal details: Blocked"]',
    );
    expect(statusButton).not.toBeNull();

    await act(async () => {
      statusButton?.click();
    });

    const helpButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Help unblock",
    );
    expect(helpButton).not.toBeUndefined();

    await act(async () => {
      helpButton?.click();
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')).toBeNull();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onHelpUnblockGoal).toHaveBeenCalledTimes(1);
  });

  it("collapses blocked goal details when the parent collapse token changes", async () => {
    let collapseToken = 0;
    const renderSurface = () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            ...createBlockedGoalProps(),
            goalDetailsCollapseToken: collapseToken,
          })}
        />,
      );
    };

    await act(async () => {
      renderSurface();
    });

    const statusButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show goal details: Blocked"]',
    );
    expect(statusButton).not.toBeNull();

    await act(async () => {
      statusButton?.click();
    });
    expect(container.querySelector('[data-testid="chat-active-goal-details"]')).not.toBeNull();

    collapseToken += 1;
    await act(async () => {
      renderSurface();
    });

    expect(container.querySelector('[data-testid="chat-active-goal-details"]')).toBeNull();
  });

  it("surfaces goal health warnings inline with the active goal", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            activeGoal: {
              id: "goal-1",
              objective: "Improve the README until it is ready",
              status: "active",
              doneWhen: null,
              stopWhen: null,
              progressSummary: null,
              parentGoalId: null,
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:01.000Z",
              createdBy: "user-1",
              updatedBy: "user-1",
            },
            activeGoalHealth: {
              turnCount: 5,
              maxTurns: 100,
              label: "Needs reassessment",
              detail:
                "Recent automatic goal turns look repetitive. The next turn should complete, block, or change strategy.",
              tone: "warning",
              progressRatio: 0.05,
              stagnation: {
                level: "warning",
                reason: "repeated_assistant_output",
                summary:
                  "Recent automatic goal turns look repetitive. The next turn should complete, block, or change strategy.",
              },
            },
          })}
        />,
      );
    });

    const goalChip = container.querySelector('[data-testid="chat-active-goal"]');
    expect(goalChip?.textContent).toContain("Improve the README until it is ready");
    expect(goalChip?.textContent).toContain("Needs reassessment");
    expect(goalChip?.textContent).toContain("Recent automatic goal turns look repetitive");
  });

  // The participants roster moved to the persistent top bar: above the input it
  // sat in the reading hot-path, collided with right-aligned user messages and
  // shifted the composer on every membership change. The composer must not
  // render it again — the mock above would surface any re-added import.
  it("never renders the participants roster in the composer stack", async () => {
    await act(async () => {
      root.render(<ChatComposerSurface {...createProps()} />);
    });

    expect(container.querySelector('[data-testid="mock-conversation-roster"]')).toBeNull();
    expect(container.querySelector('[data-testid="conversation-roster"]')).toBeNull();
  });

  it("submits from a native click fallback when press events are unavailable", async () => {
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onSendButtonPress,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const sendButton = container.querySelector<HTMLButtonElement>('[data-testid="chat-send-button"]');
    expect(sendButton).not.toBeNull();

    await act(async () => {
      sendButton?.click();
    });

    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
  });

  it("makes active Steer mode visible and announces the Enter behavior", async () => {
    const renderSurface = (primaryActionMode: "send" | "steer") =>
      root.render(
        <ChatComposerSurface
          {...createProps({
            primaryActionMode,
            showVoicePrimaryAction: false,
          })}
        />,
      );

    await act(async () => renderSurface("send"));

    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    const actionStatus = container.querySelector('[data-testid="chat-primary-action-status"]');

    expect(sendButton?.getAttribute("aria-label")).toBe("Send message");
    expect(sendButton?.getAttribute("title")).toBe("Send message");
    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");
    expect(container.querySelector('[data-testid="chat-steer-action-label"]')).toBeNull();
    expect(actionStatus?.getAttribute("role")).toBe("status");
    expect(actionStatus?.getAttribute("aria-live")).toBe("polite");
    expect(actionStatus?.getAttribute("aria-atomic")).toBe("true");
    expect(actionStatus?.textContent).toBe("Enter sends the message.");

    await act(async () => renderSurface("steer"));

    expect(container.querySelector('[data-testid="chat-send-button"]')).toBe(sendButton);
    expect(sendButton?.getAttribute("aria-label")).toBe("Steer current reply (Enter)");
    expect(sendButton?.getAttribute("title")).toBe("Steer current reply (Enter)");
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");
    expect(sendButton?.className).toContain("!w-auto");
    expect(container.querySelector('[data-testid="chat-steer-action-label"]')?.textContent).toBe(
      "Steer↵",
    );
    expect(actionStatus?.textContent).toBe("Enter steers the current reply.");

    await act(async () => renderSurface("send"));

    expect(container.querySelector('[data-testid="chat-steer-action-label"]')).toBeNull();
    expect(actionStatus?.textContent).toBe("Enter sends the message.");
  });
});
