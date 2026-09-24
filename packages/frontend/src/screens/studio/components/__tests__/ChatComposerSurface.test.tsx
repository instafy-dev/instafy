// @vitest-environment jsdom

import { forwardRef, useState, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposerSurface } from "../ChatComposerSurface";
import { CHAT_COMPOSER_COLUMN_CLASS_NAME } from "../ChatColumn";
import { deriveChatVoiceComposerViewState } from "../chatVoiceComposerViewState";
import {
  TOUCH_SEND_MODE_HOLD_DELAY_MS,
  createTouchSendModePickerLayout,
  type TouchSendMode,
} from "../touchSendModePicker";

vi.mock("../ChatBrowserDock", () => ({
  ChatBrowserDock: () => null,
}));

// The mock exposes the folded actions as labelled buttons so "no action
// lost" can be checked by accessible name alone, across inline and menu.
vi.mock("../ComposerActionMenu", () => ({
  ComposerActionMenu: (props: Record<string, unknown>) => (
    <div
      data-testid="mock-composer-action-menu"
      data-upload-image={String(typeof props.onUploadImage === "function")}
      data-insert-suggestion={String(typeof props.onInsertSuggestion === "function")}
      data-trigger-class={String(props.triggerClassName ?? "")}
      data-trigger-icon-class={String(props.triggerIconClassName ?? "")}
    >
      <button type="button" aria-label="Open composer actions" className="mock-menu-trigger" />
      {typeof props.onUploadImage === "function" ? (
        <button type="button" aria-label="Upload image" data-testid="mock-menu-upload-image" disabled={props.uploadImageDisabled === true} onClick={props.onUploadImage as () => void} />
      ) : null}
      {typeof props.onStartVoiceInput === "function" ? (
        <button type="button" aria-label="Dictate message" data-testid="mock-menu-start-voice" disabled={props.voiceInputDisabled === true} onClick={props.onStartVoiceInput as () => void} />
      ) : null}
      {typeof props.onInsertSuggestion === "function" ? (
        <button type="button" aria-label="Insert suggestion" data-testid="mock-menu-insert-suggestion" />
      ) : null}
    </div>
  ),
}));

vi.mock("../ComposerInviteModal", () => ({
  ComposerInviteModal: () => null,
}));


vi.mock("../ConversationRoster", () => ({
  ConversationRoster: () => <div data-testid="mock-conversation-roster" />,
}));

// Expose microphone identity and styling without invoking speech providers.
vi.mock("../VoiceConversationActionStrip", () => ({
  VoiceConversationActionStrip: (props: Record<string, unknown>) => (
    <div
      data-testid="mock-voice-action-strip"
      data-voice-input-testid={String(props.voiceInputTestId ?? "chat-voice-input-button")}
      data-voice-replies-toggle={String(props.showVoiceRepliesToggle === true)}
      data-voice-interaction-mode={String(props.voiceInteractionMode ?? "hold")}
      data-ghost-class={String(props.ghostActionClassName ?? "")}
      data-primary-class={String(props.primaryActionClassName ?? "")}
      data-icon-class={String(props.actionIconClassName ?? "")}
    >
      <button type="button" data-testid="mock-voice-tap" onClick={props.onVoiceTap as () => void} />
    </div>
  ),
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
        data-compact-viewport={String(_props.compactViewport === true)}
        data-read-only={String(_props.readOnly === true)}
        data-testid="chat-input"
      >
        Ask for something…
      </div>
    );
  }),
}));

type ComposerQueueSurfaceProps = ComponentProps<
  typeof ChatComposerSurface
>["queueSurfaceProps"];

function createQueueSurfaceProps(
  overrides: Partial<ComposerQueueSurfaceProps> = {},
): ComposerQueueSurfaceProps {
  return {
    totalQueuedCount: 0,
    editingQueuedItem: null,
    chatSendQueueExpanded: false,
    collapsedQueuedMessageSummary: null,
    queueCanSendNow: false,
    chatSendQueueDisplay: [],
    sendingAttachment: false,
    inputValue: "",
    onToggleExpanded: () => undefined,
    onSendQueuedMessageNow: () => undefined,
    onRemoveQueuedItem: () => undefined,
    onReorderQueuedItem: () => undefined,
    onEditQueuedMessage: () => undefined,
    onCancelQueuedEdit: () => undefined,
    onRequeueEditedMessage: () => undefined,
    onSendEditedMessageNow: () => undefined,
    ...overrides,
  };
}

function SavedMessagesHarness({
  queueCount = 2,
  stashCount = 1,
  initialQueueExpanded = false,
  onQueueExpandedChange,
  onQueueReorder,
  editOnRequest = false,
  chatInputRef,
}: {
  queueCount?: number;
  stashCount?: number;
  initialQueueExpanded?: boolean;
  onQueueExpandedChange?: (expanded: boolean) => void;
  onQueueReorder?: (id: string, targetIndex: number) => void;
  editOnRequest?: boolean;
  chatInputRef?: ComponentProps<typeof ChatComposerSurface>["chatInputRef"];
}) {
  const [queueExpanded, setQueueExpanded] = useState(initialQueueExpanded);
  const [editingQueuedItem, setEditingQueuedItem] = useState<
    ComposerQueueSurfaceProps["editingQueuedItem"]
  >(null);
  const queueItems = Array.from({ length: queueCount }, (_, index) => ({
    id: `queued-${index + 1}`,
    message: `Queued message ${index + 1}`,
    targetHandles: ["octo"],
  }));
  return (
    <ChatComposerSurface
      {...createProps({
        queueSurfaceProps: createQueueSurfaceProps({
          totalQueuedCount: queueCount,
          editingQueuedItem,
          chatSendQueueExpanded: queueExpanded,
          collapsedQueuedMessageSummary:
            queueCount === 1 ? { message: queueItems[0]?.message ?? "Queued message" } : null,
          chatSendQueueDisplay: queueItems,
          onToggleExpanded: () => {
            setQueueExpanded((current) => {
              const next = !current;
              onQueueExpandedChange?.(next);
              return next;
            });
          },
          onEditQueuedMessage: () => {
            if (editOnRequest) {
              setEditingQueuedItem({ targetAgentHandles: ["octo"] });
            }
          },
          onReorderQueuedItem: onQueueReorder ?? (() => undefined),
        }),
        chatInputRef: chatInputRef ?? { current: null },
        stashTrayProps:
          stashCount > 0
            ? ({
                stashes: Array.from({ length: stashCount }, (_, index) => ({
                  id: `stash-${index + 1}`,
                  text: `Saved draft ${index + 1}`,
                })),
                restoredStashId: null,
                onRestore: () => undefined,
                onDelete: () => undefined,
              } as never)
            : null,
      })}
    />
  );
}

function createProps(
  overrides: Partial<ComponentProps<typeof ChatComposerSurface>> = {},
): ComponentProps<typeof ChatComposerSurface> {
  return {
    browserDockProps: {} as never,
    composerOverlayRef: { current: null },
    composerAutoHidden: false,
    compactBrowserViewport: false,
    onSubmit: (event) => event.preventDefault(),
    queueSurfaceProps: createQueueSurfaceProps(),
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
    showComposerNavigationButton: false,
    onOpenNavigation: () => undefined,
    homeAttentionCount: 0,
    homeAttentionBadge: "",
    composerActionMenuProps: {} as never,
    onOpenImagePicker: () => undefined,
    sendingAttachment: false,
    showMobileGhostSuggestionAcceptButton: false,
    onAcceptGhostSuggestion: () => undefined,
    showVoicePrimaryAction: true,
    showVoiceSecondaryAction: false,
    voiceConversationActionStripProps: {} as never,
    sendButtonDisabled: false,
    sendButtonVariant: "primary",
    onSendButtonPress: () => undefined,
    composerGhostActionClass: "ghost",
    composerPrimaryActionClass: "primary",
    composerActionIconClass: "icon",
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

const touchSendAnchor = {
  left: 268,
  top: 568,
  right: 312,
  bottom: 612,
};

function touchSendTargetCenter(mode: TouchSendMode) {
  const layout = createTouchSendModePickerLayout({
    anchor: touchSendAnchor,
    viewport: { left: 0, top: 0, right: 1024, bottom: 768 },
    primaryMode: mode === "steer" ? "steer" : "send",
    targetSize: 64,
    targetGap: 6,
  });
  const target = layout.targets.find((candidate) => candidate.mode === mode);
  if (!target) {
    throw new Error(`Missing ${mode} touch target`);
  }
  return {
    x: (target.rect.left + target.rect.right) / 2,
    y: (target.rect.top + target.rect.bottom) / 2,
  };
}

function touchPointerEvent(
  type: string,
  {
    pointerId = 7,
    x = 290,
    y = 590,
  }: { pointerId?: number; x?: number; y?: number } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: "touch" },
    isPrimary: { configurable: true, value: true },
  });
  return event;
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // The voice flags come from the real view state so the layout tests run
  // through the gate the founder hits: on a voice-capable client (web speech
  // in Chromium) the mic is the "primary action" while the draft is empty and
  // steps back to "secondary" once there is a payload; on a client without
  // voice both flags are false throughout. Explicit overrides still win.
  function voiceFlagsFor(voiceInputSupported: boolean, value: string) {
    const state = deriveChatVoiceComposerViewState({
      chatVoiceInteractionMode: "hold",
      composerHasSendPayload: value.trim().length > 0,
      continuousAwaitingAssistantReply: false,
      continuousConversationActive: false,
      continuousPauseMessage: null,
      continuousVoiceResolving: false,
      voiceHoldActive: false,
      voiceInputListening: false,
      voiceInputStarting: false,
      voiceInputSupported,
      voiceInputTranscript: "",
      voiceInputTranscribing: false,
    });
    return {
      showVoicePrimaryAction: state.showVoicePrimaryAction,
      showVoiceSecondaryAction: state.showVoiceSecondaryAction,
    };
  }

  function renderLayout(
    overrides: Partial<ComponentProps<typeof ChatComposerSurface>> = {},
    { voiceInputSupported = true }: { voiceInputSupported?: boolean } = {},
  ) {
    const base = createProps();
    const value = (overrides.chatInputProps as { value?: string } | undefined)?.value ?? "";
    return root.render(
      <ChatComposerSurface
        {...base}
        {...voiceFlagsFor(voiceInputSupported, value)}
        {...overrides}
        chatInputProps={{ ...base.chatInputProps, ...(overrides.chatInputProps ?? {}) }}
      />,
    );
  }

  function layoutNodes() {
    return {
      textRow: container.querySelector('[data-testid="chat-composer-text-row"]'),
      leading: container.querySelector('[data-testid="chat-composer-leading-controls"]'),
      trailing: container.querySelector('[data-testid="chat-composer-trailing-controls"]'),
      menu: container.querySelector('[data-testid="mock-composer-action-menu"]'),
      navigation: container.querySelector('[data-testid="chat-composer-navigation-button"]'),
      send: container.querySelector('[data-testid="chat-send-button"]'),
      image: container.querySelector('[data-testid="chat-image-upload-button"]'),
      wand: container.querySelector('[data-testid="chat-accept-suggestion-button"]'),
      voice: container.querySelector('[data-testid="mock-voice-action-strip"]'),
    };
  }

  it.each([
    { viewport: "wide", compactBrowserViewport: false },
    { viewport: "narrow", compactBrowserViewport: true },
  ])("keeps image upload in the + menu and one microphone at rest on $viewport layouts", async ({ compactBrowserViewport }) => {
    const onOpenImagePicker = vi.fn();
    await act(async () => renderLayout({ compactBrowserViewport, onOpenImagePicker }));
    const nodes = layoutNodes();
    expect(nodes.textRow?.className.split(" ")).toContain("items-end");
    expect(nodes.leading?.contains(nodes.menu)).toBe(true);
    expect(nodes.image).toBeNull();
    expect(nodes.menu?.getAttribute("data-upload-image")).toBe("true");
    expect(nodes.trailing?.contains(nodes.voice)).toBe(true);
    expect(nodes.send).toBeNull();
    expect(nodes.wand).toBeNull();
    expect(container.querySelector('[data-testid="chat-image-upload-input"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mock-menu-upload-image"]')?.click());
    expect(onOpenImagePicker).toHaveBeenCalledTimes(1);
  });

  it("owns the chat safe area and retains composer controls across keyboard transitions", async () => {
    await act(async () => renderLayout({ compactBrowserViewport: true }));
    const before = layoutNodes();
    const input = container.querySelector('[data-testid="chat-input"]');
    const editorWrapper = input?.parentElement;
    const surface = layoutNodes().textRow!.closest("form")!;
    expect(surface.style.paddingBottom).toContain("--instafy-safe-area-inset-bottom");
    await act(async () => renderLayout({ compactBrowserViewport: true, nativeKeyboardOpen: true }));
    expect(layoutNodes().textRow!.closest("form")).toBe(surface);
    expect(surface.style.paddingBottom).toBe("0.5rem");
    expect(layoutNodes()).toEqual(before);
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
    expect(input?.parentElement).toBe(editorWrapper);
    await act(async () => renderLayout({ compactBrowserViewport: true, nativeKeyboardOpen: false }));
    expect(surface.style.paddingBottom).toContain("--instafy-safe-area-inset-bottom");
    expect(layoutNodes()).toEqual(before);
  });

  describe.each([
    { client: "a voice-capable client", voiceInputSupported: true },
    { client: "a client without voice", voiceInputSupported: false },
  ])("on $client", ({ voiceInputSupported }) => {
    it.each([
      { viewport: "wide", compactBrowserViewport: false },
      { viewport: "narrow", compactBrowserViewport: true },
    ])("preserves the editor and control groups while the primary slot changes on $viewport layouts", async ({ compactBrowserViewport }) => {
      const renderDraft = (value: string) => renderLayout({
        compactBrowserViewport,
        showComposerNavigationButton: true,
        chatInputProps: { value } as never,
        sendButtonVariant: value.trim() ? "primary" : "ghost",
      }, { voiceInputSupported });
      await act(async () => renderDraft(""));
      const idle = layoutNodes();
      const input = container.querySelector('[data-testid="chat-input"]');
      const wrapper = input?.parentElement;
      expect(idle.send === null).toBe(voiceInputSupported);
      expect(idle.voice !== null).toBe(voiceInputSupported);

      let previousSend = idle.send;
      for (const value of ["a", "a\nb\nc", "", "   "]) {
        await act(async () => renderDraft(value));
        const nodes = layoutNodes();
        const hasPayload = value.trim().length > 0;
        expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
        expect(input?.parentElement).toBe(wrapper);
        expect(nodes.textRow).toBe(idle.textRow);
        expect(nodes.leading).toBe(idle.leading);
        expect(nodes.trailing).toBe(idle.trailing);
        expect(nodes.menu).toBe(idle.menu);
        expect(nodes.navigation).toBe(idle.navigation);
        expect(nodes.image).toBeNull();
        expect(nodes.send !== null).toBe(hasPayload || !voiceInputSupported);
        expect(nodes.voice !== null).toBe(!hasPayload && voiceInputSupported);
        expect(Number(nodes.send !== null) + Number(nodes.voice !== null)).toBe(1);
        if (previousSend && nodes.send) expect(nodes.send).toBe(previousSend);
        previousSend = nodes.send;
        if (nodes.send) expect(nodes.send.getAttribute("data-send-rest")).toBe(hasPayload ? "false" : "true");
      }
    });
  });

  it("offers Send for an image-only draft and returns to the microphone after removal", async () => {
    const attachment = { id: "image-1", file: new File(["image"], "mock.png", { type: "image/png" }), previewUrl: "blob:mock-image" };
    await act(async () => renderLayout());
    const input = container.querySelector('[data-testid="chat-input"]');
    await act(async () => renderLayout({ imageAttachments: [attachment], sendButtonVariant: "primary" }));
    expect(layoutNodes().send).not.toBeNull();
    expect(layoutNodes().voice).toBeNull();
    expect(container.querySelector('[data-testid="chat-image-upload-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
    await act(async () => renderLayout());
    expect(layoutNodes().send).toBeNull();
    expect(layoutNodes().voice).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
  });

  it.each([false, true])("keeps image upload and suggestion acceptance in the menu (compact=%s)", async (compactBrowserViewport) => {
    await act(async () => renderLayout({
      compactBrowserViewport,
      showMobileGhostSuggestionAcceptButton: true,
      chatInputProps: { value: "Hel" } as never,
      sendButtonVariant: "primary",
    }));
    const nodes = layoutNodes();
    expect(nodes.image).toBeNull();
    expect(nodes.wand).toBeNull();
    expect(nodes.menu?.getAttribute("data-upload-image")).toBe("true");
    expect(nodes.menu?.getAttribute("data-insert-suggestion")).toBe("true");
    expect(nodes.trailing?.contains(nodes.send)).toBe(true);
    expect(nodes.voice).toBeNull();
  });

  it.each(["voiceActionActive", "voiceListening", "voiceStarting", "voiceTranscribing"])(
    "retains the held microphone when %s is the remaining capture signal",
    async (captureSignal) => {
      const renderCapture = (value: string, active: boolean) => renderLayout({
        chatInputProps: { value } as never,
        showVoiceStatus: active,
        voiceStatusMessage: "Listening. Speak now and release to stop.",
        voiceConversationActionStripProps: {
          voiceInteractionMode: "hold",
          [captureSignal]: active,
        } as never,
      });
      await act(async () => renderCapture("", false));
      const mic = layoutNodes().voice;
      const trailing = layoutNodes().trailing;
      const input = container.querySelector('[data-testid="chat-input"]');
      expect(mic).not.toBeNull();
      await act(async () => renderCapture("", true));
      await act(async () => renderCapture("transcribed words", true));
      expect(layoutNodes().voice).toBe(mic);
      expect(layoutNodes().trailing).toBe(trailing);
      expect(layoutNodes().send).toBeNull();
      expect(container.querySelector('[data-testid="chat-voice-active-strip"]')).toBeNull();
      expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
      await act(async () => renderCapture("", true));
      expect(layoutNodes().voice).toBe(mic);
      expect(layoutNodes().trailing).toBe(trailing);
      expect(layoutNodes().send).toBeNull();
      expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
      await act(async () => renderCapture("transcribed words", false));
      expect(layoutNodes().voice).toBeNull();
      expect(layoutNodes().send).not.toBeNull();
      expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
    },
  );

  it("keeps Send available when continuous voice is paused with a status notice and a draft", async () => {
    const paused = deriveChatVoiceComposerViewState({
      chatVoiceInteractionMode: "continuous",
      composerHasSendPayload: true,
      continuousAwaitingAssistantReply: false,
      continuousConversationActive: false,
      continuousPauseMessage: "Continuous voice paused. Start again when ready.",
      continuousVoiceResolving: false,
      voiceHoldActive: false,
      voiceInputListening: false,
      voiceInputStarting: false,
      voiceInputSupported: true,
      voiceInputTranscript: "",
      voiceInputTranscribing: false,
    });
    await act(async () => renderLayout({
      chatInputProps: { value: "My unfinished message" } as never,
      showVoicePrimaryAction: paused.showVoicePrimaryAction,
      showVoiceSecondaryAction: paused.showVoiceSecondaryAction,
      showVoiceStatus: paused.showVoiceStatus,
      voiceStatusMessage: paused.voiceStatusMessage,
      voiceConversationActionStripProps: {
        voiceInteractionMode: "continuous",
        voiceActionActive: paused.voiceActionActive,
        voiceListening: false,
        voiceStarting: false,
        voiceTranscribing: false,
      } as never,
    }));
    expect(paused.showVoiceStatus).toBe(true);
    expect(layoutNodes().send).not.toBeNull();
    expect(layoutNodes().voice).toBeNull();
    expect(container.querySelector('[data-testid="chat-voice-active-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-voice-input-status"]')?.textContent).toBe(paused.voiceStatusMessage);
  });

  it("lets menu-started dictation stop by tapping without changing the default hold gesture", async () => {
    let capturePhase: "idle" | "starting" | "listening" | "transcribing" = "idle";
    let draft = "An existing draft";
    const onVoicePressStart = vi.fn();
    const onVoicePressEnd = vi.fn();
    const onVoiceTap = vi.fn(async () => {
      capturePhase = capturePhase === "idle" ? "starting" : "transcribing";
      renderCapture();
    });
    const renderCapture = () => renderLayout({
      chatInputProps: { value: draft, draftKey: "test" } as never,
      showVoiceStatus: capturePhase !== "idle",
      voiceStatusMessage: capturePhase === "listening"
        ? "Recording. Heard: some additional words"
        : capturePhase === "transcribing"
          ? "Transcribing voice input…"
          : "Starting voice input. Keep holding.",
      voiceConversationActionStripProps: {
        voiceInteractionMode: "hold",
        voiceActionActive: capturePhase !== "idle",
        voiceStarting: capturePhase === "starting",
        voiceListening: capturePhase === "listening",
        voiceTranscribing: capturePhase === "transcribing",
        onVoiceTap,
        onVoicePressStart,
        onVoicePressEnd,
      } as never,
    });

    await act(async () => renderCapture());
    const input = container.querySelector('[data-testid="chat-input"]');
    expect(layoutNodes().send).not.toBeNull();
    const dictate = container.querySelector<HTMLButtonElement>('[data-testid="mock-menu-start-voice"]');
    expect(dictate).not.toBeNull();
    await act(async () => dictate?.click());
    expect(onVoiceTap).toHaveBeenCalledTimes(1);
    const microphone = layoutNodes().voice;
    expect(microphone).not.toBeNull();
    expect(microphone?.getAttribute("data-voice-interaction-mode")).toBe("tap");
    expect(layoutNodes().send).toBeNull();
    expect(container.querySelector('[data-testid="chat-voice-input-status"]')?.textContent).toBe("Starting dictation. Tap the microphone to stop.");

    capturePhase = "listening";
    await act(async () => renderCapture());
    expect(layoutNodes().voice).toBe(microphone);
    expect(container.querySelector('[data-testid="chat-voice-input-status"]')?.textContent).toContain("Tap the microphone to stop.");
    await act(async () => microphone?.querySelector<HTMLButtonElement>('[data-testid="mock-voice-tap"]')?.click());
    expect(onVoiceTap).toHaveBeenCalledTimes(2);
    expect(onVoicePressStart).not.toHaveBeenCalled();
    expect(onVoicePressEnd).not.toHaveBeenCalled();
    expect(layoutNodes().voice).toBe(microphone);
    expect(container.querySelector('[data-testid="chat-voice-input-status"]')?.textContent).toBe("Transcribing dictation…");

    capturePhase = "idle";
    draft = "An existing draft with some additional words";
    await act(async () => renderCapture());
    expect(layoutNodes().voice).toBeNull();
    expect(layoutNodes().send).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
    draft = "";
    await act(async () => renderCapture());
    expect(layoutNodes().voice?.getAttribute("data-voice-interaction-mode")).toBe("hold");
  });

  it("disables menu dictation when voice input is unavailable for the current draft", async () => {
    const onVoiceTap = vi.fn();
    await act(async () => renderLayout({
      chatInputProps: { value: "My draft" } as never,
      voiceConversationActionStripProps: { disabled: true, onVoiceTap } as never,
    }));
    const dictate = container.querySelector<HTMLButtonElement>('[data-testid="mock-menu-start-voice"]');
    expect(dictate?.disabled).toBe(true);
    await act(async () => dictate?.click());
    expect(onVoiceTap).not.toHaveBeenCalled();
    expect(layoutNodes().send).not.toBeNull();
  });

  it("renders the composer navigation button once, as a ghost, first in the row, regardless of the draft", async () => {
    const renderNavigation = (value: string) =>
      renderLayout({
        showComposerNavigationButton: true,
        homeAttentionCount: 2,
        homeAttentionBadge: "2",
        chatInputProps: { value } as never,
        sendButtonVariant: value ? "primary" : "ghost",
      });

    await act(async () => renderNavigation(""));
    const navigation = layoutNodes().navigation;
    expect(layoutNodes().leading?.contains(navigation)).toBe(true);
    expect(layoutNodes().leading?.firstElementChild).toBe(navigation);
    expect(navigation?.getAttribute("aria-label")).toBe("Open navigation and recent chats");
    expect(navigation?.className.split(" ")).toContain("ghost");
    expect(navigation?.querySelector('[data-testid="chat-composer-navigation-badge"]')?.textContent).toBe("2");
    const navigationClass = navigation?.className;

    await act(async () => renderNavigation("Ship it"));
    expect(layoutNodes().navigation).toBe(navigation);
    expect(layoutNodes().leading?.firstElementChild).toBe(navigation);
    expect(navigation?.className).toBe(navigationClass);
    expect(navigation?.querySelector('[data-testid="chat-composer-navigation-badge"]')?.textContent).toBe("2");
    expect(container.querySelectorAll('[data-testid="chat-composer-navigation-button"]')).toHaveLength(1);
  });

  it("opens navigation without submitting or changing the editor", async () => {
    const onOpenNavigation = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    await act(async () => renderLayout({
      showComposerNavigationButton: true,
      onOpenNavigation,
      onSubmit,
      chatInputProps: { value: "Keep this draft" } as never,
    }));
    const editor = container.querySelector('[data-testid="chat-input"]');
    const navigation = layoutNodes().navigation as HTMLButtonElement;
    expect(navigation.type).toBe("button");
    await act(async () => navigation.click());
    expect(onOpenNavigation).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(editor);
  });

  it("keeps an icon-only Chats destination in the writing row through keyboard and draft changes", async () => {
    const onOpenNavigation = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const renderMobile = (value: string, nativeKeyboardOpen: boolean) => renderLayout({
      showComposerNavigationButton: true,
      composerNavigationDestination: "chats",
      compactBrowserViewport: true,
      nativeKeyboardOpen,
      onOpenNavigation,
      onSubmit,
      homeAttentionCount: 2,
      homeAttentionBadge: "2",
      chatInputProps: { value } as never,
    });
    await act(async () => renderMobile("", false));
    const navigation = layoutNodes().navigation as HTMLButtonElement;
    const editor = container.querySelector('[data-testid="chat-input"]');
    expect(navigation.getAttribute("aria-label")).toBe("Back to chats");
    expect(navigation.getAttribute("title")).toBe("Back to chats");
    expect(navigation.hasAttribute("aria-haspopup")).toBe(false);
    expect(navigation.textContent).toBe("");
    expect(container.querySelector('[data-testid="chat-composer-navigation-badge"]')).toBeNull();
    expect(layoutNodes().leading?.firstElementChild).toBe(navigation);
    expect(layoutNodes().trailing?.contains(layoutNodes().menu)).toBe(true);

    await act(async () => renderMobile("Keep this draft", true));
    expect(layoutNodes().navigation).toBe(navigation);
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(editor);
    expect(layoutNodes().textRow?.contains(navigation)).toBe(true);
    expect(layoutNodes().textRow?.contains(layoutNodes().send)).toBe(true);
    await act(async () => navigation.click());
    expect(onOpenNavigation).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("omits composer navigation when the wide sidebar owns switching", async () => {
    await act(async () => renderLayout({ showComposerNavigationButton: false }));
    expect(layoutNodes().navigation).toBeNull();
    expect(layoutNodes().leading?.firstElementChild).toBe(layoutNodes().menu);
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
    expect(layoutNodes().image).toBeNull();
    expect(layoutNodes().menu?.getAttribute("data-upload-image")).toBe("true");
    // Both the browser and chat composer use the microphone for an empty draft.
    expect(container.querySelector('[data-testid="mock-voice-action-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-send-button"]')).toBeNull();
    const inputNode = container.querySelector('[data-testid="chat-input"]');

    await act(async () => renderSurface("Tell Octo what to do on this page"));
    expect(container.querySelector('[data-browser-composer-condensed="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute("data-compact")).toBe(
      "false",
    );
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(inputNode);
  });

  it("shows only the microphone while keeping the action announcement mounted at rest", async () => {
    await act(async () => renderLayout({ sendButtonVariant: "ghost" }));
    expect(layoutNodes().voice).not.toBeNull();
    expect(layoutNodes().send).toBeNull();
    const status = container.querySelector('[data-testid="chat-primary-action-status"]');
    expect(status).not.toBeNull();
    await act(async () => renderLayout({ chatInputProps: { value: "Refine it" } as never, primaryActionMode: "steer" }));
    expect(container.querySelector('[data-testid="chat-primary-action-status"]')).toBe(status);
    expect(status?.textContent).toBe("Enter steers the current reply.");
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
    expect(container.querySelector<HTMLButtonElement>('[data-testid="mock-menu-upload-image"]')?.disabled).toBe(true);
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

  it.each(["tap", "continuous"] as const)("keeps the integrated active %s voice strip", async (voiceInteractionMode) => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            showVoiceStatus: true,
            voiceStatusMessage: "Listening. Speak now and release to stop.",
            voiceConversationActionStripProps: { voiceInteractionMode } as never,
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

  it("hides the stash expander while a queued message is being edited", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            queueSurfaceProps: {
              ...createQueueSurfaceProps(),
              editingQueuedItem: { targetAgentHandles: ["octo"] },
            },
            stashTrayProps: {
              stashes: [{ id: "stash-1", text: "Saved draft" }],
              restoredStashId: null,
              onRestore: vi.fn(),
              onDelete: vi.fn(),
            } as never,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-message-stashes"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-queue-agent-summary"]')).toBeNull();
    expect(container.querySelector('[aria-label="Queued messages"][role="region"]')).not.toBeNull();
    const queueSurfaces = container.querySelectorAll('[data-testid="chat-send-queue"]');
    expect(queueSurfaces).toHaveLength(1);
    expect(queueSurfaces[0]?.querySelector('[aria-label="Queued messages"][role="region"]')).not.toBeNull();
  });

  it("keeps the trigger rail fixed while saved-message actions open in a popover", async () => {
    await act(async () => {
      root.render(<SavedMessagesHarness />);
    });

    const controls = container.querySelector('[data-testid="chat-saved-message-controls"]');
    const stashTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-stashes-summary"]',
    );
    const queueTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-agent-summary"]',
    );

    expect(controls?.className).toContain("justify-end");
    expect(stashTrigger).not.toBeNull();
    expect(queueTrigger).not.toBeNull();

    await act(async () => {
      stashTrigger?.click();
    });
    expect(stashTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("false");
    const stashPopover = document.body.querySelector('[data-testid="chat-saved-message-popover"]');
    expect(stashPopover).not.toBeNull();
    expect(stashPopover?.className).toContain("w-[min(24rem,calc(100dvw-1rem))]");
    expect(stashPopover?.getAttribute("data-placement")).toContain("top");
    expect(stashPopover?.querySelector('[aria-label="Stashed drafts"][role="region"]')).not.toBeNull();
    expect(controls?.contains(stashPopover)).toBe(false);
    expect(document.querySelectorAll(`#${stashTrigger?.getAttribute("aria-controls")}`)).toHaveLength(1);
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("data-testid"),
      ),
    ).toEqual([
      "chat-message-stashes-summary",
      "chat-send-queue-agent-summary",
    ]);

    await act(async () => {
      queueTrigger?.click();
    });
    expect(stashTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("true");
    const queuePopover = document.body.querySelector('[data-testid="chat-saved-message-popover"]');
    expect(queuePopover?.querySelector('[aria-label="Stashed drafts"][role="region"]')).toBeNull();
    expect(queuePopover?.querySelector('[aria-label="Queued messages"][role="region"]')).not.toBeNull();
    expect(controls?.contains(queuePopover)).toBe(false);
    expect(document.querySelectorAll(`#${queueTrigger?.getAttribute("aria-controls")}`)).toHaveLength(1);
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("data-testid"),
      ),
    ).toEqual([
      "chat-message-stashes-summary",
      "chat-send-queue-agent-summary",
    ]);
  });

  it("closes the queue popover before showing the persistent edit strip", async () => {
    await act(async () => {
      root.render(<SavedMessagesHarness editOnRequest />);
    });

    const queueTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-agent-summary"]',
    );
    await act(async () => {
      queueTrigger?.click();
    });

    const editButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-steer"]',
    );
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.click();
    });

    expect(document.body.querySelector('[data-testid="chat-saved-message-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-queue-agent-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-stashes-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-queue"]')?.textContent).toContain(
      "Editing queued message",
    );
  });

  it("switches directly from the queue panel to the stash panel", async () => {
    await act(async () => {
      root.render(<SavedMessagesHarness />);
    });

    const stashTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-stashes-summary"]',
    );
    const queueTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-agent-summary"]',
    );

    await act(async () => {
      queueTrigger?.click();
    });
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      stashTrigger?.click();
    });
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(stashTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[aria-label="Queued messages"][role="region"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Stashed drafts"][role="region"]')).not.toBeNull();
  });

  it("closes the stash panel with Escape and returns focus to its trigger", async () => {
    await act(async () => {
      root.render(<SavedMessagesHarness />);
    });

    const stashTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-stashes-summary"]',
    );
    await act(async () => {
      stashTrigger?.click();
    });
    const restoreButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-message-stash-restore"]',
    );

    await act(async () => {
      restoreButton?.focus();
      restoreButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(stashTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[aria-label="Stashed drafts"][role="region"]')).toBeNull();
    expect(document.activeElement).toBe(stashTrigger);
  });

  it("uses the first Escape to cancel keyboard reordering and the second to close", async () => {
    const onQueueReorder = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="chat-send-queue-item"]'),
      );
      const row = this.matches('[data-testid="chat-send-queue-item"]')
        ? this
        : this.closest<HTMLElement>('[data-testid="chat-send-queue-item"]');
      const index = row ? Math.max(0, rows.indexOf(row)) : 0;
      return {
        x: 0,
        y: index * 48,
        top: index * 48,
        left: 0,
        right: 320,
        bottom: index * 48 + 40,
        width: 320,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });
    await act(async () => {
      root.render(<SavedMessagesHarness onQueueReorder={onQueueReorder} />);
    });
    const queueTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-agent-summary"]',
    );
    await act(async () => {
      queueTrigger?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const handles = document.body.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-send-queue-reorder"]',
    );
    const secondHandle = handles[1];
    const press = async (key: string, code: string) => {
      await act(async () => {
        secondHandle.dispatchEvent(
          new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    await act(async () => {
      secondHandle.focus();
    });
    await press("Enter", "Enter");
    await press("ArrowUp", "ArrowUp");
    await press("Escape", "Escape");

    expect(onQueueReorder).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="chat-saved-message-popover"]')).not.toBeNull();
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("true");

    await press("Escape", "Escape");
    expect(document.body.querySelector('[data-testid="chat-saved-message-popover"]')).toBeNull();
    expect(queueTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(queueTrigger);
  });

  it("closes an open queue panel when its final item drains", async () => {
    const onQueueExpandedChange = vi.fn();
    const focusComposer = vi.fn();
    const chatInputRef = { current: { focus: focusComposer } } as never;
    await act(async () => {
      root.render(
        <SavedMessagesHarness
          queueCount={1}
          stashCount={0}
          initialQueueExpanded
          onQueueExpandedChange={onQueueExpandedChange}
          chatInputRef={chatInputRef}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="chat-send-queue-agent-summary"]')?.getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    const queueAction = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-queue-steer"]',
    );
    await act(async () => {
      queueAction?.focus();
    });

    await act(async () => {
      root.render(
        <SavedMessagesHarness
          queueCount={0}
          stashCount={0}
          initialQueueExpanded
          onQueueExpandedChange={onQueueExpandedChange}
          chatInputRef={chatInputRef}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onQueueExpandedChange).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-testid="chat-send-queue-agent-summary"]')).toBeNull();
    expect(container.querySelector('[aria-label="Queued messages"][role="region"]')).toBeNull();
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it("uses the send slot for a typed draft even when secondary voice input is available", async () => {
    await act(async () => renderLayout({ chatInputProps: { value: "A useful draft" } as never }));
    expect(layoutNodes().voice).toBeNull();
    expect(layoutNodes().send).not.toBeNull();
  });

  it("keeps a short touch press as one ordinary Send", async () => {
    vi.useFakeTimers();
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
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    vi.spyOn(sendButton!, "getBoundingClientRect").mockReturnValue({
      ...touchSendAnchor,
      x: touchSendAnchor.left,
      y: touchSendAnchor.top,
      width: touchSendAnchor.right - touchSendAnchor.left,
      height: touchSendAnchor.bottom - touchSendAnchor.top,
      toJSON: () => ({}),
    } as DOMRect);

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown"));
      sendButton?.dispatchEvent(touchPointerEvent("pointerup"));
      sendButton?.click();
    });

    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="touch-send-mode-picker"]')).toBeNull();
  });

  it("opens touch send options without selecting or accidentally sending", async () => {
    vi.useFakeTimers();
    const onSendButtonPress = vi.fn();
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onSendButtonPress,
            showVoicePrimaryAction: false,
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
              queueDisabled: false,
              stashDisabled: false,
            } as never,
          })}
        />,
      );
    });
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    vi.spyOn(sendButton!, "getBoundingClientRect").mockReturnValue({
      ...touchSendAnchor,
      x: touchSendAnchor.left,
      y: touchSendAnchor.top,
      width: touchSendAnchor.right - touchSendAnchor.left,
      height: touchSendAnchor.bottom - touchSendAnchor.top,
      toJSON: () => ({}),
    } as DOMRect);

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown"));
      vi.advanceTimersByTime(TOUCH_SEND_MODE_HOLD_DELAY_MS);
    });
    expect(document.body.querySelector('[data-testid="touch-send-mode-picker"]')).not.toBeNull();
    expect(sendButton?.getAttribute("data-send-options-open")).toBe("true");

    await act(async () => {
      window.dispatchEvent(touchPointerEvent("pointerup"));
      // Some touch browsers synthesize a click after pointer-up. It belongs to
      // this held gesture and must not become an ordinary Send.
      sendButton?.click();
    });

    expect(onSendButtonPress).not.toHaveBeenCalled();
    expect(onQueueMessage).not.toHaveBeenCalled();
    expect(onStashDraft).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="touch-send-mode-picker"]')).toBeNull();
  });

  it.each([
    ["queue", "Queue"],
    ["stash", "Stash"],
  ] as const)("commits only the dragged %s action", async (mode, label) => {
    vi.useFakeTimers();
    const onSendButtonPress = vi.fn();
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onSendButtonPress,
            showVoicePrimaryAction: false,
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
              queueDisabled: false,
              stashDisabled: false,
            } as never,
          })}
        />,
      );
    });
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    vi.spyOn(sendButton!, "getBoundingClientRect").mockReturnValue({
      ...touchSendAnchor,
      x: touchSendAnchor.left,
      y: touchSendAnchor.top,
      width: touchSendAnchor.right - touchSendAnchor.left,
      height: touchSendAnchor.bottom - touchSendAnchor.top,
      toJSON: () => ({}),
    } as DOMRect);
    const target = touchSendTargetCenter(mode);

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown"));
      vi.advanceTimersByTime(TOUCH_SEND_MODE_HOLD_DELAY_MS);
      window.dispatchEvent(touchPointerEvent("pointermove", target));
    });
    expect(
      document.body.querySelector(`[data-mode="${mode}"]`)?.getAttribute("data-selected"),
    ).toBe("true");
    expect(document.body.textContent).toContain(`${label} selected. Release to use it.`);

    await act(async () => {
      window.dispatchEvent(touchPointerEvent("pointerup", target));
    });

    expect(onSendButtonPress).not.toHaveBeenCalled();
    expect(onQueueMessage).toHaveBeenCalledTimes(mode === "queue" ? 1 : 0);
    expect(onStashDraft).toHaveBeenCalledTimes(mode === "stash" ? 1 : 0);
  });

  it("uses the contextual Steer action when dragged to the primary target", async () => {
    vi.useFakeTimers();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onSendButtonPress,
            primaryActionMode: "steer",
            showVoicePrimaryAction: false,
            composerActionMenuProps: {
              onQueueMessage: vi.fn(),
              onStashDraft: vi.fn(),
            } as never,
          })}
        />,
      );
    });
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    vi.spyOn(sendButton!, "getBoundingClientRect").mockReturnValue({
      ...touchSendAnchor,
      x: touchSendAnchor.left,
      y: touchSendAnchor.top,
      width: touchSendAnchor.right - touchSendAnchor.left,
      height: touchSendAnchor.bottom - touchSendAnchor.top,
      toJSON: () => ({}),
    } as DOMRect);
    const target = touchSendTargetCenter("steer");

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown"));
      vi.advanceTimersByTime(TOUCH_SEND_MODE_HOLD_DELAY_MS);
    });
    expect(document.body.textContent).toContain(
      "Send options open. Slide to Steer, Queue, or Stash, then release.",
    );

    await act(async () => {
      window.dispatchEvent(touchPointerEvent("pointermove", target));
      window.dispatchEvent(touchPointerEvent("pointerup", target));
    });

    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a new tap after a held option finishes", async () => {
    vi.useFakeTimers();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            onSendButtonPress,
            showVoicePrimaryAction: false,
            composerActionMenuProps: {
              onQueueMessage: vi.fn(),
              onStashDraft: vi.fn(),
            } as never,
          })}
        />,
      );
    });
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    vi.spyOn(sendButton!, "getBoundingClientRect").mockReturnValue({
      ...touchSendAnchor,
      x: touchSendAnchor.left,
      y: touchSendAnchor.top,
      width: touchSendAnchor.right - touchSendAnchor.left,
      height: touchSendAnchor.bottom - touchSendAnchor.top,
      toJSON: () => ({}),
    } as DOMRect);

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown"));
      vi.advanceTimersByTime(TOUCH_SEND_MODE_HOLD_DELAY_MS);
      window.dispatchEvent(touchPointerEvent("pointerup"));
      vi.runOnlyPendingTimers();
    });

    await act(async () => {
      sendButton?.dispatchEvent(touchPointerEvent("pointerdown", { pointerId: 18 }));
      sendButton?.dispatchEvent(touchPointerEvent("pointerup", { pointerId: 18 }));
      sendButton?.click();
    });

    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
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
    expect(sendButton?.className).not.toContain("!w-auto");
    expect(container.querySelector('[data-testid="chat-steer-action-label"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-send-action-icon"]')).not.toBeNull();
    expect(actionStatus?.textContent).toBe("Enter steers the current reply.");

    await act(async () => renderSurface("send"));

    expect(container.querySelector('[data-testid="chat-steer-action-label"]')).toBeNull();
    expect(actionStatus?.textContent).toBe("Enter sends the message.");
  });

  it("previews Queue and Stash from desktop modifiers, then restores Steer on release", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "A useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage: vi.fn(),
              onStashDraft: vi.fn(),
            } as never,
            primaryActionMode: "steer",
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    input?.setAttribute("tabindex", "0");
    await act(async () => input?.focus());

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });

    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    expect(sendButton?.getAttribute("data-send-modifier-preview")).toBe("queue");
    expect(sendButton?.getAttribute("aria-label")).toBe(
      "Queue message (Command or Ctrl plus Enter)",
    );
    expect(container.querySelector('[data-testid="chat-queue-action-icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-send-action-icon"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-primary-action-status"]')?.textContent).toBe(
      "Queue selected. Press Enter or click to queue the message.",
    );

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Shift",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(sendButton?.getAttribute("data-send-mode")).toBe("stash");
    expect(sendButton?.getAttribute("data-send-modifier-preview")).toBe("stash");
    expect(sendButton?.getAttribute("aria-label")).toBe(
      "Stash draft (Command or Ctrl plus Shift plus Enter)",
    );
    expect(container.querySelector('[data-testid="chat-stash-action-icon"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Shift",
          metaKey: true,
          shiftKey: false,
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");
    expect(sendButton?.hasAttribute("data-send-modifier-preview")).toBe(false);
    expect(sendButton?.getAttribute("aria-label")).toBe("Steer current reply (Enter)");
    expect(container.querySelector('[data-testid="chat-send-action-icon"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "AltGraph",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");

    const composerMenu = document.createElement("div");
    composerMenu.dataset.testid = "chat-slash-command-menu";
    document.body.appendChild(composerMenu);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");
    composerMenu.remove();

    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
      outsideButton.focus();
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");
    outsideButton.remove();

    await act(async () => input?.focus());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("steer");
    visibilityState.mockRestore();
  });

  it("previews held modifiers even when the editor stops keyboard-event bubbling", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "A useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage: vi.fn(),
              onStashDraft: vi.fn(),
            } as never,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    input?.setAttribute("tabindex", "0");
    await act(async () => input?.focus());
    const stopBubbling = (event: KeyboardEvent) => event.stopPropagation();
    input?.addEventListener("keydown", stopBubbling);
    input?.addEventListener("keyup", stopBubbling);

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Meta",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    expect(container.querySelector('[data-testid="chat-queue-action-icon"]')).not.toBeNull();

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Meta",
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");

    input?.removeEventListener("keydown", stopBubbling);
    input?.removeEventListener("keyup", stopBubbling);
  });

  it("performs the previewed Queue or Stash action on modifier-click", async () => {
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "A useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
            } as never,
            onSendButtonPress,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    await act(async () => sendButton?.focus());

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(onQueueMessage).toHaveBeenCalledTimes(1);
    expect(onStashDraft).not.toHaveBeenCalled();
    expect(onSendButtonPress).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
      );
    });
    expect(onQueueMessage).toHaveBeenCalledTimes(2);
    expect(onSendButtonPress).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Shift",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("stash");
    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(onStashDraft).toHaveBeenCalledTimes(1);
    expect(onSendButtonPress).not.toHaveBeenCalled();
  });

  it("does not perform an alternate action unless that mode is visibly previewed", async () => {
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "A useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
            } as never,
            onSendButtonPress,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    input?.setAttribute("tabindex", "0");
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    await act(async () => outsideButton.focus());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");
    expect(onQueueMessage).not.toHaveBeenCalled();
    expect(onStashDraft).not.toHaveBeenCalled();
    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
    outsideButton.remove();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
      input?.focus();
    });
    const composerMenu = document.createElement("div");
    composerMenu.dataset.testid = "assistant-mention-menu";
    document.body.appendChild(composerMenu);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");
    expect(onQueueMessage).not.toHaveBeenCalled();
    expect(onStashDraft).not.toHaveBeenCalled();
    expect(onSendButtonPress).toHaveBeenCalledTimes(2);
    composerMenu.remove();
  });

  it("previews and performs Queue or Stash when ordinary Send is unavailable", async () => {
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "Save this useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
            } as never,
            onSendButtonPress,
            sendButtonDisabled: true,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const input = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    input?.setAttribute("tabindex", "0");
    await act(async () => input?.focus());
    expect(sendButton?.disabled).toBe(true);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("queue");
    expect(sendButton?.disabled).toBe(false);
    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(onQueueMessage).toHaveBeenCalledTimes(1);
    expect(onSendButtonPress).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Shift",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("stash");
    expect(sendButton?.disabled).toBe(false);
    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          metaKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(onStashDraft).toHaveBeenCalledTimes(1);
    expect(onSendButtonPress).not.toHaveBeenCalled();
  });

  it("does not preview or execute unavailable modifier actions", async () => {
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    const onSendButtonPress = vi.fn();
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            chatInputProps: {
              ...createProps().chatInputProps,
              value: "A useful draft",
            },
            composerActionMenuProps: {
              onQueueMessage,
              onStashDraft,
              queueDisabled: true,
              stashDisabled: true,
            } as never,
            onSendButtonPress,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    await act(async () => sendButton?.focus());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });
    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");

    await act(async () => {
      sendButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(onQueueMessage).not.toHaveBeenCalled();
    expect(onStashDraft).not.toHaveBeenCalled();
    expect(onSendButtonPress).toHaveBeenCalledTimes(1);
  });

  it("does not preview a modifier action without a usable draft", async () => {
    await act(async () => {
      root.render(
        <ChatComposerSurface
          {...createProps({
            composerActionMenuProps: {
              onQueueMessage: vi.fn(),
              onStashDraft: vi.fn(),
            } as never,
            showVoicePrimaryAction: false,
          })}
        />,
      );
    });

    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send-button"]',
    );
    await act(async () => sendButton?.focus());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
    });

    expect(sendButton?.getAttribute("data-send-mode")).toBe("send");
    expect(sendButton?.hasAttribute("data-send-modifier-preview")).toBe(false);
  });
});
